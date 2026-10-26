// Keeps exactly one background Claude Code session, the orchestrator, alive on
// this machine (spec 6.2 "Keeping the orchestrator alive", 6.3 "Launch").
//
// Every check starts by reading `claude agents --json --all` and picking the
// rows with the configured name:
//   - one live row      -> running (or waiting_for_owner on a permission prompt); nothing else is run
//   - one stopped row   -> wake it: `claude --resume <sessionId> --bg "<wake note>"`, no other flags
//   - no row at all     -> launch it with the full launch line
//   - more than one row -> duplicated: wake nothing, launch nothing, let doctor report it
// Only background rows are the orchestrator. If the name belongs only to
// interactive sessions, that is a conflict: launching would make a second
// session with the name, so nothing is launched and doctor reports it.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { ClaudeCommandError, listBackgroundSessions, type BackgroundSessionEntry, type ClaudeCommandResult, type ClaudeCommandRunner } from './claudeCli.js';
import { firstNonEmptyLine } from './commandOutputText.js';
import { PLUGIN_MCP_TOOL_PREFIX } from './pluginMcpNames.js';

// Task 3 Q9: exact names in --allowedTools= pre-approve plugin MCP tools under
// --bg --permission-mode default. Without them every MCP call prompts and the
// orchestrator parks in waiting_for_owner on its first get_message.
// SendMessage and ListAgents never prompt in default mode (Task 3 Q9); they
// stay in the list as a harmless guard against a future change.
const ORCHESTRATOR_MESSAGING_TOOL_NAMES = ['get_message', 'check_inbox', 'reply', 'list_unanswered', 'get_thread', 'whoami'];
export const ORCHESTRATOR_ALLOWED_TOOLS = [
  ...ORCHESTRATOR_MESSAGING_TOOL_NAMES.map((toolName) => PLUGIN_MCP_TOOL_PREFIX + toolName),
  'SendMessage',
  'ListAgents',
];

// The owner's rule: an outsider gets no READ access without the owner's
// explicit yes. In default mode Read, Grep, Glob and LSP never prompt inside
// the working directory (the projects root), and Claude Code runs a built-in
// set of read-only Bash commands (cat, grep, ls, find, read-only git) with no
// prompt in every mode. So a model talked round by a message could read a
// file and `reply` it with nobody asked. An "ask" rule on each tool that
// reads files, runs commands, searches or starts a subagent makes every use a
// permission prompt in the orchestrator session, which the owner answers with
// `claude attach <name>`; until then the orchestrator waits. Edit, Write and
// NotebookEdit prompt in default mode already; they are listed too, so the
// list says the whole rule and does not depend on the mode.
// Passed inline with --settings= (the "=" form, like --allowedTools=), so it
// is saved in respawnFlags and a wake restores it with no extra flag.
export const ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER = ['Read', 'Grep', 'Glob', 'LSP', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch'];
const ORCHESTRATOR_ASK_SETTINGS_JSON = JSON.stringify({ permissions: { ask: ORCHESTRATOR_TOOLS_THAT_ASK_THE_OWNER } });

// The plugin's agent, which carries the playbook as its system prompt.
const ORCHESTRATOR_AGENT_NAME = 'claudecommander:orchestrator';

// Task 2 Q1 (under --bg) and Task 3 Q5 (installed plugin, no launcher
// warning) proved `--agent claudecommander:orchestrator` is honoured. The
// `false` branch of buildOrchestratorLaunchArguments stays for a regression.
export const PROVEN_LAUNCH_FLAGS = { agentFlagHonoured: true } as const;

const LOAD_ORCHESTRATOR_SKILL_SENTENCE = 'Load the claudecommander-orchestrator skill and follow it.';
// With --agent the playbook is already the system prompt, so the first turn only has to look at the inbox.
const STARTUP_NOTE_WHEN_AGENT_IS_HONOURED = 'You are the claudecommander orchestrator for this machine. Call check_inbox now.';
const STARTUP_NOTE_WITHOUT_AGENT = LOAD_ORCHESTRATOR_SKILL_SENTENCE;
// A woken session re-reads the playbook whichever way it was launched.
const WAKE_NOTE = LOAD_ORCHESTRATOR_SKILL_SENTENCE;

// The orchestrator always runs in this mode: it is on the launch line, and a
// wake restores it from the saved launch flags. Doctor compares it with the
// doorbell sender's mode, because a mode mismatch is how rings get held.
export const ORCHESTRATOR_PERMISSION_MODE = 'default';

export const DEFAULT_ORCHESTRATOR_SESSION_NAME = 'orchestrator';
export const DEFAULT_ORCHESTRATOR_MODEL = 'sonnet';

// A launch prints "Starting background service…" and can take a while the
// first time the supervisor starts.
const START_TIMEOUT_MILLISECONDS = 120_000;
// After a launch or wake the new row may take a moment to appear in the
// listing. Treating that moment as "absent" would launch a second session, so
// the keeper looks a few times before giving up.
const CHECKS_AFTER_START = 5;
const WAIT_BETWEEN_CHECKS_AFTER_START_MILLISECONDS = 1_000;

export interface OrchestratorSettings {
  sessionName: string;
  projectsRoot: string;
  model: string;
}

export type OrchestratorState =
  | { kind: 'running'; entry: BackgroundSessionEntry }
  | { kind: 'waiting_for_owner'; entry: BackgroundSessionEntry }
  | { kind: 'duplicated'; entries: BackgroundSessionEntry[] }
  // No background session has the name, but an interactive one does. Never
  // launch, never ring; doctor says "an interactive session is named <name>; rename it".
  | { kind: 'conflict'; entries: BackgroundSessionEntry[] };

export type OrchestratorInspection =
  | OrchestratorState
  | { kind: 'stopped'; entry: BackgroundSessionEntry } // exactly one entry, with no pid or a dead pid
  | { kind: 'absent' }; // no entry with the configured name, even under --all

// A wake or launch that claude refused, or one that never showed up. The
// message is one line for the log and for doctor; the full stderr is kept too.
export class OrchestratorStartError extends Error {
  override name = 'OrchestratorStartError';
  constructor(message: string, readonly claudeStandardError: string) {
    super(message);
  }
}

// ---- settings ----

// Session names follow the send_message rule (1 to 64 characters, no control
// characters). They also may not start with "-", because the name goes on
// claude's command line after -n and must never be read as a flag.
export function describeSessionNameProblem(sessionName: string): string | null {
  if (sessionName.length < 1 || sessionName.length > 64) return 'must be 1 to 64 characters';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(sessionName)) return 'must not contain control characters';
  if (sessionName.startsWith('-')) return 'must not start with "-"';
  return null;
}

// Model names are aliases ("sonnet") or full ids ("claude-sonnet-4-5[1m]").
export const ACCEPTABLE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

export function checkOrchestratorSettings(settings: OrchestratorSettings): void {
  const sessionNameProblem = describeSessionNameProblem(settings.sessionName);
  if (sessionNameProblem !== null) throw new Error(`the orchestrator session name ${JSON.stringify(settings.sessionName)} ${sessionNameProblem}`);
  if (!ACCEPTABLE_MODEL_PATTERN.test(settings.model)) throw new Error(`the orchestrator model ${JSON.stringify(settings.model)} is not a model name`);
}

// Reads orchestrator.json, written by `daemon install`. Returns null when the
// file does not exist yet (install has not run).
export async function readOrchestratorSettings(settingsFile: string): Promise<OrchestratorSettings | null> {
  let fileText: string;
  try {
    fileText = await readFile(settingsFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let storedSettings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fileText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    storedSettings = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${settingsFile} is damaged; run claudecommander daemon install again`);
  }

  // A missing name or model takes the default; one that is present but is
  // not text means the file was damaged, and is not quietly replaced.
  for (const optionalTextField of ['sessionName', 'model']) {
    if (optionalTextField in storedSettings && typeof storedSettings[optionalTextField] !== 'string') {
      throw new Error(`${settingsFile} is damaged (${optionalTextField} is not text); run claudecommander daemon install again`);
    }
  }
  if (typeof storedSettings.projectsRoot !== 'string' || !isAbsolute(storedSettings.projectsRoot)) {
    throw new Error(`${settingsFile} has no absolute projectsRoot; run claudecommander daemon install again`);
  }
  const settings: OrchestratorSettings = {
    sessionName: typeof storedSettings.sessionName === 'string' ? storedSettings.sessionName : DEFAULT_ORCHESTRATOR_SESSION_NAME,
    projectsRoot: storedSettings.projectsRoot,
    model: typeof storedSettings.model === 'string' ? storedSettings.model : DEFAULT_ORCHESTRATOR_MODEL,
  };
  checkOrchestratorSettings(settings);
  return settings;
}

// ---- argument lists ----

// Every launch flag was proven under --bg by Task 2. The variadic flag is in
// the "=" form so it cannot swallow the startup note, which comes last. The
// only free text on the line is the fixed startup note; nothing a colleague
// wrote ever reaches it.
export function buildOrchestratorLaunchArguments(settings: OrchestratorSettings, provenFlags: { agentFlagHonoured: boolean }): string[] {
  checkOrchestratorSettings(settings);
  const launchArguments = ['--bg', '-n', settings.sessionName, '--model', settings.model, '--permission-mode', ORCHESTRATOR_PERMISSION_MODE];
  if (provenFlags.agentFlagHonoured) launchArguments.push('--agent', ORCHESTRATOR_AGENT_NAME);
  launchArguments.push('--allowedTools=' + ORCHESTRATOR_ALLOWED_TOOLS.join(','));
  launchArguments.push('--settings=' + ORCHESTRATOR_ASK_SETTINGS_JSON);
  launchArguments.push(provenFlags.agentFlagHonoured ? STARTUP_NOTE_WHEN_AGENT_IS_HONOURED : STARTUP_NOTE_WITHOUT_AGENT);
  return launchArguments;
}

// Session ids are UUIDs; the pattern is a little looser but never lets one
// start with "-", so a strange row cannot turn into a flag.
const ACCEPTABLE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isUsableSessionId(sessionId: string): boolean {
  return ACCEPTABLE_SESSION_ID_PATTERN.test(sessionId);
}

// Task 2 Q6: `--resume <sessionId> --bg "<note>"` with no other flags wakes the
// same session with its history and every saved launch flag (respawnFlags,
// including --allowedTools=). Adding any flag would make a copy instead.
export function buildOrchestratorWakeArguments(sessionId: string): string[] {
  if (!isUsableSessionId(sessionId)) throw new Error(`cannot wake a session whose sessionId is ${JSON.stringify(sessionId)}`);
  return ['--resume', sessionId, '--bg', WAKE_NOTE];
}

// ---- inspecting ----

// Signal 0 checks that a process exists without touching it. EPERM means it
// exists but belongs to someone else, which still counts as alive.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Task 2 Q2: the only reliable sign of a permission prompt. `state: "blocked"`
// alone is ambiguous (also a session started with no prompt, or a login that expired).
function isWaitingOnPermissionPrompt(entry: BackgroundSessionEntry): boolean {
  return entry.status === 'waiting' && entry.waitingFor === 'permission prompt';
}

// Read-only: runs only `claude agents --json --all`; never wakes or launches.
// Used by doctor and as the first step of ensureOrchestratorIsRunning.
export async function inspectOrchestrator(
  settings: OrchestratorSettings,
  runner: ClaudeCommandRunner,
  isProcessAlive: (pid: number) => boolean,
): Promise<OrchestratorInspection> {
  const allEntries = await listBackgroundSessions(runner);
  // Exact match after the listing removed any enclosing quotes. Live and
  // stopped rows both count: two rows with the name is a duplicate either way.
  const everyEntryWithTheName = allEntries.filter((entry) => entry.name === settings.sessionName);
  // Only --bg sessions can be the orchestrator. An interactive session with
  // the same name (for example one the owner named by hand) is ignored when a
  // background one exists, and is a conflict when none does.
  const entriesWithOrchestratorName = everyEntryWithTheName.filter((entry) => entry.kind === 'background');

  if (entriesWithOrchestratorName.length === 0) {
    if (everyEntryWithTheName.length > 0) return { kind: 'conflict', entries: everyEntryWithTheName };
    return { kind: 'absent' };
  }
  if (entriesWithOrchestratorName.length > 1) return { kind: 'duplicated', entries: entriesWithOrchestratorName };

  const onlyEntry = entriesWithOrchestratorName[0]!;
  // A row with no pid, or whose pid is gone, is a stopped session.
  const entryIsLive = onlyEntry.pid !== null && isProcessAlive(onlyEntry.pid);
  if (!entryIsLive) return { kind: 'stopped', entry: onlyEntry };
  if (isWaitingOnPermissionPrompt(onlyEntry)) return { kind: 'waiting_for_owner', entry: onlyEntry };
  return { kind: 'running', entry: onlyEntry };
}

// ---- ensuring ----

async function runStartCommand(
  whatIsBeingDone: string,
  startArguments: string[],
  workingDirectory: string,
  runner: ClaudeCommandRunner,
): Promise<void> {
  let result: ClaudeCommandResult;
  try {
    result = await runner(startArguments, { workingDirectory, timeoutMilliseconds: START_TIMEOUT_MILLISECONDS });
  } catch (error) {
    // claude could not be run, or ran past the timeout: still a failed start.
    if (error instanceof ClaudeCommandError) throw new OrchestratorStartError(`${whatIsBeingDone} failed: ${error.message}`, '');
    throw error;
  }
  // The exit code decides. A successful launch may still print a warning on
  // stderr ("no agent named ... spawning with default template", Task 2).
  if (result.exitCode !== 0) {
    throw new OrchestratorStartError(`${whatIsBeingDone} failed (exit ${result.exitCode}): ${firstNonEmptyLine(result.standardError)}`, result.standardError);
  }
}

// Inspect, then wake a stopped orchestrator or launch an absent one, then
// inspect again. Running, waiting_for_owner, duplicated and conflict are returned
// as they are: the first two need nothing, and the last two must not be touched.
export async function ensureOrchestratorIsRunning(
  settings: OrchestratorSettings,
  runner: ClaudeCommandRunner,
  isProcessAlive: (pid: number) => boolean,
  options: { waitBetweenChecks?: (milliseconds: number) => Promise<void> } = {},
): Promise<OrchestratorState> {
  const waitBetweenChecks = options.waitBetweenChecks ?? (async (milliseconds: number) => { await sleepFor(milliseconds); });
  const inspection = await inspectOrchestrator(settings, runner, isProcessAlive);

  if (inspection.kind === 'running' || inspection.kind === 'waiting_for_owner' || inspection.kind === 'duplicated' || inspection.kind === 'conflict') return inspection;

  if (inspection.kind === 'stopped') {
    if (!isUsableSessionId(inspection.entry.sessionId)) {
      throw new OrchestratorStartError(`the stopped orchestrator ${inspection.entry.id || '(no id)'} has no usable sessionId, so it cannot be woken`, '');
    }
    // `claude --resume` only finds a conversation from the directory it was
    // started in, so the wake runs there. projectsRoot is the fallback for a
    // row that does not say.
    const wakeDirectory = inspection.entry.workingDirectory || settings.projectsRoot;
    await runStartCommand('waking the orchestrator', buildOrchestratorWakeArguments(inspection.entry.sessionId), wakeDirectory, runner);
  } else {
    await runStartCommand('launching the orchestrator', buildOrchestratorLaunchArguments(settings, PROVEN_LAUNCH_FLAGS), settings.projectsRoot, runner);
  }

  // Look again until the session shows up live. Each look is only a listing.
  let latestInspection: OrchestratorInspection = inspection;
  for (let checkNumber = 1; checkNumber <= CHECKS_AFTER_START; checkNumber += 1) {
    if (checkNumber > 1) await waitBetweenChecks(WAIT_BETWEEN_CHECKS_AFTER_START_MILLISECONDS);
    latestInspection = await inspectOrchestrator(settings, runner, isProcessAlive);
    if (latestInspection.kind !== 'stopped' && latestInspection.kind !== 'absent') return latestInspection;
  }
  throw new OrchestratorStartError(`claude reported the orchestrator started, but it is still ${latestInspection.kind} in claude agents --json --all`, '');
}
