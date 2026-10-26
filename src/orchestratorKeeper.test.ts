import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { FAKE_CLAUDE_EXECUTABLE, setUpFakeClaude, type FakeClaude, type FakeClaudeScenario } from '../test/fakeClaudeHarness.js';
import { ClaudeCommandError, createClaudeCommandRunner, type ClaudeCommandRunner } from './claudeCli.js';
import {
  ORCHESTRATOR_ALLOWED_TOOLS,
  OrchestratorStartError,
  buildOrchestratorLaunchArguments,
  buildOrchestratorWakeArguments,
  ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER,
  ensureOrchestratorIsRunning,
  inspectOrchestrator,
  isProcessAlive as isProcessAliveForReal,
  readOrchestratorSettings,
  type OrchestratorSettings,
} from './orchestratorKeeper.js';
import { PLUGIN_MCP_SERVER_NAME, PLUGIN_MCP_TOOL_PREFIX, MCP_SERVER_KEY_IN_MCP_JSON } from './pluginMcpNames.js';

const LIVE_PID = 4242;
const DEAD_PID = 999_999;
// Only LIVE_PID is alive in these tests; the fake gives launched and woken sessions that pid.
const isProcessAlive = (pid: number) => pid === LIVE_PID;

let fakeClaude: FakeClaude | undefined;
let settings: OrchestratorSettings = { sessionName: 'orchestrator', projectsRoot: '/tmp', model: 'sonnet' };
const temporaryDirectories: string[] = [];

afterEach(() => {
  fakeClaude?.removeTemporaryFiles();
  fakeClaude = undefined;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Every runner in this file is the real runner pointed at the fake claude.
function fakeRunnerFor(scenario: FakeClaudeScenario): ClaudeCommandRunner {
  fakeClaude = setUpFakeClaude({ livePid: LIVE_PID, ...scenario });
  settings = { sessionName: 'orchestrator', projectsRoot: fakeClaude.workingDirectory, model: 'sonnet' };
  return createClaudeCommandRunner(FAKE_CLAUDE_EXECUTABLE);
}

const allCalls = () => fakeClaude!.allCalls();
const lastCall = () => fakeClaude!.lastCall();

function row(fields: Record<string, unknown>): Record<string, unknown> {
  // The cwd must exist: a wake runs from the stopped row's own directory.
  return { id: 'abc12345', sessionId: 'session-123', name: 'orchestrator', cwd: tmpdir(), kind: 'background', state: 'done', ...fields };
}
const liveRow = row({ pid: LIVE_PID, status: 'idle', state: 'done' });
const stoppedRow = row({ respawnFlags: ['-n', 'orchestrator', '--model', 'sonnet', '--permission-mode', 'default', '--agent', 'claudecommander:orchestrator', '--allowedTools=SendMessage,ListAgents'] });

const runnerWithRow = (fields: Record<string, unknown>) => fakeRunnerFor({ sessions: [row(fields)] });
const runnerWithOneLiveEntry = () => fakeRunnerFor({ sessions: [liveRow] });

function fakeClaudeRespawnFlagsAfterWake(): unknown {
  return fakeClaude!.currentSessions().find((session) => session.sessionId === 'session-123')!.respawnFlags;
}

const WAKE_CALL_FOR_SESSION_123 = ['--resume', 'session-123', '--bg', expect.any(String)];

// ---- decisions ----

test('one live orchestrator: returns running and runs no launch or wake', async () => {
  const runner = runnerWithOneLiveEntry();
  const state = await ensureOrchestratorIsRunning(settings, runner, () => true);
  expect(state.kind).toBe('running');
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('one stopped orchestrator: wakes it with --resume <sessionId> --bg and no other flags', async () => {
  const runner = fakeRunnerFor({ sessions: [stoppedRow] });
  const state = await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(lastCall()).toEqual(['agents', '--json', '--all']);
  expect(allCalls()[1]).toEqual(WAKE_CALL_FOR_SESSION_123);
  expect(allCalls().filter((call) => call[0] === '--resume')).toHaveLength(1);
  expect(state).toEqual(expect.objectContaining({ kind: 'running' }));
});

function makeTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test("the wake runs from the stopped session's own directory, not the projects root", async () => {
  // `claude --resume` is directory-scoped ("This conversation is from a different directory").
  const sessionDirectory = makeTemporaryDirectory('claudecommander-session-');
  const runner = fakeRunnerFor({ sessions: [{ ...stoppedRow, cwd: sessionDirectory }] });
  const projectsRoot = makeTemporaryDirectory('claudecommander-projects-');
  await ensureOrchestratorIsRunning({ ...settings, projectsRoot }, runner, isProcessAlive);
  expect(allCalls()[1]![0]).toBe('--resume');
  expect(fakeClaude!.currentSessions()[0]!.wokenFromDirectory).toBe(sessionDirectory);
});

test('a stopped row with no cwd is woken from the projects root', async () => {
  const { cwd, ...stoppedRowWithoutDirectory } = stoppedRow;
  void cwd;
  const runner = fakeRunnerFor({ sessions: [stoppedRowWithoutDirectory] });
  const projectsRoot = makeTemporaryDirectory('claudecommander-projects-');
  await ensureOrchestratorIsRunning({ ...settings, projectsRoot }, runner, isProcessAlive);
  expect(fakeClaude!.currentSessions()[0]!.wokenFromDirectory).toBe(projectsRoot);
});

// ---- interactive sessions with the orchestrator's name ----

// The interactive row shape seen in `claude agents --json --all`: pid and status, no id, no state.
function interactiveRow(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { pid: LIVE_PID, cwd: tmpdir(), kind: 'interactive', sessionId: 'interactive-777', name: 'orchestrator', status: 'idle', ...fields };
}

test('only an interactive session has the name: conflict, and nothing is launched', async () => {
  const runner = fakeRunnerFor({ sessions: [interactiveRow()] });
  const state = await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(state.kind).toBe('conflict');
  expect(state.kind === 'conflict' && state.entries.map((entry) => entry.kind)).toEqual(['interactive']);
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('inspectOrchestrator reports conflict for an interactive-only name', async () => {
  const runner = fakeRunnerFor({ sessions: [interactiveRow({ pid: DEAD_PID })] });
  expect((await inspectOrchestrator(settings, runner, isProcessAlive)).kind).toBe('conflict');
});

test('a live background orchestrator plus an interactive session with the same name is running', async () => {
  const runner = fakeRunnerFor({ sessions: [interactiveRow(), liveRow] });
  const state = await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(state).toEqual(expect.objectContaining({ kind: 'running', entry: expect.objectContaining({ kind: 'background', sessionId: 'session-123' }) }));
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('a stopped background orchestrator plus an interactive session with the same name is woken, not a duplicate', async () => {
  const runner = fakeRunnerFor({ sessions: [interactiveRow(), stoppedRow] });
  await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(allCalls()[1]).toEqual(WAKE_CALL_FOR_SESSION_123);
});

test('a row with no kind is not counted as the background orchestrator', async () => {
  const { kind, ...liveRowWithoutKind } = liveRow;
  void kind;
  const runner = fakeRunnerFor({ sessions: [liveRowWithoutKind] });
  expect((await inspectOrchestrator(settings, runner, isProcessAlive)).kind).toBe('conflict');
});

test('no orchestrator at all: launches with an explicit --model and the configured name', async () => {
  const runner = fakeRunnerFor({ sessions: [row({ name: 'someone-else', sessionId: 'session-999' })] });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'claudecommander-projects-'));
  temporaryDirectories.push(projectsRoot);
  const state = await ensureOrchestratorIsRunning({ ...settings, sessionName: 'orchestrator-a', projectsRoot }, runner, isProcessAlive);
  const launchCall = allCalls()[1]!;
  expect(launchCall).toEqual(expect.arrayContaining(['--bg', '-n', 'orchestrator-a', '--model', 'sonnet']));
  expect(launchCall).not.toContain('--bare');
  expect(lastCall()).toEqual(['agents', '--json', '--all']);
  expect(allCalls()).toHaveLength(3);
  expect(state).toEqual(expect.objectContaining({ kind: 'running' }));
  // The launch ran from the projects root.
  expect(fakeClaude!.currentSessions().find((session) => session.name === 'orchestrator-a')!.cwd).toBe(projectsRoot);
});

test('two entries with the configured name: reports duplicated and launches nothing', async () => {
  const runner = fakeRunnerFor({ sessions: [liveRow, row({ id: 'def67890', sessionId: 'session-456' })] });
  const state = await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(state.kind).toBe('duplicated');
  expect(state.kind === 'duplicated' && state.entries.map((entry) => entry.sessionId)).toEqual(['session-123', 'session-456']);
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('two stopped entries with the configured name: duplicated, nothing is woken', async () => {
  const runner = fakeRunnerFor({ sessions: [stoppedRow, row({ id: 'def67890', sessionId: 'session-456' })] });
  const state = await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(state.kind).toBe('duplicated');
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('a quoted and an unquoted entry with the configured name are a duplicate, not a guess', async () => {
  const runner = fakeRunnerFor({ sessions: [liveRow, row({ id: 'def67890', sessionId: 'session-456', name: '"orchestrator"' })] });
  expect((await ensureOrchestratorIsRunning(settings, runner, isProcessAlive)).kind).toBe('duplicated');
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('an entry whose pid is dead counts as stopped and is woken', async () => {
  const runner = fakeRunnerFor({ sessions: [{ ...stoppedRow, pid: DEAD_PID, status: 'idle' }] });
  await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(allCalls()[1]).toEqual(WAKE_CALL_FOR_SESSION_123);
});

test('a name stored with literal quotes is matched after stripping them', async () => {
  const runner = fakeRunnerFor({ sessions: [row({ pid: LIVE_PID, status: 'idle', name: '"orchestrator"' })] });
  const state = await ensureOrchestratorIsRunning(settings, runner, isProcessAlive);
  expect(state.kind).toBe('running');
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('names are matched exactly: a longer or differently cased name is not the orchestrator', async () => {
  const runner = fakeRunnerFor({ sessions: [row({ pid: LIVE_PID, name: 'orchestrator-old' }), row({ pid: LIVE_PID, name: 'Orchestrator' })] });
  expect((await inspectOrchestrator(settings, runner, isProcessAlive)).kind).toBe('absent');
});

test('a missing claude executable fails with a clear spawn error instead of hanging', async () => {
  const runner = createClaudeCommandRunner('/nonexistent/directory/claude');
  await expect(ensureOrchestratorIsRunning({ sessionName: 'orchestrator', projectsRoot: '/', model: 'sonnet' }, runner, isProcessAlive)).rejects.toThrow(/could not run claude: '\/nonexistent\/directory\/claude' was not found/);
});

test('inspectOrchestrator reports stopped and absent without running anything but agents --json --all', async () => {
  const runnerWithStoppedEntry = fakeRunnerFor({ sessions: [stoppedRow] });
  expect((await inspectOrchestrator(settings, runnerWithStoppedEntry, isProcessAlive)).kind).toBe('stopped');
  expect(allCalls().every((call) => call.join(' ') === 'agents --json --all')).toBe(true);
  const runnerWithNoEntry = fakeRunnerFor({ sessions: [] });
  expect((await inspectOrchestrator(settings, runnerWithNoEntry, isProcessAlive)).kind).toBe('absent');
  expect(allCalls().every((call) => call.join(' ') === 'agents --json --all')).toBe(true);
});

test('inspectOrchestrator reports duplicated without waking or launching', async () => {
  const runner = fakeRunnerFor({ sessions: [stoppedRow, row({ id: 'def67890', sessionId: 'session-456' })] });
  expect((await inspectOrchestrator(settings, runner, isProcessAlive)).kind).toBe('duplicated');
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('an orchestrator retired for idleness appears only under --all and is woken, not relaunched', async () => {
  const fakeRunner = fakeRunnerFor({
    plainListing: [],
    // The retired row as spike 2 Q6 recorded it: kind "background", no pid, no status.
    sessions: [{ id: 'abc12345', cwd: tmpdir(), kind: 'background', sessionId: 'session-123', name: 'orchestrator', state: 'done', respawnFlags: stoppedRow.respawnFlags }],
  });
  await ensureOrchestratorIsRunning(settings, fakeRunner, isProcessAlive);
  expect(allCalls().some((call) => call.includes('-n'))).toBe(false);
  expect(allCalls()[1]).toEqual(WAKE_CALL_FOR_SESSION_123);
  expect(lastCall()).toEqual(['agents', '--json', '--all']);
});

test('status waiting with waitingFor "permission prompt" is waiting_for_owner', async () => {
  expect((await inspectOrchestrator(settings, runnerWithRow({ pid: 7, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }), () => true)).kind).toBe('waiting_for_owner');
});

test('state blocked without waitingFor is not waiting_for_owner', async () => {
  expect((await inspectOrchestrator(settings, runnerWithRow({ pid: 7, status: 'idle', state: 'blocked' }), () => true)).kind).toBe('running');
});

test('status waiting for something other than a permission prompt is running', async () => {
  expect((await inspectOrchestrator(settings, runnerWithRow({ pid: 7, status: 'waiting', waitingFor: 'input', state: 'blocked' }), () => true)).kind).toBe('running');
});

test('a waiting_for_owner orchestrator is left alone by ensure', async () => {
  const runner = runnerWithRow({ pid: LIVE_PID, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' });
  expect((await ensureOrchestratorIsRunning(settings, runner, isProcessAlive)).kind).toBe('waiting_for_owner');
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

test('a waiting row whose pid is dead is stopped, not waiting_for_owner', async () => {
  const runner = runnerWithRow({ pid: DEAD_PID, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' });
  expect((await inspectOrchestrator(settings, runner, isProcessAlive)).kind).toBe('stopped');
});

// ---- launch and wake results ----

test('a launch that exits 0 with the "no agent named" warning on stderr is a success', async () => {
  const fakeRunner = fakeRunnerFor({ sessions: [], launch: { exitCode: 0, standardError: "warning: no agent named 'claudecommander:orchestrator' — spawning with default template\n" } });
  await expect(ensureOrchestratorIsRunning(settings, fakeRunner, () => true)).resolves.toEqual(expect.objectContaining({ kind: 'running' }));
});

test('the wake arguments are exactly --resume <sessionId> --bg <note>, with allowed tools restored from respawnFlags', async () => {
  const fakeRunner = fakeRunnerFor({ sessions: [stoppedRow] });
  await ensureOrchestratorIsRunning(settings, fakeRunner, isProcessAlive);
  const wakeCall = allCalls().find((call) => call[0] === '--resume')!;
  expect(wakeCall).toHaveLength(4);
  expect(wakeCall.some((argument) => argument.startsWith('--allowedTools'))).toBe(false);
  expect(fakeClaudeRespawnFlagsAfterWake()).toEqual(expect.arrayContaining([expect.stringMatching(/^--allowedTools=/)]));
});

test('a launched session is saved with the --allowedTools= flag, so a later wake restores it', async () => {
  const fakeRunner = fakeRunnerFor({ sessions: [] });
  await ensureOrchestratorIsRunning(settings, fakeRunner, isProcessAlive);
  const launched = fakeClaude!.currentSessions().find((session) => session.name === 'orchestrator')!;
  expect(launched.respawnFlags).toContain('--allowedTools=' + ORCHESTRATOR_ALLOWED_TOOLS.join(','));
});

test('a failed wake or launch throws OrchestratorStartError carrying the claude stderr', async () => {
  const wakeRunner = fakeRunnerFor({ sessions: [stoppedRow], wake: { exitCode: 1, standardError: 'Workspace not trusted. Run `claude` in /p once and accept the trust prompt, then retry.\n' } });
  const wakeFailure = ensureOrchestratorIsRunning(settings, wakeRunner, isProcessAlive);
  await expect(wakeFailure).rejects.toBeInstanceOf(OrchestratorStartError);
  await expect(wakeFailure).rejects.toThrow(/Workspace not trusted/);
  await expect(wakeFailure).rejects.toEqual(expect.objectContaining({ claudeStandardError: expect.stringContaining('Workspace not trusted') }));

  const launchRunner = fakeRunnerFor({ sessions: [], launch: { exitCode: 1, standardError: 'Workspace not trusted.\n' } });
  const launchFailure = ensureOrchestratorIsRunning(settings, launchRunner, isProcessAlive);
  await expect(launchFailure).rejects.toBeInstanceOf(OrchestratorStartError);
  await expect(launchFailure).rejects.toThrow(/launching the orchestrator failed \(exit 1\): Workspace not trusted/);
});

test('a launch that succeeds but never shows up in the listing throws instead of launching again', async () => {
  const runner = fakeRunnerFor({ sessions: [], launch: { exitCode: 0, addsNoSession: true } });
  const waitsBetweenChecks: number[] = [];
  const failure = ensureOrchestratorIsRunning(settings, runner, isProcessAlive, { waitBetweenChecks: async (milliseconds) => { waitsBetweenChecks.push(milliseconds); } });
  await expect(failure).rejects.toBeInstanceOf(OrchestratorStartError);
  await expect(failure).rejects.toThrow(/claude reported the orchestrator started, but it is still absent/);
  expect(allCalls().filter((call) => call[0] === '--bg')).toHaveLength(1);
  expect(waitsBetweenChecks.length).toBeGreaterThan(0);
});

test('a wake or launch that times out throws OrchestratorStartError', async () => {
  const fakeRunner = fakeRunnerFor({ sessions: [stoppedRow] });
  // Listing goes to the fake; the wake behaves like a runner that hit its timeout.
  const runnerWhoseStartTimesOut: ClaudeCommandRunner = async (argumentList, options) => {
    if (argumentList[0] === 'agents') return fakeRunner(argumentList, options);
    throw new ClaudeCommandError(`claude ${argumentList.join(' ')} did not finish within ${options.timeoutMilliseconds} ms`);
  };
  const failure = ensureOrchestratorIsRunning(settings, runnerWhoseStartTimesOut, isProcessAlive);
  await expect(failure).rejects.toBeInstanceOf(OrchestratorStartError);
  await expect(failure).rejects.toThrow(/waking the orchestrator failed: claude --resume session-123 --bg .* did not finish within 120000 ms/);
});

test('a wake from a session directory that no longer exists throws OrchestratorStartError', async () => {
  const runner = fakeRunnerFor({ sessions: [{ ...stoppedRow, cwd: '/nonexistent/old-projects' }] });
  await expect(ensureOrchestratorIsRunning(settings, runner, isProcessAlive)).rejects.toThrow(OrchestratorStartError);
});

test('a stopped entry with an unusable sessionId is not woken', async () => {
  const runner = fakeRunnerFor({ sessions: [row({ sessionId: '--dangerously-skip-permissions' })] });
  await expect(ensureOrchestratorIsRunning(settings, runner, isProcessAlive)).rejects.toThrow(/has no usable sessionId/);
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
});

// ---- argument lists ----

test("the launch pre-approves the orchestrator's own MCP tools, SendMessage and ListAgents with --allowedTools=", () => {
  const launchArguments = buildOrchestratorLaunchArguments(settings, { agentFlagHonoured: true });
  const allowedToolsArgument = launchArguments.find((argument) => argument.startsWith('--allowedTools='));
  const allowedTools = allowedToolsArgument!.slice('--allowedTools='.length).split(',');
  for (const toolName of ['get_message', 'check_inbox', 'reply', 'list_unanswered', 'get_thread', 'whoami']) expect(allowedTools).toContain(PLUGIN_MCP_TOOL_PREFIX + toolName);
  expect(allowedTools).toEqual(expect.arrayContaining(['SendMessage', 'ListAgents']));
  expect(allowedTools.some((toolName) => toolName.includes('*'))).toBe(false);
});

test('the allowed tools are exactly the six messaging tools plus SendMessage and ListAgents', () => {
  expect(ORCHESTRATOR_ALLOWED_TOOLS).toEqual([
    'mcp__plugin_claudecommander_claudecommander__get_message',
    'mcp__plugin_claudecommander_claudecommander__check_inbox',
    'mcp__plugin_claudecommander_claudecommander__reply',
    'mcp__plugin_claudecommander_claudecommander__list_unanswered',
    'mcp__plugin_claudecommander_claudecommander__get_thread',
    'mcp__plugin_claudecommander_claudecommander__whoami',
    'SendMessage',
    'ListAgents',
  ]);
});

test('the plugin MCP names are the observed ones', () => {
  expect(MCP_SERVER_KEY_IN_MCP_JSON).toBe('claudecommander');
  expect(PLUGIN_MCP_SERVER_NAME).toBe('plugin:claudecommander:claudecommander');
  expect(PLUGIN_MCP_TOOL_PREFIX).toBe('mcp__plugin_claudecommander_claudecommander__');
});

test('the launch passes --permission-mode default and --agent claudecommander:orchestrator', () => {
  const launchArguments = buildOrchestratorLaunchArguments(settings, { agentFlagHonoured: true });
  expect(launchArguments[launchArguments.indexOf('--permission-mode') + 1]).toBe('default');
  expect(launchArguments[launchArguments.indexOf('--agent') + 1]).toBe('claudecommander:orchestrator');
  expect(launchArguments).not.toContain('--dangerously-skip-permissions');
});

test('the launch arguments are exactly the documented line', () => {
  expect(buildOrchestratorLaunchArguments({ sessionName: 'orchestrator-a', projectsRoot: '/p', model: 'opus' }, { agentFlagHonoured: true })).toEqual([
    '--bg', '-n', 'orchestrator-a', '--model', 'opus', '--permission-mode', 'default', '--agent', 'claudecommander:orchestrator',
    '--allowedTools=' + ORCHESTRATOR_ALLOWED_TOOLS.join(','),
    '--settings=' + JSON.stringify({ permissions: { ask: ['Read', 'Grep', 'Glob', 'LSP', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch'] } }),
    expect.any(String),
  ]);
});

// The owner's rule: an outsider gets no READ access without the owner's yes.
// In default mode Read, Grep, Glob and Agent never prompt inside the working
// directory, so a prompt-text rule alone could be talked around. An "ask"
// rule turns each of them into a permission prompt the owner answers.
test('the launch makes every reading tool ask the owner, through --settings= in the = form', () => {
  const launchArguments = buildOrchestratorLaunchArguments(settings, { agentFlagHonoured: true });
  const settingsArguments = launchArguments.filter((argument) => argument.startsWith('--settings'));
  expect(settingsArguments).toHaveLength(1);
  expect(settingsArguments[0]!.startsWith('--settings=')).toBe(true);
  expect(launchArguments).not.toContain('--settings');
  const launchSettings = JSON.parse(settingsArguments[0]!.slice('--settings='.length));
  expect(launchSettings).toEqual({ permissions: { ask: ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER } });
  expect(ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER).toEqual(['Read', 'Grep', 'Glob', 'LSP', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch']);
  // Read-only Bash commands (cat, grep, ls, ...) run without a prompt in every
  // mode unless Bash itself has an ask rule, so Bash must be on the list.
  expect(ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER).toContain('Bash');
  // NotebookRead is not a current Claude Code tool; naming it may warn.
  expect(ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER).not.toContain('NotebookRead');
  // No reading tool is also pre-approved.
  for (const toolName of ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER) expect(ORCHESTRATOR_ALLOWED_TOOLS as readonly string[]).not.toContain(toolName);
});

test('the ask settings are saved with a launched session, so a later wake restores them', async () => {
  const askSettingsArgument = '--settings=' + JSON.stringify({ permissions: { ask: ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER } });
  const launchRunner = fakeRunnerFor({ sessions: [] });
  await ensureOrchestratorIsRunning(settings, launchRunner, isProcessAlive);
  const launched = fakeClaude!.currentSessions().find((session) => session.name === 'orchestrator')!;
  expect(launched.respawnFlags).toContain(askSettingsArgument);
});

test('a wake adds no --settings flag and the saved ask settings come back from respawnFlags', async () => {
  const askSettingsArgument = '--settings=' + JSON.stringify({ permissions: { ask: ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER } });
  const wakeRunner = fakeRunnerFor({ sessions: [{ ...stoppedRow, respawnFlags: [...(stoppedRow.respawnFlags as string[]), askSettingsArgument] }] });
  await ensureOrchestratorIsRunning(settings, wakeRunner, isProcessAlive);
  const wakeCall = allCalls().find((call) => call[0] === '--resume')!;
  expect(wakeCall.some((argument) => argument.startsWith('--settings'))).toBe(false);
  expect(fakeClaudeRespawnFlagsAfterWake()).toContain(askSettingsArgument);
});

test('no variadic flag is followed by a separate value, and the startup note is the last argument', () => {
  const launchArguments = buildOrchestratorLaunchArguments(settings, { agentFlagHonoured: true });
  for (const variadicFlag of ['--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--add-dir', '--plugin-dir', '--mcp-config']) expect(launchArguments).not.toContain(variadicFlag);
  expect(launchArguments.at(-1)).toMatch(/orchestrator/i);
  expect(launchArguments.at(-1)!.startsWith('--')).toBe(false);
});

test('when --agent is not proven under --bg, the launch omits it and the startup note loads the orchestrator skill', async () => {
  const launchArguments = buildOrchestratorLaunchArguments(settings, { agentFlagHonoured: false });
  expect(launchArguments).not.toContain('--agent');
  expect(launchArguments.at(-1)).toContain('Load the claudecommander-orchestrator skill and follow it.');
});

test('the wake note always tells the session to load the orchestrator skill', () => {
  expect(buildOrchestratorWakeArguments('session-123').at(-1)).toContain('Load the claudecommander-orchestrator skill and follow it.');
});

test('the wake arguments are exactly --resume, the session id, --bg and the note', () => {
  expect(buildOrchestratorWakeArguments('session-123')).toEqual(['--resume', 'session-123', '--bg', expect.stringContaining('Load the claudecommander-orchestrator skill and follow it.')]);
});

test('a session name or model that could be read as a flag is refused', () => {
  expect(() => buildOrchestratorLaunchArguments({ ...settings, sessionName: '--dangerously-skip-permissions' }, { agentFlagHonoured: true })).toThrow(/session name/);
  expect(() => buildOrchestratorLaunchArguments({ ...settings, sessionName: 'bad\nname' }, { agentFlagHonoured: true })).toThrow(/session name/);
  expect(() => buildOrchestratorLaunchArguments({ ...settings, sessionName: '' }, { agentFlagHonoured: true })).toThrow(/session name/);
  expect(() => buildOrchestratorLaunchArguments({ ...settings, sessionName: 'x'.repeat(65) }, { agentFlagHonoured: true })).toThrow(/session name/);
  expect(() => buildOrchestratorLaunchArguments({ ...settings, model: '--bare' }, { agentFlagHonoured: true })).toThrow(/model/);
  expect(() => buildOrchestratorLaunchArguments({ ...settings, model: 'sonnet thing' }, { agentFlagHonoured: true })).toThrow(/model/);
  expect(() => buildOrchestratorLaunchArguments({ ...settings, model: 'claude-sonnet-4-5[1m]' }, { agentFlagHonoured: true })).not.toThrow();
});

test('a wake for a session id that could be read as a flag is refused', () => {
  expect(() => buildOrchestratorWakeArguments('--bare')).toThrow(/sessionId/);
  expect(() => buildOrchestratorWakeArguments('')).toThrow(/sessionId/);
});

// ---- settings file and pid check ----

function writeSettingsFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'claudecommander-settings-'));
  temporaryDirectories.push(directory);
  const settingsFile = join(directory, 'orchestrator.json');
  writeFileSync(settingsFile, contents);
  return settingsFile;
}

test('readOrchestratorSettings reads the file install writes', async () => {
  const settingsFile = writeSettingsFile(JSON.stringify({ sessionName: 'orchestrator-a', projectsRoot: '/home/me/projects', model: 'opus' }));
  expect(await readOrchestratorSettings(settingsFile)).toEqual({ sessionName: 'orchestrator-a', projectsRoot: '/home/me/projects', model: 'opus' });
});

test('readOrchestratorSettings defaults the name to orchestrator and the model to sonnet', async () => {
  const settingsFile = writeSettingsFile(JSON.stringify({ projectsRoot: '/home/me/projects' }));
  expect(await readOrchestratorSettings(settingsFile)).toEqual({ sessionName: 'orchestrator', projectsRoot: '/home/me/projects', model: 'sonnet' });
});

test('readOrchestratorSettings returns null when the file does not exist', async () => {
  expect(await readOrchestratorSettings('/nonexistent/orchestrator.json')).toBeNull();
});

test('readOrchestratorSettings refuses a damaged file, a relative projects root and a flag-like name', async () => {
  await expect(readOrchestratorSettings(writeSettingsFile('{not json'))).rejects.toThrow(/is damaged/);
  await expect(readOrchestratorSettings(writeSettingsFile(JSON.stringify({ sessionName: 'orchestrator' })))).rejects.toThrow(/projectsRoot/);
  await expect(readOrchestratorSettings(writeSettingsFile(JSON.stringify({ projectsRoot: 'projects' })))).rejects.toThrow(/projectsRoot/);
  await expect(readOrchestratorSettings(writeSettingsFile(JSON.stringify({ projectsRoot: '/p', sessionName: '-x' })))).rejects.toThrow(/session name/);
});

test('readOrchestratorSettings refuses a sessionName or model that is present but not a string', async () => {
  await expect(readOrchestratorSettings(writeSettingsFile(JSON.stringify({ projectsRoot: '/p', sessionName: 5 })))).rejects.toThrow(/is damaged/);
  await expect(readOrchestratorSettings(writeSettingsFile(JSON.stringify({ projectsRoot: '/p', sessionName: null })))).rejects.toThrow(/is damaged/);
  await expect(readOrchestratorSettings(writeSettingsFile(JSON.stringify({ projectsRoot: '/p', model: ['sonnet'] })))).rejects.toThrow(/is damaged/);
});

test('isProcessAlive is true for this process and false for a pid that does not exist', () => {
  expect(isProcessAliveForReal(process.pid)).toBe(true);
  expect(isProcessAliveForReal(2 ** 22 + 12345)).toBe(false);
});
