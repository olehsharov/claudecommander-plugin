// `claudecommander daemon doctor`: every check against a healthy fake machine,
// then each check with a fixture that breaks it. Nothing here runs the real
// `claude` (test/fakeClaude.mjs answers instead), a real systemctl (a fake
// function answers) or a real backend (a fake fetch answers).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { setUpFakeClaude, FAKE_CLAUDE_EXECUTABLE, type FakeClaude, type FakeClaudeScenario, type ScriptedClaudeAnswer } from '../test/fakeClaudeHarness.js';
import { createClaudeCommandRunner, type ClaudeCommandResult } from './claudeCli.js';
import { runDaemonCli, type DaemonCliDependencies } from './cli.js';
import type { DaemonStatus } from './daemonLoop.js';
import {
  DOCTOR_CHECK_NAMES,
  doctorExitCode,
  formatDoctorReport,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorDependencies,
} from './doctor.js';
import { writeMachineCredential } from './machineCredential.js';
import { resolveDaemonPaths, type DaemonPaths } from './paths.js';
import { PLUGIN_MCP_SERVER_NAME } from './pluginMcpNames.js';

const MACHINE_ID = 'machine_doctor';
const BACKEND_URL = 'https://backend.example';
const NOW = 1_800_000_000_000;
const LIVE_ORCHESTRATOR_PID = 7;

let temporaryHome: string;
let projectsRoot: string;
let paths: DaemonPaths;
let userSettingsFile: string;
let managedSettingsFile: string;
let fakeClaude: FakeClaude | undefined;

// What the fake backend and the fake systemctl answer. Each test changes only
// what it is about; everything else stays healthy.
let backendAnswers: Record<string, { status: number; body: unknown } | 'unreachable'>;
let fetchedRequests: Array<{ url: string; method: string }>;
let systemctlAnswers: { isActive: ClaudeCommandResult; showExecStart: ClaudeCommandResult };
let systemctlCalls: string[][];

function healthyExecStartLine(entryFile: string): string {
  return `{ path=/usr/bin/node ; argv[]=/usr/bin/node ${entryFile} daemon run ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
}

function healthyStatus(): DaemonStatus {
  return {
    updated_at: NOW - 30_000,
    machine_id: MACHINE_ID,
    backend_url: BACKEND_URL,
    loop_running: true,
    orchestrator_state: 'running',
    orchestrator_error: null,
    last_ring_outcome: { at: NOW - 600_000, kind: 'rung' },
    ledger_error: null,
    machine_revoked: false,
    pending_notice_count: 0,
  };
}

// The file's time follows the fake clock, so it compares sensibly with
// machine.json's (doctor uses the two to tell whether a restart is missing).
function writeStatus(status: DaemonStatus): void {
  mkdirSync(paths.stateDirectory, { recursive: true });
  writeFileSync(paths.daemonStatusFile, JSON.stringify(status));
  utimesSync(paths.daemonStatusFile, new Date(status.updated_at), new Date(status.updated_at));
}

function healthyOrchestratorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'orch0001',
    sessionId: 'orch0001-0000-4000-8000-000000000000',
    name: 'orchestrator',
    kind: 'background',
    cwd: projectsRoot,
    pid: LIVE_ORCHESTRATOR_PID,
    status: 'idle',
    state: 'working',
    ...overrides,
  };
}

function useFakeClaude(scenario: FakeClaudeScenario): void {
  fakeClaude?.removeTemporaryFiles();
  fakeClaude = setUpFakeClaude(scenario);
}

beforeEach(async () => {
  temporaryHome = mkdtempSync(join(tmpdir(), 'claudecommander-doctor-test-'));
  projectsRoot = join(temporaryHome, 'projects');
  mkdirSync(projectsRoot, { recursive: true });
  paths = resolveDaemonPaths(temporaryHome, {});
  userSettingsFile = join(temporaryHome, '.claude', 'settings.json');
  managedSettingsFile = join(temporaryHome, 'etc', 'claude-code', 'managed-settings.json');
  mkdirSync(join(temporaryHome, '.claude'), { recursive: true });
  writeFileSync(userSettingsFile, JSON.stringify({ crossSessionInbound: 'accept' }));

  await writeMachineCredential(paths, { backendUrl: BACKEND_URL, machineId: MACHINE_ID, machineSecret: `${MACHINE_ID}.secret-value` });
  writeFileSync(paths.orchestratorSettingsFile, JSON.stringify({ sessionName: 'orchestrator', projectsRoot, model: 'sonnet' }));
  mkdirSync(paths.installedDaemonDirectory, { recursive: true });
  writeFileSync(join(paths.installedDaemonDirectory, 'cli.js'), '// the installed bundle\n');
  writeStatus(healthyStatus());
  // machine.json was written before the daemon last wrote its status.
  utimesSync(paths.machineCredentialFile, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));

  backendAnswers = {
    [`GET ${BACKEND_URL}/.well-known/oauth-authorization-server`]: { status: 200, body: { issuer: BACKEND_URL } },
    [`POST ${BACKEND_URL}/daemon/token`]: { status: 200, body: { custom_token: 'header.payload.signature', machine_id: MACHINE_ID } },
  };
  fetchedRequests = [];
  systemctlAnswers = {
    isActive: { exitCode: 0, standardOutput: 'active\n', standardError: '' },
    showExecStart: { exitCode: 0, standardOutput: healthyExecStartLine(join(paths.installedDaemonDirectory, 'cli.js')), standardError: '' },
  };
  systemctlCalls = [];
  useFakeClaude({ sessions: [healthyOrchestratorRow()] });
});

afterEach(() => {
  fakeClaude?.removeTemporaryFiles();
  fakeClaude = undefined;
  rmSync(temporaryHome, { recursive: true, force: true });
});

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  fetchedRequests.push({ url, method });
  const answer = backendAnswers[`${method} ${url}`];
  if (answer === undefined || answer === 'unreachable') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

async function fakeSystemctl(argumentList: string[]): Promise<ClaudeCommandResult> {
  systemctlCalls.push(argumentList);
  if (argumentList.join(' ') === '--user is-active claudecommander') return systemctlAnswers.isActive;
  if (argumentList.join(' ') === '--user show claudecommander --property=ExecStart --value') return systemctlAnswers.showExecStart;
  return { exitCode: 1, standardOutput: '', standardError: `fake systemctl: unexpected ${argumentList.join(' ')}\n` };
}

function doctorDependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    daemonPaths: paths,
    homeDirectory: temporaryHome,
    fetchFunction: fakeFetch,
    claudeCommandRunner: createClaudeCommandRunner(FAKE_CLAUDE_EXECUTABLE),
    runSystemctl: fakeSystemctl,
    isProcessAlive: (pid) => pid === LIVE_ORCHESTRATOR_PID,
    clock: () => NOW,
    nodeVersion: '22.23.3',
    claudeSettingsFiles: { userSettingsFile, managedSettingsFile },
    ...overrides,
  };
}

async function checkNamed(checkName: string, overrides: Partial<DoctorDependencies> = {}): Promise<DoctorCheck> {
  const checks = await runDoctorChecks(doctorDependencies(overrides));
  const check = checks.find((candidate) => candidate.name === checkName);
  if (check === undefined) throw new Error(`no check named ${checkName}; got ${checks.map((candidate) => candidate.name).join(', ')}`);
  return check;
}

function isLoginCheck(call: string[]): boolean {
  return call.join(' ') === 'auth status';
}
function isMcpServerCheck(call: string[]): boolean {
  return call[0] === 'mcp' && call[1] === 'get' && call[2] === PLUGIN_MCP_SERVER_NAME && call.length === 3;
}
function isVersionCheck(call: string[]): boolean {
  return call.join(' ') === '--version';
}

async function loginCheckWith(answer: ScriptedClaudeAnswer): Promise<DoctorCheck> {
  useFakeClaude({ sessions: [healthyOrchestratorRow()], authStatus: answer });
  return checkNamed(DOCTOR_CHECK_NAMES.claudeLogin);
}

async function mcpServerCheckWith(answer: ScriptedClaudeAnswer): Promise<DoctorCheck> {
  useFakeClaude({ sessions: [healthyOrchestratorRow()], mcpGet: answer });
  return checkNamed(DOCTOR_CHECK_NAMES.mcpServer);
}

async function orchestratorCheckWithRows(rows: Array<Record<string, unknown>>): Promise<DoctorCheck> {
  useFakeClaude({ sessions: rows });
  return checkNamed(DOCTOR_CHECK_NAMES.orchestrator);
}

async function orchestratorCheckWithRow(overrides: Record<string, unknown>): Promise<DoctorCheck> {
  return orchestratorCheckWithRows([healthyOrchestratorRow(overrides)]);
}

function writeProjectSettings(directory: string, fileName: 'settings.json' | 'settings.local.json', contents: Record<string, unknown>): void {
  mkdirSync(join(directory, '.claude'), { recursive: true });
  writeFileSync(join(directory, '.claude', fileName), JSON.stringify(contents));
}

// ---- the whole report ----

test('a healthy machine reports every check ok and exit code 0', async () => {
  const checks = await runDoctorChecks(doctorDependencies());
  expect(checks.map((check) => check.name)).toEqual(Object.values(DOCTOR_CHECK_NAMES));
  expect(checks.filter((check) => check.status !== 'ok')).toEqual([]);
  expect(doctorExitCode(checks)).toBe(0);
});

test('doctorExitCode is 1 when any check failed and 0 when only warnings', () => {
  expect(doctorExitCode([{ name: 'a', status: 'ok', detail: '' }, { name: 'b', status: 'warning', detail: '' }])).toBe(0);
  expect(doctorExitCode([{ name: 'a', status: 'failed', detail: '' }])).toBe(1);
});

test('formatDoctorReport prints one line per check, even when a detail has a line break', () => {
  const report = formatDoctorReport([
    { name: 'backend', status: 'ok', detail: 'answered' },
    { name: 'orchestrator', status: 'warning', detail: 'stopped\nsecond line' },
    { name: 'service unit', status: 'failed', detail: 'inactive' },
  ]);
  expect(report.split('\n').filter((line) => line !== '')).toEqual([
    'ok       backend: answered',
    'warning  orchestrator: stopped second line',
    'failed   service unit: inactive',
  ]);
  expect(report.endsWith('\n')).toBe(true);
});

test('doctor never wakes or launches the orchestrator: only agents --json --all, auth status, mcp get and --version are run', async () => {
  // A stopped orchestrator is exactly what the keeper would wake.
  useFakeClaude({ sessions: [healthyOrchestratorRow({ pid: undefined, status: undefined, state: 'done' })] });
  await runDoctorChecks(doctorDependencies());
  const claudeCalls = fakeClaude!.allCalls();
  expect(claudeCalls.length).toBeGreaterThan(0);
  expect(claudeCalls.every((call) => call.join(' ') === 'agents --json --all' || isLoginCheck(call) || isMcpServerCheck(call) || isVersionCheck(call))).toBe(true);
  expect(fakeClaude!.currentSessions()[0]!.pid).toBeUndefined();
});

test('doctor only asks systemctl, and only GETs metadata and POSTs /daemon/token to the backend', async () => {
  await runDoctorChecks(doctorDependencies());
  expect(systemctlCalls).toEqual([
    ['--user', 'is-active', 'claudecommander'],
    ['--user', 'show', 'claudecommander', '--property=ExecStart', '--value'],
  ]);
  expect(fetchedRequests).toEqual([
    { url: `${BACKEND_URL}/.well-known/oauth-authorization-server`, method: 'GET' },
    { url: `${BACKEND_URL}/daemon/token`, method: 'POST' },
  ]);
});

test('the report never contains the machine secret or the custom token', async () => {
  backendAnswers[`POST ${BACKEND_URL}/daemon/token`] = { status: 500, body: { error: 'server_error', echoed: `${MACHINE_ID}.secret-value` } };
  const report = formatDoctorReport(await runDoctorChecks(doctorDependencies()));
  expect(report).not.toContain('secret-value');
  backendAnswers[`POST ${BACKEND_URL}/daemon/token`] = { status: 200, body: { custom_token: 'header.payload.signature', machine_id: MACHINE_ID } };
  expect(formatDoctorReport(await runDoctorChecks(doctorDependencies()))).not.toContain('header.payload.signature');
});

// ---- backend ----

test('a backend whose metadata answers 200 is ok', async () => {
  expect(await checkNamed(DOCTOR_CHECK_NAMES.backend)).toEqual(expect.objectContaining({ status: 'ok', detail: expect.stringContaining(BACKEND_URL) }));
});

test('an unreachable backend is failed and names the URL', async () => {
  backendAnswers[`GET ${BACKEND_URL}/.well-known/oauth-authorization-server`] = 'unreachable';
  const check = await checkNamed(DOCTOR_CHECK_NAMES.backend);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain(`${BACKEND_URL}/.well-known/oauth-authorization-server`);
});

test('a backend metadata answer other than 200 is failed with the HTTP status', async () => {
  backendAnswers[`GET ${BACKEND_URL}/.well-known/oauth-authorization-server`] = { status: 503, body: {} };
  expect(await checkNamed(DOCTOR_CHECK_NAMES.backend)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('HTTP 503') }));
});

// ---- machine credential ----

test('a credential /daemon/token accepts is ok and names the machine', async () => {
  expect(await checkNamed(DOCTOR_CHECK_NAMES.machineCredential)).toEqual(expect.objectContaining({ status: 'ok', detail: expect.stringContaining(MACHINE_ID) }));
});

test('a revoked machine credential reports failed with "machine revoked" and says to pair again and restart the service', async () => {
  backendAnswers[`POST ${BACKEND_URL}/daemon/token`] = { status: 401, body: { error: 'machine_revoked' } };
  const check = await checkNamed(DOCTOR_CHECK_NAMES.machineCredential);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain('machine revoked');
  expect(check.detail).toContain('claudecommander daemon pair --force');
  expect(check.detail).toContain('systemctl --user restart claudecommander');
});

test('a credential the backend does not know is failed with the same advice', async () => {
  backendAnswers[`POST ${BACKEND_URL}/daemon/token`] = { status: 401, body: { error: 'invalid_credential' } };
  const check = await checkNamed(DOCTOR_CHECK_NAMES.machineCredential);
  expect(check.status).toBe('failed');
  expect(check.detail).toMatch(/refused/);
  expect(check.detail).toContain('claudecommander daemon pair --force');
});

test('no machine.json is failed and says to pair', async () => {
  rmSync(paths.machineCredentialFile);
  const check = await checkNamed(DOCTOR_CHECK_NAMES.machineCredential);
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('claudecommander daemon pair') }));
  // Without a credential the backend check still runs, against the default backend.
  expect((await checkNamed(DOCTOR_CHECK_NAMES.backend)).detail).not.toContain(BACKEND_URL);
});

test('a damaged machine.json is failed and names the file', async () => {
  writeFileSync(paths.machineCredentialFile, '{not json');
  expect(await checkNamed(DOCTOR_CHECK_NAMES.machineCredential)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining(paths.machineCredentialFile) }));
});

// ---- service unit ----

test('an active unit is ok', async () => {
  expect((await checkNamed(DOCTOR_CHECK_NAMES.serviceUnit)).status).toBe('ok');
});

test('an inactive unit is failed and says how to start it', async () => {
  systemctlAnswers.isActive = { exitCode: 3, standardOutput: 'inactive\n', standardError: '' };
  const check = await checkNamed(DOCTOR_CHECK_NAMES.serviceUnit);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain('inactive');
  expect(check.detail).toContain('systemctl --user start claudecommander');
});

test('an inactive unit with machine.json newer than the status file says to restart the service', async () => {
  systemctlAnswers.isActive = { exitCode: 3, standardOutput: 'inactive\n', standardError: '' };
  utimesSync(paths.daemonStatusFile, new Date(NOW - 7_200_000), new Date(NOW - 7_200_000));
  utimesSync(paths.machineCredentialFile, new Date(NOW - 60_000), new Date(NOW - 60_000));
  const check = await checkNamed(DOCTOR_CHECK_NAMES.serviceUnit);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain('systemctl --user restart claudecommander');
});

test('systemctl that cannot be run is failed, not a crash', async () => {
  const check = await checkNamed(DOCTOR_CHECK_NAMES.serviceUnit, { runSystemctl: async () => { throw new Error('spawn systemctl ENOENT'); } });
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('systemctl') }));
});

// ---- service entry file ----

test('a unit whose ExecStart runs the installed cli.js is ok', async () => {
  expect((await checkNamed(DOCTOR_CHECK_NAMES.serviceEntryFile)).status).toBe('ok');
});

test('a unit whose ExecStart entry file is missing reports failed and says to re-run daemon install', async () => {
  rmSync(join(paths.installedDaemonDirectory, 'cli.js'));
  const check = await checkNamed(DOCTOR_CHECK_NAMES.serviceEntryFile);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain('re-run claudecommander daemon install');
});

test('a unit whose ExecStart points outside the installed daemon directory is failed', async () => {
  const pluginCacheFile = join(temporaryHome, '.claude', 'plugins', 'cache', 'claudecommander', '0.1.0', 'dist', 'cli.js');
  mkdirSync(join(pluginCacheFile, '..'), { recursive: true });
  writeFileSync(pluginCacheFile, '');
  systemctlAnswers.showExecStart = { exitCode: 0, standardOutput: healthyExecStartLine(pluginCacheFile), standardError: '' };
  const check = await checkNamed(DOCTOR_CHECK_NAMES.serviceEntryFile);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain(paths.installedDaemonDirectory);
  expect(check.detail).toContain('re-run claudecommander daemon install');
});

test('a unit with no ExecStart (not installed) is failed and says to re-run daemon install', async () => {
  systemctlAnswers.showExecStart = { exitCode: 0, standardOutput: '\n', standardError: '' };
  expect(await checkNamed(DOCTOR_CHECK_NAMES.serviceEntryFile)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('re-run claudecommander daemon install') }));
});

// ---- daemon loop (status file freshness) ----

test('a fresh status file with the loop running is ok, and does not claim the listener is healthy', async () => {
  const check = await checkNamed(DOCTOR_CHECK_NAMES.daemonLoop);
  expect(check.status).toBe('ok');
  expect(check.detail).toContain('30 s ago');
  expect(check.detail).not.toMatch(/listener (is )?(healthy|active|ok)/i);
});

test('a status file older than 2 minutes reports the daemon loop as failed', async () => {
  writeStatus({ ...healthyStatus(), updated_at: NOW - 121_000 });
  expect(await checkNamed(DOCTOR_CHECK_NAMES.daemonLoop)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('2 min') }));
});

test('a status file saying the loop is not running is failed', async () => {
  writeStatus({ ...healthyStatus(), loop_running: false });
  expect((await checkNamed(DOCTOR_CHECK_NAMES.daemonLoop)).status).toBe('failed');
});

test('no status file is failed and says the daemon has not run', async () => {
  rmSync(paths.daemonStatusFile);
  expect(await checkNamed(DOCTOR_CHECK_NAMES.daemonLoop)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/has not run/) }));
});

test('a status file that is not JSON is failed and names the file', async () => {
  writeFileSync(paths.daemonStatusFile, '{broken');
  expect(await checkNamed(DOCTOR_CHECK_NAMES.daemonLoop)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining(paths.daemonStatusFile) }));
});

test('a status file recording a revoked machine says to pair again and restart the service', async () => {
  writeStatus({ ...healthyStatus(), loop_running: false, machine_revoked: true });
  const check = await checkNamed(DOCTOR_CHECK_NAMES.daemonLoop);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain('machine revoked');
  expect(check.detail).toContain('claudecommander daemon pair --force');
  expect(check.detail).toContain('systemctl --user restart claudecommander');
});

test('a revoked status written before machine.json was replaced says the new pairing needs a service restart', async () => {
  writeStatus({ ...healthyStatus(), loop_running: false, machine_revoked: true });
  utimesSync(paths.daemonStatusFile, new Date(NOW - 7_200_000), new Date(NOW - 7_200_000));
  utimesSync(paths.machineCredentialFile, new Date(NOW - 60_000), new Date(NOW - 60_000));
  const check = await checkNamed(DOCTOR_CHECK_NAMES.daemonLoop);
  expect(check.status).toBe('failed');
  expect(check.detail).toMatch(/paired again/);
  expect(check.detail).toContain('systemctl --user restart claudecommander');
  expect(check.detail).not.toContain('pair --force');
});

// ---- orchestrator ----

test('a live orchestrator is ok', async () => {
  expect((await checkNamed(DOCTOR_CHECK_NAMES.orchestrator)).status).toBe('ok');
});

test('a stopped orchestrator is a warning that says the daemon wakes it on the next message', async () => {
  const check = await orchestratorCheckWithRow({ pid: undefined, status: undefined, state: 'done' });
  expect(check.status).toBe('warning');
  expect(check.detail).toMatch(/wakes it on the next message/);
});

test('an absent orchestrator is a warning that says the daemon launches it', async () => {
  const check = await orchestratorCheckWithRows([]);
  expect(check).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringMatching(/launches it/) }));
});

test('an absent orchestrator whose last start failed shows the daemon\'s error', async () => {
  writeStatus({ ...healthyStatus(), orchestrator_state: 'error', orchestrator_error: 'launching the orchestrator failed (exit 1): no such model' });
  const check = await orchestratorCheckWithRows([]);
  expect(check.detail).toContain('no such model');
});

test('waiting_for_owner names claude attach <name> as the fix', async () => {
  const check = await orchestratorCheckWithRow({ pid: 7, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' });
  expect(check).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringContaining('claude attach orchestrator') }));
});

test('an orchestrator blocked without a permission prompt warns that its login may have expired and says to attach', async () => {
  const check = await orchestratorCheckWithRow({ pid: 7, status: 'idle', state: 'blocked' });
  expect(check).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringMatching(/login may have expired.*claude attach/i) }));
});

test('two background orchestrators are failed and list their ids', async () => {
  const check = await orchestratorCheckWithRows([healthyOrchestratorRow(), healthyOrchestratorRow({ id: 'orch0002', sessionId: 'orch0002-0000-4000-8000-000000000000' })]);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain('orch0001');
  expect(check.detail).toContain('orch0002');
});

test('an interactive session with the orchestrator name is failed: rename it', async () => {
  const check = await orchestratorCheckWithRows([healthyOrchestratorRow({ kind: 'interactive' })]);
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('an interactive session is named orchestrator; rename it') }));
});

test('a row with the orchestrator name but no kind is not called interactive: the listing format may have changed', async () => {
  const check = await orchestratorCheckWithRows([healthyOrchestratorRow({ kind: undefined })]);
  expect(check.status).toBe('failed');
  expect(check.detail).not.toContain('rename it');
  expect(check.detail).toMatch(/no kind/);
});

test('a listing that fails is a failed orchestrator check with the error', async () => {
  useFakeClaude({ listingExitCode: 1, listingStandardError: 'supervisor not running\n' });
  expect(await checkNamed(DOCTOR_CHECK_NAMES.orchestrator)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('supervisor not running') }));
});

test('no orchestrator.json is failed and says to run daemon install', async () => {
  rmSync(paths.orchestratorSettingsFile);
  expect(await checkNamed(DOCTOR_CHECK_NAMES.orchestrator)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('claudecommander daemon install') }));
});

// ---- claude login ----

test('auth status exit 0 reports login configured, not verified', async () => {
  const check = await loginCheckWith({ exitCode: 0, standardOutput: '{"loggedIn": true, "authMethod": "oauth_token"}' });
  expect(check).toEqual(expect.objectContaining({ status: 'ok', detail: expect.stringMatching(/configured.*not verified/i) }));
});

test('auth status exit 1 reports not logged in', async () => {
  const check = await loginCheckWith({ exitCode: 1, standardOutput: '{"loggedIn": false, "authMethod": "none"}' });
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('claude auth login') }));
});

test('auth status output that cannot be read is a warning, not ok', async () => {
  expect((await loginCheckWith({ exitCode: 0, standardOutput: 'something else' })).status).toBe('warning');
});

// ---- claudecommander MCP server ----

test('an unauthenticated claudecommander MCP server warns to log in and restart the orchestrator', async () => {
  const check = await mcpServerCheckWith({ exitCode: 0, standardOutput: '  Status: ! Needs authentication' });
  expect(check.status).toBe('warning');
  expect(check.detail).toContain(`claude mcp login ${PLUGIN_MCP_SERVER_NAME}`);
  expect(check.detail).toContain('claude stop orch0001');
});

test('a Dynamic config scope line with Status ✔ Connected is ok', async () => {
  const check = await mcpServerCheckWith({ exitCode: 0, standardOutput: `${PLUGIN_MCP_SERVER_NAME}:\n  Scope: Dynamic config (from command line)\n  Status: ✔ Connected\n  Type: http` });
  expect(check.status).toBe('ok');
});

// The real `claude mcp get <missing>` (2.1.301) exits 1, prints nothing on
// stdout and names the server, quoted, on stderr.
test('mcp get printing "No MCP server named plugin:claudecommander:claudecommander" is failed and says the plugin is not enabled', async () => {
  const check = await mcpServerCheckWith({ exitCode: 1, standardOutput: '', standardError: `No MCP server named "${PLUGIN_MCP_SERVER_NAME}". Configured servers: other-server\n` });
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/plugin.*not (installed|enabled)/i) }));
});

test('the same refusal on stdout is read the same way', async () => {
  const check = await mcpServerCheckWith({ exitCode: 1, standardOutput: `No MCP server named ${PLUGIN_MCP_SERVER_NAME}` });
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/plugin.*not (installed|enabled)/i) }));
});

test('mcp get failing with no Status line is failed and shows stderr', async () => {
  const check = await mcpServerCheckWith({ exitCode: 2, standardOutput: '', standardError: 'something unexpected went wrong\n' });
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('something unexpected went wrong') }));
});

test('a Status line that is neither connected nor needing authentication is failed with that status', async () => {
  const check = await mcpServerCheckWith({ exitCode: 0, standardOutput: `${PLUGIN_MCP_SERVER_NAME}:\n  Status: ✘ Failed to connect\n` });
  expect(check).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('Failed to connect') }));
});

// ---- cross-session inbound and the doorbell's permission mode ----

test('crossSessionInbound accept in the user settings is ok', async () => {
  expect(await checkNamed(DOCTOR_CHECK_NAMES.crossSessionInbound)).toEqual(expect.objectContaining({ status: 'ok', detail: expect.stringContaining(userSettingsFile) }));
});

test('crossSessionInbound other than accept is a warning that explains held doorbells', async () => {
  writeFileSync(userSettingsFile, JSON.stringify({ crossSessionInbound: 'hold' }));
  const check = await checkNamed(DOCTOR_CHECK_NAMES.crossSessionInbound);
  expect(check.status).toBe('warning');
  expect(check.detail).toContain('hold');
  expect(check.detail).toMatch(/rings may be held/);
});

test('crossSessionInbound not set anywhere is a warning', async () => {
  writeFileSync(userSettingsFile, JSON.stringify({}));
  expect(await checkNamed(DOCTOR_CHECK_NAMES.crossSessionInbound)).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringMatching(/not set/) }));
});

test('refuse in the projects root\'s settings wins over accept in the user settings', async () => {
  writeProjectSettings(projectsRoot, 'settings.local.json', { crossSessionInbound: 'refuse' });
  expect(await checkNamed(DOCTOR_CHECK_NAMES.crossSessionInbound)).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringContaining('refuse') }));
});

test('managed settings win over the user settings', async () => {
  mkdirSync(join(managedSettingsFile, '..'), { recursive: true });
  writeFileSync(managedSettingsFile, JSON.stringify({ crossSessionInbound: 'hold' }));
  expect(await checkNamed(DOCTOR_CHECK_NAMES.crossSessionInbound)).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringContaining(managedSettingsFile) }));
});

// Every file under the temporary home: its path, size, modification time and
// a hash of its contents. Doctor must leave all of them exactly as they were.
function snapshotEveryFileUnder(directory: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const filePath = join(entry.parentPath, entry.name);
    const fileStatus = statSync(filePath);
    const contentHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    snapshot[filePath] = `${fileStatus.size} ${fileStatus.mtimeMs} ${contentHash}`;
  }
  return snapshot;
}

test('doctor changes no file under the home: settings, credential, status, ledger and unit entry file stay as they were', async () => {
  writeFileSync(userSettingsFile, JSON.stringify({ crossSessionInbound: 'hold', permissions: { defaultMode: 'bypassPermissions' } }));
  writeProjectSettings(projectsRoot, 'settings.local.json', { crossSessionInbound: 'refuse' });
  writeFileSync(paths.rungMessageIdsFile, JSON.stringify({ rung_message_ids: ['message_a'] }));
  const filesBefore = snapshotEveryFileUnder(temporaryHome);
  expect(Object.keys(filesBefore)).toEqual(expect.arrayContaining([userSettingsFile, paths.machineCredentialFile, paths.daemonStatusFile, paths.rungMessageIdsFile]));
  await runDoctorChecks(doctorDependencies());
  expect(snapshotEveryFileUnder(temporaryHome)).toEqual(filesBefore);
});

test('an orchestrator permission mode or crossSessionInbound different from the doorbell sender is a warning that rings may be held', async () => {
  // The doorbell's `claude -p` takes the user's default mode; the orchestrator is launched in default mode.
  writeFileSync(userSettingsFile, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  const modeMismatch = await checkNamed(DOCTOR_CHECK_NAMES.doorbellPermissionMode);
  expect(modeMismatch.status).toBe('warning');
  expect(modeMismatch.detail).toContain('rings may be held: the orchestrator holds cross-session messages from a session in another permission mode');
  expect(modeMismatch.detail).toContain('bypassPermissions');

  // The orchestrator runs from another directory, whose settings hold messages; the sender's do not.
  writeFileSync(userSettingsFile, JSON.stringify({}));
  const orchestratorDirectory = join(temporaryHome, 'elsewhere');
  writeProjectSettings(orchestratorDirectory, 'settings.json', { crossSessionInbound: 'refuse' });
  useFakeClaude({ sessions: [healthyOrchestratorRow({ cwd: orchestratorDirectory })] });
  const inboundMismatch = await checkNamed(DOCTOR_CHECK_NAMES.doorbellPermissionMode);
  expect(inboundMismatch.status).toBe('warning');
  expect(inboundMismatch.detail).toMatch(/rings may be held/);
});

test('matching permission-mode classes with no crossSessionInbound value are ok for the doorbell', async () => {
  writeFileSync(userSettingsFile, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
  expect((await checkNamed(DOCTOR_CHECK_NAMES.doorbellPermissionMode)).status).toBe('ok');
});

test('accept delivers from any permission mode, so a bypassing doorbell sender is ok then', async () => {
  writeFileSync(userSettingsFile, JSON.stringify({ crossSessionInbound: 'accept', permissions: { defaultMode: 'bypassPermissions' } }));
  expect((await checkNamed(DOCTOR_CHECK_NAMES.doorbellPermissionMode)).status).toBe('ok');
});

test('a settings file that is not JSON is a warning naming it, not a crash', async () => {
  writeFileSync(userSettingsFile, '{broken');
  expect(await checkNamed(DOCTOR_CHECK_NAMES.crossSessionInbound)).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringContaining(userSettingsFile) }));
});

// ---- the doorbell ledger and the last ring ----

test('no rung.json yet is ok', async () => {
  expect((await checkNamed(DOCTOR_CHECK_NAMES.doorbellLedger)).status).toBe('ok');
});

test('a corrupt rung.json is reported as failed, naming the file', async () => {
  writeFileSync(paths.rungMessageIdsFile, '{"rung_message_ids": [1, 2');
  expect(await checkNamed(DOCTOR_CHECK_NAMES.doorbellLedger)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining(paths.rungMessageIdsFile) }));
});

test('a ledger_error in the status file is reported as failed, naming the file', async () => {
  writeStatus({ ...healthyStatus(), ledger_error: 'EACCES: permission denied, open rung.json' });
  const check = await checkNamed(DOCTOR_CHECK_NAMES.doorbellLedger);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain(paths.rungMessageIdsFile);
  expect(check.detail).toContain('EACCES');
});

test('the last doorbell from the status file: rung is ok, refused is a warning with the reason', async () => {
  expect((await checkNamed(DOCTOR_CHECK_NAMES.lastDoorbell)).status).toBe('ok');
  writeStatus({ ...healthyStatus(), last_ring_outcome: { at: NOW - 60_000, kind: 'refused', reason: 'the doorbell was held or refused by the orchestrator session' } });
  expect(await checkNamed(DOCTOR_CHECK_NAMES.lastDoorbell)).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringContaining('held or refused') }));
});

test('no ring yet is ok and says so', async () => {
  writeStatus({ ...healthyStatus(), last_ring_outcome: null });
  expect(await checkNamed(DOCTOR_CHECK_NAMES.lastDoorbell)).toEqual(expect.objectContaining({ status: 'ok', detail: expect.stringContaining('none yet') }));
});

// ---- versions ----

test('Claude Code older than 2.1.292 is reported as failed with the version found', async () => {
  useFakeClaude({ sessions: [healthyOrchestratorRow()], version: { standardOutput: '2.1.291 (Claude Code)\n' } });
  const check = await checkNamed(DOCTOR_CHECK_NAMES.claudeCodeVersion);
  expect(check.status).toBe('failed');
  expect(check.detail).toContain('2.1.291');
  expect(check.detail).toContain('2.1.292');
});

test('Claude Code 2.1.292 exactly is ok, and 2.2.0 is ok', async () => {
  useFakeClaude({ sessions: [healthyOrchestratorRow()], version: { standardOutput: '2.1.292 (Claude Code)\n' } });
  expect((await checkNamed(DOCTOR_CHECK_NAMES.claudeCodeVersion)).status).toBe('ok');
  useFakeClaude({ sessions: [healthyOrchestratorRow()], version: { standardOutput: '2.2.0 (Claude Code)\n' } });
  expect((await checkNamed(DOCTOR_CHECK_NAMES.claudeCodeVersion)).status).toBe('ok');
});

test('claude that cannot be run is a failed version check, not a crash', async () => {
  const check = await checkNamed(DOCTOR_CHECK_NAMES.claudeCodeVersion, { claudeCommandRunner: createClaudeCommandRunner(join(temporaryHome, 'no-such-claude')) });
  expect(check.status).toBe('failed');
});

test('Node older than 22 is failed with the version found', async () => {
  expect(await checkNamed(DOCTOR_CHECK_NAMES.nodeVersion, { nodeVersion: '20.11.1' })).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('20.11.1') }));
  expect((await checkNamed(DOCTOR_CHECK_NAMES.nodeVersion, { nodeVersion: '22.0.0' })).status).toBe('ok');
});

// ---- the command line ----

function cliDependencies(output: { standardOutput: string; standardError: string }, withDoctorEnvironment = true): DaemonCliDependencies {
  const { daemonPaths, fetchFunction, ...doctorEnvironment } = doctorDependencies();
  return {
    writeStandardOutput: (text) => { output.standardOutput += text; },
    writeStandardError: (text) => { output.standardError += text; },
    daemonPaths,
    fetchFunction,
    sleep: async () => { throw new Error('doctor never sleeps'); },
    ...(withDoctorEnvironment ? { doctorEnvironment } : {}),
  };
}

test('daemon doctor prints the report and exits 0 on a healthy machine', async () => {
  const output = { standardOutput: '', standardError: '' };
  expect(await runDaemonCli(['daemon', 'doctor'], cliDependencies(output))).toBe(0);
  expect(output.standardOutput.split('\n').filter((line) => line !== '')).toHaveLength(Object.keys(DOCTOR_CHECK_NAMES).length);
  expect(output.standardError).toBe('');
});

test('daemon doctor exits 1 when a check failed', async () => {
  systemctlAnswers.isActive = { exitCode: 3, standardOutput: 'failed\n', standardError: '' };
  const output = { standardOutput: '', standardError: '' };
  expect(await runDaemonCli(['daemon', 'doctor'], cliDependencies(output))).toBe(1);
  expect(output.standardOutput).toMatch(/^failed +service unit: /m);
});

test('daemon doctor with an option prints its usage and exits 2', async () => {
  const output = { standardOutput: '', standardError: '' };
  expect(await runDaemonCli(['daemon', 'doctor', '--fix'], cliDependencies(output))).toBe(2);
  expect(output.standardError).toMatch(/usage: claudecommander daemon doctor/);
});

test('daemon doctor without a doctor environment fails loudly instead of guessing', async () => {
  const output = { standardOutput: '', standardError: '' };
  expect(await runDaemonCli(['daemon', 'doctor'], cliDependencies(output, false))).toBe(1);
  expect(output.standardError).toMatch(/no doctor environment/);
});

// ---- fix round 1: a strange status file or a throwing check never stops the report ----

function writeRawStatus(statusFields: Record<string, unknown>): void {
  mkdirSync(paths.stateDirectory, { recursive: true });
  writeFileSync(paths.daemonStatusFile, JSON.stringify(statusFields));
  utimesSync(paths.daemonStatusFile, new Date(NOW - 30_000), new Date(NOW - 30_000));
}

test('a status file with only updated_at, loop_running and machine_revoked still gives all 14 lines', async () => {
  writeRawStatus({ updated_at: NOW - 30_000, loop_running: true, machine_revoked: false });
  const checks = await runDoctorChecks(doctorDependencies());
  expect(checks.map((check) => check.name)).toEqual(Object.values(DOCTOR_CHECK_NAMES));
  expect(checks.find((check) => check.name === DOCTOR_CHECK_NAMES.lastDoorbell)).toEqual(expect.objectContaining({ status: 'ok', detail: 'none yet' }));
});

test('wrong-typed status fields are named as unreadable instead of crashing doctor', async () => {
  writeRawStatus({
    updated_at: NOW - 30_000,
    loop_running: 'yes',
    machine_revoked: false,
    orchestrator_error: { nested: true },
    ledger_error: 42,
    last_ring_outcome: { at: 'yesterday', kind: 'rung' },
  });
  useFakeClaude({ sessions: [] });
  const checks = await runDoctorChecks(doctorDependencies());
  expect(checks.map((check) => check.name)).toEqual(Object.values(DOCTOR_CHECK_NAMES));
  const checkByName = (name: string) => checks.find((check) => check.name === name)!;
  expect(checkByName(DOCTOR_CHECK_NAMES.daemonLoop)).toEqual(expect.objectContaining({ status: 'failed', detail: expect.stringContaining('loop_running') }));
  expect(checkByName(DOCTOR_CHECK_NAMES.daemonLoop).detail).toMatch(/orchestrator_error.*ledger_error.*last_ring_outcome|cannot read/);
  expect(checkByName(DOCTOR_CHECK_NAMES.lastDoorbell)).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringContaining('last_ring_outcome') }));
  expect(checkByName(DOCTOR_CHECK_NAMES.doorbellLedger).status).toBe('ok');
  expect(checkByName(DOCTOR_CHECK_NAMES.orchestrator).status).toBe('warning');
});

test('a check that throws becomes one failed line, and every other check still prints', async () => {
  const dependencies = doctorDependencies();
  Object.defineProperty(dependencies, 'nodeVersion', { get: () => { throw new Error('the node version could not be read'); } });
  const checks = await runDoctorChecks(dependencies);
  expect(checks.map((check) => check.name)).toEqual(Object.values(DOCTOR_CHECK_NAMES));
  expect(checks.find((check) => check.name === DOCTOR_CHECK_NAMES.nodeVersion)).toEqual({
    name: DOCTOR_CHECK_NAMES.nodeVersion,
    status: 'failed',
    detail: 'doctor could not run this check: the node version could not be read',
  });
  expect(checks.filter((check) => check.status !== 'ok').map((check) => check.name)).toEqual([DOCTOR_CHECK_NAMES.nodeVersion]);
});

test('an unreadable settings file makes the doorbell permission-mode check a warning naming the file', async () => {
  writeProjectSettings(projectsRoot, 'settings.json', {});
  writeFileSync(join(projectsRoot, '.claude', 'settings.json'), '{broken');
  writeFileSync(userSettingsFile, JSON.stringify({}));
  const check = await checkNamed(DOCTOR_CHECK_NAMES.doorbellPermissionMode);
  expect(check.status).toBe('warning');
  expect(check.detail).toContain(join(projectsRoot, '.claude', 'settings.json'));
});

test('without orchestrator.json the doorbell comparison says it was not checked instead of ok', async () => {
  rmSync(paths.orchestratorSettingsFile);
  const comparison = await checkNamed(DOCTOR_CHECK_NAMES.doorbellPermissionMode);
  expect(comparison).toEqual(expect.objectContaining({ status: 'warning', detail: expect.stringContaining('not checked: orchestrator.json missing') }));
  // The user-level value can still be read, but the detail says project settings were not looked at.
  expect((await checkNamed(DOCTOR_CHECK_NAMES.crossSessionInbound)).detail).toContain('orchestrator.json missing');
});
