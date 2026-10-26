// `claudecommander daemon run` and `daemon status`, driven through runDaemonCli
// with a fake backend connection, a fake clock and test/fakeClaude.mjs.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setUpFakeClaude, FAKE_CLAUDE_EXECUTABLE, type FakeClaude } from '../test/fakeClaudeHarness.js';
import { MachineRevokedError, type BackendConnection, type ConnectToBackendOptions, type InboxNotice, type PublishedSession } from './backendConnection.js';
import { createClaudeCommandRunner, type BackgroundSessionEntry } from './claudeCli.js';
import { runDaemonCli, type DaemonCliDependencies } from './cli.js';
import { acquireDaemonLock } from './daemonLock.js';
import { ORCHESTRATOR_CHECK_INTERVAL_MILLISECONDS, ORCHESTRATOR_WARMUP_MILLISECONDS } from './daemonLoop.js';
import { publishedSessionsFromListing } from './daemonRun.js';
import { EMULATOR_FIREBASE_WEB_CONFIG } from './firebaseWebConfig.js';
import type { MachineCredential } from './machineCredential.js';
import { writeMachineCredential } from './machineCredential.js';
import { resolveDaemonPaths, type DaemonPaths } from './paths.js';

const MACHINE_ID = 'machine_b';
const BACKEND_URL = 'https://backend.example';
const PRODUCTION_WEB_CONFIG = { apiKey: 'real-looking-key', projectId: 'claudecommander-test', authDomain: 'claudecommander-test.firebaseapp.com' };

let temporaryHome: string;
let paths: DaemonPaths;
let fakeClaude: FakeClaude | undefined;

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), 'claudecommander-daemon-run-test-'));
  paths = resolveDaemonPaths(temporaryHome, {});
  mkdirSync(paths.configDirectory, { recursive: true });
  writeFileSync(paths.orchestratorSettingsFile, JSON.stringify({ sessionName: 'orchestrator', projectsRoot: temporaryHome, model: 'sonnet' }));
});

afterEach(() => {
  fakeClaude?.removeTemporaryFiles();
  fakeClaude = undefined;
  rmSync(temporaryHome, { recursive: true, force: true });
});

async function writeCredential(): Promise<void> {
  await writeMachineCredential(paths, { backendUrl: BACKEND_URL, machineId: MACHINE_ID, machineSecret: `${MACHINE_ID}.secret-value` });
}

// ---- a fake world for one `daemon run` ----

interface FakeConnection extends BackendConnection {
  closed: boolean;
  deliver: (messageIds: string[]) => void;
  revoke: () => void;
  listenerIsSubscribed: () => boolean;
  markedRung: string[];
  publishedSessions: PublishedSession[][];
}

function createFakeConnection(): FakeConnection {
  let onNotices: ((notices: InboxNotice[]) => void) | null = null;
  let revoke: (error: MachineRevokedError) => void = () => undefined;
  const revocation = new Promise<MachineRevokedError>((resolve) => { revoke = resolve; });
  let createdAt = 1;
  const connection: FakeConnection = {
    closed: false,
    markedRung: [],
    publishedSessions: [],
    listenForUnrungNotices(listener) {
      onNotices = listener;
      return () => { onNotices = null; };
    },
    async markNoticeRung(messageId) { connection.markedRung.push(messageId); },
    async publishSessions(sessions) { connection.publishedSessions.push(sessions); },
    async sendHeartbeat() {},
    whenMachineRevoked: () => revocation,
    async close() { connection.closed = true; },
    deliver(messageIds) { onNotices?.(messageIds.map((messageId) => ({ messageId, kind: 'message', createdAt: createdAt++ }))); },
    revoke() { revoke(new MachineRevokedError()); },
    listenerIsSubscribed: () => onNotices !== null,
  };
  return connection;
}

interface FakeRunWorld {
  dependencies: DaemonCliDependencies;
  loggedLines: string[];
  standardErrorText: () => string;
  standardOutputText: () => string;
  connectCalls: Array<{ credential: MachineCredential; options: ConnectToBackendOptions }>;
  connections: FakeConnection[];
  fetchCalls: string[];
  advanceFakeTime: (milliseconds: number) => Promise<void>;
  tick: () => Promise<void>;
  sendSigterm: () => void;
}

function createFakeRunWorld(options: { connectAnswers?: Array<() => Promise<FakeConnection>> } = {}): FakeRunWorld {
  const loggedLines: string[] = [];
  let standardOutputText = '';
  let standardErrorText = '';
  const connectCalls: FakeRunWorld['connectCalls'] = [];
  const connections: FakeConnection[] = [];
  const fetchCalls: string[] = [];
  let now = 1_700_000_000_000;
  const sleepers: Array<{ wakeAt: number; wake: () => void }> = [];
  const scheduledTasks: Array<{ intervalMilliseconds: number; task: () => Promise<void>; cancelled: boolean }> = [];
  let sendStopSignal: () => void = () => undefined;
  const stopSignal = new Promise<void>((resolve) => { sendStopSignal = resolve; });
  const connectAnswers = [...(options.connectAnswers ?? [])];

  const fetchFunction = (async (url: string) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify(PRODUCTION_WEB_CONFIG), { status: 200 });
  }) as unknown as typeof fetch;

  const dependencies: DaemonCliDependencies = {
    writeStandardOutput: (text) => { standardOutputText += text; },
    writeStandardError: (text) => { standardErrorText += text; },
    daemonPaths: paths,
    fetchFunction,
    sleep: (milliseconds) => new Promise<void>((resolve) => { sleepers.push({ wakeAt: now + milliseconds, wake: resolve }); }),
    daemonRunEnvironment: {
      connectToBackend: async (credential, connectOptions) => {
        connectCalls.push({ credential, options: connectOptions });
        const answer = connectAnswers.shift();
        const connection = answer ? await answer() : createFakeConnection();
        connections.push(connection);
        return connection;
      },
      claudeCommandRunner: createClaudeCommandRunner(FAKE_CLAUDE_EXECUTABLE),
      isProcessAlive: (pid) => pid === 4242,
      clock: () => now,
      scheduleEvery: (intervalMilliseconds, task) => {
        const scheduled = { intervalMilliseconds, task, cancelled: false };
        scheduledTasks.push(scheduled);
        return () => { scheduled.cancelled = true; };
      },
      log: (line) => loggedLines.push(line),
      waitForStopSignal: () => stopSignal,
    },
  };

  // Real file reads and child processes need real time to finish.
  const letRealWorkFinish = () => new Promise((resolve) => setTimeout(resolve, 30));

  return {
    dependencies,
    loggedLines,
    standardErrorText: () => standardErrorText,
    standardOutputText: () => standardOutputText,
    connectCalls,
    connections,
    fetchCalls,
    async advanceFakeTime(milliseconds) {
      const target = now + milliseconds;
      await letRealWorkFinish();
      while (now < target) {
        now = Math.min(target, now + 1_000);
        for (const sleeper of sleepers.filter((candidate) => candidate.wakeAt <= now)) {
          sleepers.splice(sleepers.indexOf(sleeper), 1);
          sleeper.wake();
        }
        await letRealWorkFinish();
      }
    },
    async tick() {
      for (const scheduled of scheduledTasks) {
        if (!scheduled.cancelled && scheduled.intervalMilliseconds === ORCHESTRATOR_CHECK_INTERVAL_MILLISECONDS) await scheduled.task();
      }
    },
    sendSigterm: () => sendStopSignal(),
  };
}

const LIVE_ORCHESTRATOR_ROW = {
  id: 'abcd1234',
  sessionId: '11111111-2222-3333-4444-555555555555',
  name: 'orchestrator',
  kind: 'background',
  pid: 4242,
  status: 'idle',
  state: 'done',
  cwd: '/home/owner/projects',
};

// ---- waiting for pairing ----

test('daemon run without machine.json waits for the credential instead of exiting non-zero', async () => {
  fakeClaude = setUpFakeClaude({ sessions: [LIVE_ORCHESTRATOR_ROW] });
  const world = createFakeRunWorld();
  const runPromise = runDaemonCli(['daemon', 'run'], world.dependencies);
  await world.advanceFakeTime(15_000);
  expect(world.loggedLines).toEqual(['not paired yet; waiting for claudecommander daemon pair']);
  expect(world.connectCalls).toHaveLength(0);

  await writeCredential();
  await world.advanceFakeTime(5_000);
  await vi.waitFor(() => expect(world.connectCalls).toHaveLength(1));

  world.sendSigterm();
  expect(await runPromise).toBe(0);
});

test('daemon run without machine.json stops cleanly on SIGTERM while it waits', async () => {
  const world = createFakeRunWorld();
  const runPromise = runDaemonCli(['daemon', 'run'], world.dependencies);
  await world.advanceFakeTime(5_000);
  world.sendSigterm();
  expect(await runPromise).toBe(0);
  expect(world.connectCalls).toHaveLength(0);
});

// ---- one daemon per machine ----

test('a second daemon run on the same machine exits while the first holds the lock', async () => {
  const firstDaemonsLock = await acquireDaemonLock(paths.daemonLockFile);
  try {
    const world = createFakeRunWorld();
    expect(await runDaemonCli(['daemon', 'run'], world.dependencies)).toBe(1);
    expect(world.standardErrorText()).toContain(`another claudecommander daemon is already running on this machine (${paths.daemonLockFile})`);
    expect(world.connectCalls).toHaveLength(0);
  } finally {
    await firstDaemonsLock!.release();
  }
});

test('a daemon run releases the lock when it stops', async () => {
  await writeCredential();
  fakeClaude = setUpFakeClaude({ sessions: [LIVE_ORCHESTRATOR_ROW] });
  const world = createFakeRunWorld();
  const runPromise = runDaemonCli(['daemon', 'run'], world.dependencies);
  await vi.waitFor(() => expect(world.connectCalls).toHaveLength(1));
  expect(await acquireDaemonLock(paths.daemonLockFile)).toBeNull();
  world.sendSigterm();
  expect(await runPromise).toBe(0);
  const lockAfterStop = await acquireDaemonLock(paths.daemonLockFile);
  expect(lockAfterStop).not.toBeNull();
  await lockAfterStop!.release();
});

// ---- connecting ----

test('daemon run fetches the Firebase web config from the paired backend and connects with it', async () => {
  await writeCredential();
  fakeClaude = setUpFakeClaude({ sessions: [LIVE_ORCHESTRATOR_ROW] });
  const world = createFakeRunWorld();
  const runPromise = runDaemonCli(['daemon', 'run'], world.dependencies);
  await vi.waitFor(() => expect(world.connectCalls).toHaveLength(1));
  expect(world.fetchCalls).toEqual([`${BACKEND_URL}/__/firebase/init.json`]);
  expect(world.connectCalls[0]!.credential.machineId).toBe(MACHINE_ID);
  expect(world.connectCalls[0]!.options.firebaseConfig).toEqual(PRODUCTION_WEB_CONFIG);
  expect(world.connectCalls[0]!.options.useEmulators).toBeUndefined();
  await vi.waitFor(() => expect(world.connections[0]!.listenerIsSubscribed()).toBe(true));

  world.sendSigterm();
  expect(await runPromise).toBe(0);
  expect(world.connections[0]!.closed).toBe(true);
  expect(world.connections[0]!.listenerIsSubscribed()).toBe(false);
});

test('daemon run --emulators uses the emulator web config and hosts and fetches nothing', async () => {
  await writeCredential();
  fakeClaude = setUpFakeClaude({ sessions: [LIVE_ORCHESTRATOR_ROW] });
  const world = createFakeRunWorld();
  const runPromise = runDaemonCli(['daemon', 'run', '--emulators'], world.dependencies);
  await vi.waitFor(() => expect(world.connectCalls).toHaveLength(1));
  expect(world.fetchCalls).toEqual([]);
  expect(world.connectCalls[0]!.options.firebaseConfig).toEqual(EMULATOR_FIREBASE_WEB_CONFIG);
  expect(world.connectCalls[0]!.options.useEmulators).toEqual({ auth: 'http://127.0.0.1:9199', firestore: '127.0.0.1:8199' });
  world.sendSigterm();
  expect(await runPromise).toBe(0);
});

test('daemon run with an unknown option prints usage and exits 2', async () => {
  const world = createFakeRunWorld();
  expect(await runDaemonCli(['daemon', 'run', '--frobnicate'], world.dependencies)).toBe(2);
  expect(world.standardErrorText()).toMatch(/usage: claudecommander daemon run \[--emulators\]/);
});

test('a connection that fails for a passing reason is tried again after a pause', async () => {
  await writeCredential();
  fakeClaude = setUpFakeClaude({ sessions: [LIVE_ORCHESTRATOR_ROW] });
  const world = createFakeRunWorld({ connectAnswers: [async () => { throw new Error('could not reach https://backend.example/daemon/token'); }] });
  const runPromise = runDaemonCli(['daemon', 'run'], world.dependencies);
  await vi.waitFor(() => expect(world.connectCalls).toHaveLength(1));
  expect(world.loggedLines.some((line) => line.includes('could not reach'))).toBe(true);
  await world.advanceFakeTime(5_000);
  await vi.waitFor(() => expect(world.connectCalls).toHaveLength(2));
  world.sendSigterm();
  expect(await runPromise).toBe(0);
});

test('a machine revoked before it could connect exits 0 and records the revocation in the status file', async () => {
  await writeCredential();
  const world = createFakeRunWorld({ connectAnswers: [async () => { throw new MachineRevokedError(); }] });
  expect(await runDaemonCli(['daemon', 'run'], world.dependencies)).toBe(0);
  expect(world.loggedLines.some((line) => line.includes('machine revoked'))).toBe(true);
  expect(JSON.parse(readFileSync(paths.daemonStatusFile, 'utf8'))).toEqual(
    expect.objectContaining({ machine_id: MACHINE_ID, backend_url: BACKEND_URL, machine_revoked: true, loop_running: false }),
  );
});

test('a machine revoked while running stops the loop, closes the connection and exits 0', async () => {
  await writeCredential();
  fakeClaude = setUpFakeClaude({ sessions: [LIVE_ORCHESTRATOR_ROW] });
  const world = createFakeRunWorld();
  const runPromise = runDaemonCli(['daemon', 'run'], world.dependencies);
  await vi.waitFor(() => expect(world.connections).toHaveLength(1));
  world.connections[0]!.revoke();
  expect(await runPromise).toBe(0);
  expect(world.connections[0]!.closed).toBe(true);
  expect(JSON.parse(readFileSync(paths.daemonStatusFile, 'utf8')).machine_revoked).toBe(true);
});

// ---- the wiring, end to end with the fake claude ----

test('a delivered notice is rung through the fake claude once the orchestrator has warmed up, then marked rung', async () => {
  await writeCredential();
  fakeClaude = setUpFakeClaude({
    sessions: [LIVE_ORCHESTRATOR_ROW],
    oneShot: {
      streamLines: [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'SendMessage', input: { to: 'orchestrator', message: 'x' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify({ success: true }) }] } },
      ],
    },
  });
  const world = createFakeRunWorld();
  const runPromise = runDaemonCli(['daemon', 'run'], world.dependencies);
  await vi.waitFor(() => expect(world.connections[0]?.listenerIsSubscribed()).toBe(true));
  // The first tick sees the orchestrator's pid for the first time.
  await vi.waitFor(() => expect(world.connections[0]!.publishedSessions.length).toBeGreaterThan(0));
  await world.advanceFakeTime(ORCHESTRATOR_WARMUP_MILLISECONDS);

  world.connections[0]!.deliver(['m_1']);
  await vi.waitFor(() => expect(world.connections[0]!.markedRung).toEqual(['m_1']), { timeout: 10_000 });
  const oneShotCalls = fakeClaude.allCalls().filter((call) => call[0] === '-p');
  expect(oneShotCalls).toHaveLength(1);
  expect(oneShotCalls[0]!.at(-1)).toContain('m_1');
  expect(JSON.parse(readFileSync(paths.rungMessageIdsFile, 'utf8')).rung_message_ids).toEqual(['m_1']);
  expect(world.connections[0]!.publishedSessions.at(-1)).toContainEqual(expect.objectContaining({ sessionName: 'orchestrator', role: 'orchestrator', state: 'running' }));

  world.sendSigterm();
  expect(await runPromise).toBe(0);
}, 20_000);

// ---- the session listing ----

test('the local session list marks the background orchestrator and calls dead or pid-less rows stopped', () => {
  const rows: BackgroundSessionEntry[] = [
    { id: 'a', sessionId: 's-a', name: 'orchestrator', kind: 'background', pid: 4242, status: 'idle', waitingFor: null, state: 'done', workingDirectory: '/home/o/projects' },
    { id: 'b', sessionId: 's-b', name: 'api', kind: 'interactive', pid: 5000, status: 'busy', waitingFor: null, state: 'working', workingDirectory: '/home/o/projects/api' },
    { id: 'c', sessionId: 's-c', name: 'old-work', kind: 'background', pid: null, status: null, waitingFor: null, state: 'done', workingDirectory: '/home/o/projects/old' },
    { id: 'd', sessionId: 's-d', name: 'crashed', kind: 'background', pid: 6000, status: 'idle', waitingFor: null, state: 'done', workingDirectory: '/home/o/projects/x' },
    { id: 'e', sessionId: 's-e', name: 'asks', kind: 'background', pid: 5000, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked', workingDirectory: '/home/o/projects/y' },
  ];
  const isProcessAlive = (pid: number) => pid === 4242 || pid === 5000;
  expect(publishedSessionsFromListing(rows, 'orchestrator', isProcessAlive)).toEqual([
    { sessionName: 'orchestrator', projectName: '/home/o/projects', state: 'done', role: 'orchestrator' },
    { sessionName: 'api', projectName: '/home/o/projects/api', state: 'working', role: 'session' },
    { sessionName: 'old-work', projectName: '/home/o/projects/old', state: 'stopped', role: 'session' },
    { sessionName: 'crashed', projectName: '/home/o/projects/x', state: 'stopped', role: 'session' },
    { sessionName: 'asks', projectName: '/home/o/projects/y', state: 'waiting_for_owner', role: 'session' },
  ]);
});

test('an interactive session with the orchestrator name is a work session, not the orchestrator', () => {
  const rows: BackgroundSessionEntry[] = [
    { id: 'a', sessionId: 's-a', name: 'orchestrator', kind: 'interactive', pid: 4242, status: 'idle', waitingFor: null, state: 'done', workingDirectory: '/p' },
  ];
  expect(publishedSessionsFromListing(rows, 'orchestrator', () => true)[0]!.role).toBe('session');
});

// ---- daemon status ----

test('daemon status prints machine id, backend URL, orchestrator state and last ring result from the status file', async () => {
  mkdirSync(paths.stateDirectory, { recursive: true });
  writeFileSync(
    paths.daemonStatusFile,
    JSON.stringify({
      updated_at: 1_700_000_000_000,
      machine_id: MACHINE_ID,
      backend_url: BACKEND_URL,
      loop_running: true,
      orchestrator_state: 'running',
      orchestrator_error: null,
      last_ring_outcome: { at: 1_700_000_000_000, kind: 'failed', reason: 'claude -p exited 0 without a successful SendMessage to orchestrator' },
      ledger_error: null,
      machine_revoked: false,
      pending_notice_count: 2,
    }),
  );
  const world = createFakeRunWorld();
  expect(await runDaemonCli(['daemon', 'status'], world.dependencies)).toBe(0);
  const printed = world.standardOutputText();
  expect(printed).toContain(`machine id: ${MACHINE_ID}`);
  expect(printed).toContain(`backend: ${BACKEND_URL}`);
  expect(printed).toContain('loop running: yes');
  expect(printed).toContain('orchestrator: running');
  expect(printed).toContain('last ring: failed at 2023-11-14T22:13:20.000Z (claude -p exited 0 without a successful SendMessage to orchestrator)');
  expect(printed).toContain('pending notices: 2');
  expect(printed).toContain('updated: 2023-11-14T22:13:20.000Z');
  expect(printed).not.toContain('ledger');
});

test('daemon status shows a ledger error and a revoked machine prominently', async () => {
  mkdirSync(paths.stateDirectory, { recursive: true });
  writeFileSync(
    paths.daemonStatusFile,
    JSON.stringify({
      updated_at: 1_700_000_000_000, machine_id: MACHINE_ID, backend_url: BACKEND_URL, loop_running: false, orchestrator_state: null,
      orchestrator_error: null, last_ring_outcome: null, ledger_error: 'the doorbell ledger /x/rung.json is not readable; fix or remove it',
      machine_revoked: true, pending_notice_count: 0,
    }),
  );
  const world = createFakeRunWorld();
  expect(await runDaemonCli(['daemon', 'status'], world.dependencies)).toBe(0);
  expect(world.standardOutputText()).toContain('ledger error: the doorbell ledger /x/rung.json is not readable; fix or remove it');
  expect(world.standardOutputText()).toContain('machine revoked: yes');
  expect(world.standardOutputText()).toContain('last ring: none yet');
});

test('daemon status with an argument prints usage and exits 2', async () => {
  const world = createFakeRunWorld();
  expect(await runDaemonCli(['daemon', 'status', '--verbose'], world.dependencies)).toBe(2);
  expect(world.standardErrorText()).toContain('usage: claudecommander daemon status');
});

test('daemon status without a status file says the daemon has not written one and exits 1', async () => {
  const world = createFakeRunWorld();
  expect(await runDaemonCli(['daemon', 'status'], world.dependencies)).toBe(1);
  expect(world.standardErrorText()).toContain(`no daemon status yet (${paths.daemonStatusFile})`);
});

// ---- the built bundle ----

// main.ts now reaches the daemon loop and the firebase-backed connection, so
// the committed dist/cli.js must run `daemon run` on its own. Unpaired, it
// only waits, so this needs no backend and never runs claude.
test('the built daemon run waits while unpaired and exits 0 on SIGTERM', async () => {
  const builtCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const daemon = spawn(process.execPath, [builtCli, 'daemon', 'run'], {
    env: { PATH: process.env.PATH, HOME: temporaryHome, NODE_PATH: '', NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let standardErrorText = '';
  daemon.stderr.setEncoding('utf8');
  daemon.stderr.on('data', (text: string) => { standardErrorText += text; });
  const exitCode = new Promise<number | null>((resolve) => daemon.once('exit', (code) => resolve(code)));
  try {
    await vi.waitFor(() => expect(standardErrorText).toContain('not paired yet; waiting for claudecommander daemon pair'), { timeout: 10_000 });
  } finally {
    daemon.kill('SIGTERM');
  }
  expect(await exitCode).toBe(0);
  expect(readFileSync(paths.logFile, 'utf8')).toContain('not paired yet; waiting for claudecommander daemon pair');
}, 20_000);
