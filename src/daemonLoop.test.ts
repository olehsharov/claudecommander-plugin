// The daemon loop wires the inbox listener, the orchestrator keeper, the
// doorbell, the rung ledger and session publishing together. Every outside
// part is a fake here; the ledger is the real rung.json where a test is about
// what survives a restart.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { BackendConnection, InboxNotice, PublishedSession } from './backendConnection.js';
import { HEARTBEAT_INTERVAL_MILLISECONDS, MachineRevokedError } from './backendConnection.js';
import type { BackgroundSessionEntry } from './claudeCli.js';
import { ORCHESTRATOR_CHECK_INTERVAL_MILLISECONDS, ORCHESTRATOR_WARMUP_MILLISECONDS, startDaemonLoop, writeDaemonStatusFile, type DaemonLoopDependencies, type DaemonStatus } from './daemonLoop.js';
import { openRungMessageLedger, type DoorbellOutcome, type OrchestratorDoorbell, type RungMessageLedger } from './doorbell.js';
import type { OrchestratorState } from './orchestratorKeeper.js';

const ORCHESTRATOR_NAME = 'orchestrator';
const MACHINE_ID = 'machine_b';
const BACKEND_URL = 'https://backend.example';

const temporaryDirectories: string[] = [];
const loopsToStop: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  for (const loop of loopsToStop.splice(0)) await loop.stop();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claudecommander-daemon-loop-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

// Lets every pending promise callback and small file write run.
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function firestoreError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function orchestratorEntry(pid: number | null, overrides: Partial<BackgroundSessionEntry> = {}): BackgroundSessionEntry {
  return {
    id: 'abcd1234',
    sessionId: '11111111-2222-3333-4444-555555555555',
    name: ORCHESTRATOR_NAME,
    kind: 'background',
    pid,
    status: 'idle',
    waitingFor: null,
    state: 'done',
    workingDirectory: '/home/owner/projects',
    ...overrides,
  };
}

// ---- the fake world one loop runs in ----

interface FakeWorld {
  dependencies: DaemonLoopDependencies;
  callLog: string[];
  logLines: string[];
  ringCalls: string[][];
  markedRung: string[];
  publishedSessions: PublishedSession[][];
  heartbeatCount: () => number;
  keeperCallCount: () => number;
  listenerIsSubscribed: () => boolean;
  deliverNotices: (messageIds: string[], createdAts?: number[]) => void;
  deliverMalformedNotice: (messageId: string) => void;
  keeperAnswers: (kind: OrchestratorState['kind'], options?: { pid?: number }) => void;
  keeperAnswersWith: (answer: () => Promise<OrchestratorState>) => void;
  ringAnswersWith: (answer: (messageIds: string[]) => Promise<DoorbellOutcome>) => void;
  markAnswersWith: (answer: (messageId: string) => Promise<void>) => void;
  heartbeatAnswersWith: (answer: () => Promise<void>) => void;
  localSessionsAre: (sessions: PublishedSession[]) => void;
  revokeMachine: () => void;
  advanceClock: (milliseconds: number) => void;
  tick: () => Promise<void>;
  heartbeatTick: () => Promise<void>;
  readStatus: () => DaemonStatus;
  ledgerRecorded: () => string[];
  // One-shot timers the loop asked for, still waiting (not fired, not cancelled).
  waitingOneShotTimers: () => Array<{ delayMilliseconds: number }>;
  fireOneShotTimers: () => Promise<void>;
}

function createFakeWorld(options: { ledger?: RungMessageLedger; alreadyRung?: string[] } = {}): FakeWorld {
  const callLog: string[] = [];
  const logLines: string[] = [];
  const ringCalls: string[][] = [];
  const markedRung: string[] = [];
  const publishedSessions: PublishedSession[][] = [];
  let heartbeats = 0;
  let keeperCalls = 0;
  let now = 1_700_000_000_000;
  let nextCreatedAt = 1;

  let deliverToListener: ((notices: InboxNotice[]) => void) | null = null;
  let deliverMalformedToListener: ((messageId: string) => void) | undefined;
  let keeperAnswer: () => Promise<OrchestratorState> = async () => ({ kind: 'running', entry: orchestratorEntry(100) });
  let ringAnswer: (messageIds: string[]) => Promise<DoorbellOutcome> = async () => ({ kind: 'rung' });
  let markAnswer: (messageId: string) => Promise<void> = async () => undefined;
  let heartbeatAnswer: () => Promise<void> = async () => undefined;
  let localSessions: PublishedSession[] = [{ sessionName: ORCHESTRATOR_NAME, projectName: 'projects', state: 'done', role: 'orchestrator' }];
  let revoke: (error: MachineRevokedError) => void = () => undefined;
  const revocation = new Promise<MachineRevokedError>((resolve) => { revoke = resolve; });

  const connection: BackendConnection = {
    listenForUnrungNotices(onNotices, onMalformedNotice) {
      deliverToListener = onNotices;
      deliverMalformedToListener = onMalformedNotice;
      return () => {
        deliverToListener = null;
        deliverMalformedToListener = undefined;
      };
    },
    async markNoticeRung(messageId) {
      callLog.push(`mark:${messageId}`);
      await markAnswer(messageId);
      markedRung.push(messageId);
    },
    async publishSessions(sessions) {
      publishedSessions.push(sessions);
    },
    async sendHeartbeat() {
      heartbeats += 1;
      await heartbeatAnswer();
    },
    whenMachineRevoked: () => revocation,
    async close() {},
  };

  const rungInMemory = new Set(options.alreadyRung ?? []);
  const inMemoryLedger: RungMessageLedger = {
    async hasBeenRung(messageId) {
      return rungInMemory.has(messageId);
    },
    async recordRung(messageIds) {
      callLog.push(`record:${messageIds.join(',')}`);
      for (const messageId of messageIds) rungInMemory.add(messageId);
    },
  };

  const doorbell: OrchestratorDoorbell = {
    async ringOrchestratorDoorbell(messageIds) {
      callLog.push(`ring:${messageIds.join(',')}`);
      ringCalls.push([...messageIds]);
      return ringAnswer(messageIds);
    },
  };

  const scheduledTasks: Array<{ intervalMilliseconds: number; task: () => Promise<void>; cancelled: boolean }> = [];
  const oneShotTimers: Array<{ delayMilliseconds: number; task: () => void; finished: boolean }> = [];
  const statusDirectory = makeTemporaryDirectory();
  const daemonStatusFile = join(statusDirectory, 'status.json');

  const dependencies: DaemonLoopDependencies = {
    connection,
    keepOrchestratorRunning: async () => {
      keeperCalls += 1;
      return keeperAnswer();
    },
    doorbell,
    ledger: options.ledger ?? inMemoryLedger,
    listLocalSessions: async () => localSessions,
    log: (line) => logLines.push(line),
    clock: () => now,
    scheduleEvery: (intervalMilliseconds, task) => {
      const scheduled = { intervalMilliseconds, task, cancelled: false };
      scheduledTasks.push(scheduled);
      return () => { scheduled.cancelled = true; };
    },
    scheduleOnce: (delayMilliseconds, task) => {
      const timer = { delayMilliseconds, task, finished: false };
      oneShotTimers.push(timer);
      return () => { timer.finished = true; };
    },
    daemonStatusFile,
    machineId: MACHINE_ID,
    backendUrl: BACKEND_URL,
  };

  async function runScheduled(intervalMilliseconds: number): Promise<void> {
    for (const scheduled of scheduledTasks) {
      if (!scheduled.cancelled && scheduled.intervalMilliseconds === intervalMilliseconds) await scheduled.task();
    }
    await settle();
  }

  return {
    dependencies,
    callLog,
    logLines,
    ringCalls,
    markedRung,
    publishedSessions,
    heartbeatCount: () => heartbeats,
    keeperCallCount: () => keeperCalls,
    listenerIsSubscribed: () => deliverToListener !== null,
    deliverNotices(messageIds, createdAts) {
      if (deliverToListener === null) throw new Error('no listener is subscribed');
      deliverToListener(messageIds.map((messageId, position) => ({ messageId, kind: 'message', createdAt: createdAts?.[position] ?? nextCreatedAt++ })));
    },
    deliverMalformedNotice(messageId) {
      deliverMalformedToListener?.(messageId);
    },
    keeperAnswers(kind, answerOptions = {}) {
      const pid = answerOptions.pid ?? 100;
      keeperAnswer = async () => {
        if (kind === 'running' || kind === 'waiting_for_owner') return { kind, entry: orchestratorEntry(pid) };
        if (kind === 'duplicated') return { kind, entries: [orchestratorEntry(pid), orchestratorEntry(pid + 1, { id: 'efgh5678' })] };
        return { kind: 'conflict', entries: [orchestratorEntry(pid, { kind: 'interactive' })] };
      };
    },
    keeperAnswersWith(answer) { keeperAnswer = answer; },
    ringAnswersWith(answer) { ringAnswer = answer; },
    markAnswersWith(answer) { markAnswer = answer; },
    heartbeatAnswersWith(answer) { heartbeatAnswer = answer; },
    localSessionsAre(sessions) { localSessions = sessions; },
    revokeMachine() { revoke(new MachineRevokedError()); },
    advanceClock(milliseconds) { now += milliseconds; },
    tick: () => runScheduled(ORCHESTRATOR_CHECK_INTERVAL_MILLISECONDS),
    heartbeatTick: () => runScheduled(HEARTBEAT_INTERVAL_MILLISECONDS),
    readStatus: () => JSON.parse(readFileSync(daemonStatusFile, 'utf8')) as DaemonStatus,
    ledgerRecorded: () => [...rungInMemory],
    waitingOneShotTimers: () => oneShotTimers.filter((timer) => !timer.finished),
    async fireOneShotTimers() {
      for (const timer of oneShotTimers.filter((candidate) => !candidate.finished)) {
        timer.finished = true;
        timer.task();
      }
      await settle();
    },
  };
}

// Starts the loop and lets the orchestrator (pid 100 unless a test says
// otherwise) get past its warm-up, so a test about ringing starts from a warm one.
async function startWarmLoop(world: FakeWorld) {
  const loop = startDaemonLoop(world.dependencies);
  loopsToStop.push(loop);
  await settle();
  world.advanceClock(ORCHESTRATOR_WARMUP_MILLISECONDS);
  await world.tick();
  return loop;
}

async function startColdLoop(world: FakeWorld) {
  const loop = startDaemonLoop(world.dependencies);
  loopsToStop.push(loop);
  await settle();
  return loop;
}

// ---- ringing ----

test('three notices arriving together produce exactly one ring listing all three ids, oldest first', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.deliverNotices(['m_3', 'm_1', 'm_2'], [30, 10, 20]);
  await settle();
  expect(world.ringCalls).toEqual([['m_1', 'm_2', 'm_3']]);
  expect(world.markedRung.sort()).toEqual(['m_1', 'm_2', 'm_3']);
});

test('an id already in the ledger is marked rung on the backend but not rung again', async () => {
  const world = createFakeWorld({ alreadyRung: ['m_1'] });
  await startWarmLoop(world);
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  expect(world.markedRung).toEqual(['m_1']);
});

test('the ledger is written before the ring, so a crash after ringing never rings twice', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.deliverNotices(['m_1', 'm_2']);
  await settle();
  const ringAndLedgerCalls = world.callLog.filter((call) => !call.startsWith('mark:'));
  expect(ringAndLedgerCalls).toEqual(['record:m_1,m_2', 'ring:m_1,m_2']);
  expect(world.callLog.indexOf('mark:m_1')).toBeGreaterThan(world.callLog.indexOf('ring:m_1,m_2'));
});

test('a crash between recordRung and the ring never rings those ids after a restart', async () => {
  const ledgerFile = join(makeTemporaryDirectory(), 'rung.json');
  const realLedger = openRungMessageLedger(ledgerFile);
  // The first daemon records the ids, then "dies" before it can ring: its
  // recordRung finishes writing rung.json and then never returns.
  const ledgerThatDiesAfterRecording: RungMessageLedger = {
    hasBeenRung: (messageId) => realLedger.hasBeenRung(messageId),
    async recordRung(messageIds) {
      await realLedger.recordRung(messageIds);
      await new Promise<never>(() => undefined);
    },
  };
  const firstDaemon = createFakeWorld({ ledger: ledgerThatDiesAfterRecording });
  const deadLoop = await startWarmLoop(firstDaemon);
  // A dead process is never stopped; its stop would wait on the ring pass forever.
  loopsToStop.splice(loopsToStop.indexOf(deadLoop), 1);
  firstDaemon.deliverNotices(['m_1', 'm_2']);
  await vi.waitFor(() => expect(JSON.parse(readFileSync(ledgerFile, 'utf8')).rung_message_ids).toEqual(['m_1', 'm_2']));
  expect(firstDaemon.ringCalls).toHaveLength(0);

  // The restarted daemon reads the same rung.json and is handed the same notices.
  const restartedDaemon = createFakeWorld({ ledger: openRungMessageLedger(ledgerFile) });
  await startWarmLoop(restartedDaemon);
  restartedDaemon.deliverNotices(['m_1', 'm_2']);
  await vi.waitFor(() => expect(restartedDaemon.markedRung.sort()).toEqual(['m_1', 'm_2']));
  expect(restartedDaemon.ringCalls).toHaveLength(0);
});

test('an unreadable ledger is logged loudly, rings nothing and keeps the ids pending', async () => {
  const ledgerFile = join(makeTemporaryDirectory(), 'rung.json');
  writeFileSync(ledgerFile, '{ this is not json');
  const world = createFakeWorld({ ledger: openRungMessageLedger(ledgerFile) });
  await startWarmLoop(world);
  world.deliverNotices(['m_1']);
  await settle();
  await world.tick();

  expect(world.ringCalls).toHaveLength(0);
  expect(world.markedRung).toHaveLength(0);
  const errorLines = world.logLines.filter((line) => line.startsWith('ERROR') && line.includes(ledgerFile));
  // Logged on every batch it blocks: the delivery and the tick.
  expect(errorLines.length).toBeGreaterThanOrEqual(2);
  expect(world.readStatus().ledger_error).toContain(ledgerFile);

  // Once the file is fixed, the id that waited is rung and the error clears.
  rmSync(ledgerFile);
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
  expect(world.readStatus().ledger_error).toBeNull();
});

test('a ledger whose reads fail never rings blindly, even if recording would work', async () => {
  const world = createFakeWorld();
  const recordedIds: string[] = [];
  world.dependencies.ledger = {
    hasBeenRung: async () => { throw new Error('the doorbell ledger /state/rung.json is not readable; fix or remove it'); },
    recordRung: async (messageIds) => { recordedIds.push(...messageIds); },
  };
  await startWarmLoop(world);
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  expect(recordedIds).toHaveLength(0);
  expect(world.readStatus()).toEqual(expect.objectContaining({ ledger_error: expect.stringContaining('/state/rung.json'), pending_notice_count: 1 }));
});

test('a ledger that cannot record the ids rings nothing and keeps them pending', async () => {
  const world = createFakeWorld();
  world.dependencies.ledger = {
    hasBeenRung: async () => false,
    recordRung: async () => { throw new Error('could not write /state/rung.json: no space left on device'); },
  };
  await startWarmLoop(world);
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  expect(world.logLines.some((line) => line.startsWith('ERROR') && line.includes('/state/rung.json'))).toBe(true);
  expect(world.readStatus().ledger_error).toContain('/state/rung.json');
});

test('an id that is not a valid opaque id is logged and marked rung without ringing', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.deliverNotices(['not a valid id!', 'm_1']);
  await settle();
  expect(world.ringCalls).toEqual([['m_1']]);
  expect(world.markedRung).toContain('not a valid id!');
  expect(world.logLines.some((line) => line.includes('not a valid message id'))).toBe(true);
});

test('a malformed notice the connection reports is marked rung, so it cannot crowd the reconcile read', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.deliverMalformedNotice('m_bad');
  await settle();
  expect(world.markedRung).toEqual(['m_bad']);
  expect(world.ringCalls).toHaveLength(0);
});

test('a malformed notice whose mark fails is retried on the next tick', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.markAnswersWith(async () => { throw firestoreError('unavailable'); });
  world.deliverMalformedNotice('m_bad');
  await settle();
  expect(world.markedRung).toEqual([]);
  world.markAnswersWith(async () => undefined);
  await world.tick();
  expect(world.markedRung).toEqual(['m_bad']);
});

// ---- duplicated, conflict and keeper errors ----

test('a duplicated orchestrator rings nothing, logs the misconfiguration and publishes the orchestrator state duplicated', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.keeperAnswers('duplicated');
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  expect(world.logLines.some((line) => /more than one/i.test(line) && line.includes(ORCHESTRATOR_NAME))).toBe(true);
  expect(world.publishedSessions.at(-1)).toContainEqual(expect.objectContaining({ role: 'orchestrator', state: 'duplicated' }));
  expect(world.ledgerRecorded()).not.toContain('m_1');
});

test('notices left unrung while the orchestrator was duplicated are rung on the next tick once it is running', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.keeperAnswers('duplicated');
  world.deliverNotices(['m_1']);
  await world.tick();
  expect(world.ringCalls).toHaveLength(0);
  // The owner stopped the copy; the same session (same pid) is left running.
  world.keeperAnswers('running', { pid: 100 });
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
});

test('a conflict orchestrator rings nothing and publishes the orchestrator state conflict', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.keeperAnswers('conflict');
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  expect(world.logLines.some((line) => /interactive/i.test(line) && line.includes(ORCHESTRATOR_NAME))).toBe(true);
  const lastPublished = world.publishedSessions.at(-1) ?? [];
  expect(lastPublished).toContainEqual(expect.objectContaining({ role: 'orchestrator', state: 'conflict' }));
  // The interactive session with the name is not published a second time as a work session.
  expect(lastPublished.filter((session) => session.sessionName === ORCHESTRATOR_NAME)).toHaveLength(1);

  world.keeperAnswers('running', { pid: 100 });
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
});

test('a keeper error is logged, rings nothing, keeps the ids pending and is retried on the next tick', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.keeperAnswersWith(async () => { throw new Error('launching the orchestrator failed (exit 1): Workspace not trusted'); });
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  expect(world.logLines.some((line) => line.includes('Workspace not trusted'))).toBe(true);
  world.keeperAnswers('running', { pid: 100 });
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
});

// ---- concurrency ----

test('notices arriving during an in-flight ring are batched into the next ring', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  let finishFirstRing: () => void = () => undefined;
  world.ringAnswersWith((messageIds) =>
    messageIds[0] === 'm_1' ? new Promise((resolve) => { finishFirstRing = () => resolve({ kind: 'rung' }); }) : Promise.resolve({ kind: 'rung' }),
  );
  world.deliverNotices(['m_1']);
  await settle();
  world.deliverNotices(['m_2']);
  world.deliverNotices(['m_3']);
  await settle();
  expect(world.ringCalls).toEqual([['m_1']]);
  finishFirstRing();
  await settle();
  expect(world.ringCalls).toEqual([['m_1'], ['m_2', 'm_3']]);
});

test('two overlapping ensure calls launch once', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  const keeperCallsBefore = world.keeperCallCount();
  let finishLaunch: () => void = () => undefined;
  world.keeperAnswersWith(() => new Promise((resolve) => { finishLaunch = () => resolve({ kind: 'running', entry: orchestratorEntry(100) }); }));
  // A notice batch starts a keeper run; a 60 s tick arrives while it is still in flight.
  world.deliverNotices(['m_1']);
  await settle();
  const tickFinished = world.tick();
  await settle();
  expect(world.keeperCallCount() - keeperCallsBefore).toBe(1);
  finishLaunch();
  await tickFinished;
  await settle();
  expect(world.keeperCallCount() - keeperCallsBefore).toBe(1);
  expect(world.ringCalls).toEqual([['m_1']]);
});

// ---- the pending set and marks ----

test('marks are not awaited one after another', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  const startedMarks: string[] = [];
  world.markAnswersWith((messageId) => {
    startedMarks.push(messageId);
    return new Promise(() => undefined); // offline: never acknowledged
  });
  world.deliverNotices(['m_1', 'm_2', 'm_3']);
  await settle();
  expect(startedMarks).toEqual(['m_1', 'm_2', 'm_3']);
});

test('a mark that fails for a passing reason is retried on the next tick without ringing again', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.markAnswersWith(async () => { throw firestoreError('unavailable'); });
  world.deliverNotices(['m_1']);
  await settle();
  world.markAnswersWith(async () => undefined);
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
  expect(world.markedRung).toEqual(['m_1']);
  // Marked now, so a later tick leaves it alone.
  await world.tick();
  expect(world.callLog.filter((call) => call === 'mark:m_1')).toHaveLength(2);
});

test('an id whose mark fails with not-found or permission-denied is dropped from the pending set', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.markAnswersWith(async (messageId) => { throw firestoreError(messageId === 'm_1' ? 'not-found' : 'permission-denied'); });
  world.deliverNotices(['m_1', 'm_2']);
  await settle();
  await world.tick();
  await world.tick();
  expect(world.callLog.filter((call) => call.startsWith('mark:'))).toEqual(['mark:m_1', 'mark:m_2']);
  expect(world.readStatus().pending_notice_count).toBe(0);
});

test('an id handed over again after it was rung is absorbed by the ledger, not rung again', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.deliverNotices(['m_1']);
  await settle();
  // A later connection (or a reconcile that misjudged a mark in flight) hands it over again.
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toEqual([['m_1']]);
  expect(world.markedRung).toEqual(['m_1', 'm_1']);
});

// ---- ring outcomes ----

test('a refused ring logs a warning naming crossSessionInbound and the permission mode, and keeps the ids recorded', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  world.ringAnswersWith(async () => ({ kind: 'refused', reason: 'the doorbell was held or refused by the orchestrator session' }));
  world.deliverNotices(['m_1']);
  await settle();
  const warning = world.logLines.find((line) => line.startsWith('WARNING'));
  expect(warning).toContain('crossSessionInbound');
  expect(warning).toContain('permission mode');
  expect(world.ledgerRecorded()).toContain('m_1');
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
});

test('the status file records the last ring outcome', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  expect(world.readStatus().last_ring_outcome).toBeNull();
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.readStatus().last_ring_outcome).toEqual({ at: expect.any(Number), kind: 'rung' });

  world.ringAnswersWith(async () => ({ kind: 'failed', reason: 'claude -p exited 0 without a successful SendMessage to orchestrator' }));
  world.advanceClock(1_000);
  world.deliverNotices(['m_2']);
  await settle();
  const failedOutcome = world.readStatus().last_ring_outcome;
  expect(failedOutcome).toEqual({ at: expect.any(Number), kind: 'failed', reason: 'claude -p exited 0 without a successful SendMessage to orchestrator' });
  expect(world.logLines.some((line) => line.includes('without a successful SendMessage'))).toBe(true);
});

// ---- warm-up ----

test('the first ring after a launch or wake waits for the MCP warm-up interval', async () => {
  const world = createFakeWorld();
  world.keeperAnswers('running', { pid: 100 });
  await startWarmLoop(world);
  world.keeperAnswers('running', { pid: 200 }); // woken: new pid
  world.deliverNotices(['m_1']);
  await world.tick();
  expect(world.ringCalls).toHaveLength(0);
  expect(world.ledgerRecorded()).not.toContain('m_1');
  world.advanceClock(ORCHESTRATOR_WARMUP_MILLISECONDS);
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
});

test('a notice for an orchestrator whose pid is unchanged since the last tick is rung without waiting', async () => {
  const world = createFakeWorld();
  world.keeperAnswers('running', { pid: 100 });
  await startColdLoop(world);
  await world.tick();
  world.advanceClock(ORCHESTRATOR_WARMUP_MILLISECONDS);
  await world.tick();
  world.deliverNotices(['m_2']);
  await world.tick();
  expect(world.ringCalls).toEqual([['m_2']]);
});

test('the daemon starting next to a freshly seen orchestrator holds rings for the warm-up too', async () => {
  const world = createFakeWorld();
  await startColdLoop(world);
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  world.advanceClock(ORCHESTRATOR_WARMUP_MILLISECONDS - 1);
  await world.tick();
  expect(world.ringCalls).toHaveLength(0);
  world.advanceClock(1);
  await world.tick();
  expect(world.ringCalls).toEqual([['m_1']]);
});

// ---- publishing sessions ----

test('a changed local session list is published once; an unchanged one is not republished', async () => {
  const world = createFakeWorld();
  await startWarmLoop(world);
  const publishedBefore = world.publishedSessions.length;
  world.localSessionsAre([
    { sessionName: ORCHESTRATOR_NAME, projectName: 'projects', state: 'done', role: 'orchestrator' },
    { sessionName: 'api', projectName: 'api', state: 'working', role: 'session' },
  ]);
  await world.tick();
  await world.tick();
  expect(world.publishedSessions.length - publishedBefore).toBe(1);
  expect(world.publishedSessions.at(-1)).toEqual([
    { sessionName: 'api', projectName: 'api', state: 'working', role: 'session' },
    { sessionName: ORCHESTRATOR_NAME, projectName: 'projects', state: 'running', role: 'orchestrator' },
  ]);
});

test('stopped sessions other than the orchestrator are not published as live; a stopped orchestrator is published as stopped', async () => {
  const world = createFakeWorld();
  world.keeperAnswersWith(async () => { throw new Error('waking the orchestrator failed (exit 1): no conversation found'); });
  world.localSessionsAre([
    { sessionName: 'old-work', projectName: 'old', state: 'stopped', role: 'session' },
    { sessionName: 'api', projectName: 'api', state: 'done', role: 'session' },
    { sessionName: ORCHESTRATOR_NAME, projectName: 'projects', state: 'stopped', role: 'orchestrator' },
  ]);
  await startColdLoop(world);
  await world.tick();
  const lastPublished = world.publishedSessions.at(-1) ?? [];
  expect(lastPublished.map((session) => session.sessionName)).not.toContain('old-work');
  expect(lastPublished).toContainEqual({ sessionName: ORCHESTRATOR_NAME, projectName: 'projects', state: 'stopped', role: 'orchestrator' });
});

test('a session list that failed to publish is published again on the next tick', async () => {
  const world = createFakeWorld();
  let publishAttempts = 0;
  world.dependencies.connection.publishSessions = async () => {
    publishAttempts += 1;
    if (publishAttempts === 1) throw firestoreError('unavailable');
  };
  await startColdLoop(world);
  await world.tick();
  expect(publishAttempts).toBe(2);
});

// ---- status, heartbeat, revocation ----

test('the status file is rewritten on every tick even when nothing happens', async () => {
  const world = createFakeWorld();
  await startColdLoop(world);
  await world.tick();
  const first = world.readStatus().updated_at;
  world.advanceClock(60_000);
  await world.tick();
  expect(world.readStatus().updated_at).toBeGreaterThan(first);
  expect(world.readStatus()).toEqual(
    expect.objectContaining({ machine_id: MACHINE_ID, backend_url: BACKEND_URL, loop_running: true, orchestrator_state: 'running', machine_revoked: false }),
  );
});

test('a heartbeat is sent at start and every five minutes', async () => {
  const world = createFakeWorld();
  await startColdLoop(world);
  expect(world.heartbeatCount()).toBe(1);
  await world.heartbeatTick();
  expect(world.heartbeatCount()).toBe(2);
});

test('a heartbeat refused by the rules is logged with the clock-skew explanation', async () => {
  const world = createFakeWorld();
  world.heartbeatAnswersWith(async () => { throw firestoreError('permission-denied'); });
  await startColdLoop(world);
  expect(world.logLines.some((line) => line.includes('heartbeat') && line.includes('refused') && line.includes('clock'))).toBe(true);
});

test('a revoked machine stops the loop cleanly and the status file says so', async () => {
  const world = createFakeWorld();
  const loop = await startWarmLoop(world);
  world.revokeMachine();
  await loop.whenMachineRevoked;
  await settle();
  expect(world.listenerIsSubscribed()).toBe(false);
  expect(world.readStatus()).toEqual(expect.objectContaining({ machine_revoked: true, loop_running: false }));
  expect(world.logLines.some((line) => line.includes('revoked'))).toBe(true);
  const keeperCallsAfterRevocation = world.keeperCallCount();
  await world.tick();
  await world.heartbeatTick();
  expect(world.keeperCallCount()).toBe(keeperCallsAfterRevocation);
});

test('stop waits for a keeper check in flight, so no claude child outlives the loop', async () => {
  const world = createFakeWorld();
  const loop = await startWarmLoop(world);
  let finishCheck: () => void = () => undefined;
  world.keeperAnswersWith(() => new Promise((resolve) => { finishCheck = () => resolve({ kind: 'running', entry: orchestratorEntry(100) }); }));
  void world.tick();
  await settle();
  let stopFinished = false;
  const stopping = loop.stop().then(() => { stopFinished = true; });
  await settle();
  expect(stopFinished).toBe(false);
  finishCheck();
  await stopping;
  expect(stopFinished).toBe(true);
});

test('a second stop waits for the same in-flight work as the first', async () => {
  const world = createFakeWorld();
  const loop = await startWarmLoop(world);
  let finishCheck: () => void = () => undefined;
  world.keeperAnswersWith(() => new Promise((resolve) => { finishCheck = () => resolve({ kind: 'running', entry: orchestratorEntry(100) }); }));
  void world.tick();
  await settle();
  // Revocation (or SIGTERM) starts the first stop; a second signal calls stop again.
  void loop.stop();
  let secondStopFinished = false;
  const secondStop = loop.stop().then(() => { secondStopFinished = true; });
  await settle();
  expect(secondStopFinished).toBe(false);
  finishCheck();
  await secondStop;
  expect(secondStopFinished).toBe(true);
});

test('a stop while a ring pass reads the ledger runs no keeper check and records nothing', async () => {
  const world = createFakeWorld();
  let releaseLedgerRead: () => void = () => undefined;
  const recordedIds: string[] = [];
  world.dependencies.ledger = {
    hasBeenRung: () => new Promise((resolve) => { releaseLedgerRead = () => resolve(false); }),
    recordRung: async (messageIds) => { recordedIds.push(...messageIds); },
  };
  const loop = await startWarmLoop(world);
  const keeperCallsBefore = world.keeperCallCount();
  world.deliverNotices(['m_1']);
  await settle();
  const stopping = loop.stop();
  releaseLedgerRead();
  await stopping;
  expect(world.keeperCallCount()).toBe(keeperCallsBefore);
  expect(recordedIds).toEqual([]);
  expect(world.ringCalls).toEqual([]);
});

test('a stop while a ring pass waits for the keeper records nothing and rings nothing', async () => {
  const world = createFakeWorld();
  const loop = await startWarmLoop(world);
  let finishLaunch: () => void = () => undefined;
  world.keeperAnswersWith(() => new Promise((resolve) => { finishLaunch = () => resolve({ kind: 'running', entry: orchestratorEntry(100) }); }));
  world.deliverNotices(['m_1']);
  await settle();
  const stopping = loop.stop();
  finishLaunch();
  await stopping;
  expect(world.ledgerRecorded()).not.toContain('m_1');
  expect(world.ringCalls).toEqual([]);
});

test('a ring held for warm-up goes out when the warm-up ends, not at the next tick', async () => {
  const world = createFakeWorld();
  world.keeperAnswers('running', { pid: 100 });
  await startWarmLoop(world);
  world.keeperAnswers('running', { pid: 200 }); // woken: new pid
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.ringCalls).toHaveLength(0);
  // The whole warm-up is still to come: the timer asks for all of it.
  expect(world.waitingOneShotTimers()).toEqual([expect.objectContaining({ delayMilliseconds: ORCHESTRATOR_WARMUP_MILLISECONDS })]);
  world.advanceClock(ORCHESTRATOR_WARMUP_MILLISECONDS);
  await world.fireOneShotTimers();
  expect(world.ringCalls).toEqual([['m_1']]);
});

test('a ring held for warm-up asks only for the warm-up time that is left, and only once', async () => {
  const world = createFakeWorld();
  world.keeperAnswers('running', { pid: 100 });
  await startWarmLoop(world);
  world.keeperAnswers('running', { pid: 200 });
  await world.tick(); // the new pid is first seen now
  world.advanceClock(10_000);
  world.deliverNotices(['m_1']);
  await settle();
  world.deliverNotices(['m_2']);
  await settle();
  expect(world.waitingOneShotTimers()).toEqual([expect.objectContaining({ delayMilliseconds: ORCHESTRATOR_WARMUP_MILLISECONDS - 10_000 })]);
});

test('stop cancels a warm-up timer that has not fired yet', async () => {
  const world = createFakeWorld();
  const loop = await startColdLoop(world);
  world.deliverNotices(['m_1']);
  await settle();
  expect(world.waitingOneShotTimers()).toHaveLength(1);
  await loop.stop();
  expect(world.waitingOneShotTimers()).toHaveLength(0);
});

test('a status write that fails leaves no temporary file behind', async () => {
  const statusDirectory = makeTemporaryDirectory();
  const statusFile = join(statusDirectory, 'status.json');
  // A directory where the file should be makes the final rename fail.
  mkdirSync(statusFile);
  const status: DaemonStatus = {
    updated_at: 1, machine_id: MACHINE_ID, backend_url: BACKEND_URL, loop_running: true, orchestrator_state: null, orchestrator_error: null,
    last_ring_outcome: null, ledger_error: null, machine_revoked: false, pending_notice_count: 0,
  };
  await expect(writeDaemonStatusFile(statusFile, status)).rejects.toThrow();
  expect(readdirSync(statusDirectory)).toEqual(['status.json']);
});

test('stop unsubscribes the listener, cancels the schedules and marks the status inactive', async () => {
  const world = createFakeWorld();
  const loop = await startWarmLoop(world);
  await loop.stop();
  expect(world.listenerIsSubscribed()).toBe(false);
  expect(world.readStatus().loop_running).toBe(false);
  const keeperCallsAfterStop = world.keeperCallCount();
  await world.tick();
  expect(world.keeperCallCount()).toBe(keeperCallsAfterStop);
});
