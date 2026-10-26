// `claudecommander daemon doctor`: a read-only health check that answers
// "why are my messages not arriving?" (spec 6.2). Each check prints one line:
// ok, warning or failed, and what to do about it.
//
// Doctor only looks. It changes no settings and no files, wakes or launches no
// session, and writes nothing on the backend. What it runs:
//   - claude: `agents --json --all`, `auth status`, `mcp get <server>`, `--version`
//   - systemctl: `--user is-active claudecommander` and `--user show ... ExecStart`
//   - the backend: GET /.well-known/oauth-authorization-server, and POST
//     /daemon/token, which only mints a custom token (doctor throws it away)
//   - files: machine.json, orchestrator.json, status.json, rung.json, the
//     unit's entry file and the Claude Code settings files, all read only
import { execFile } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { type BackgroundSessionEntry, type ClaudeCommandResult, type ClaudeCommandRunner } from './claudeCli.js';
import { firstNonEmptyLine, messageOf } from './commandOutputText.js';
import { readRungMessageIds } from './doorbell.js';
import { readMachineCredential, type MachineCredential } from './machineCredential.js';
import { SYSTEMD_SERVICE_NAME } from './systemdUnit.js';
import { inspectOrchestrator, ORCHESTRATOR_PERMISSION_MODE, readOrchestratorSettings, type OrchestratorInspection, type OrchestratorSettings } from './orchestratorKeeper.js';
import { DEFAULT_BACKEND_URL } from './pairing.js';
import type { DaemonPaths } from './paths.js';
import { PLUGIN_MCP_SERVER_NAME } from './pluginMcpNames.js';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warning' | 'failed';
  detail: string;
}

// Where Claude Code keeps the settings that are not tied to one directory.
// The project ones are read from the directory a session runs in.
export interface ClaudeSettingsFileLocations {
  userSettingsFile: string; // ~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json
  managedSettingsFile: string; // /etc/claude-code/managed-settings.json on Linux
}

// Everything doctor reads from the outside world, passed in so tests use a
// temporary home, test/fakeClaude.mjs, a fake systemctl and a fake backend.
export interface DoctorDependencies {
  daemonPaths: DaemonPaths;
  homeDirectory: string;
  fetchFunction: typeof fetch;
  claudeCommandRunner: ClaudeCommandRunner;
  runSystemctl: (argumentList: string[]) => Promise<ClaudeCommandResult>;
  isProcessAlive: (pid: number) => boolean;
  clock: () => number;
  nodeVersion: string; // process.versions.node, e.g. "22.23.3"
  claudeSettingsFiles: ClaudeSettingsFileLocations;
}

// The check names, in the order the report prints them.
export const DOCTOR_CHECK_NAMES = {
  backend: 'backend',
  machineCredential: 'machine credential',
  serviceUnit: 'service unit',
  serviceEntryFile: 'service entry file',
  daemonLoop: 'daemon loop',
  orchestrator: 'orchestrator',
  claudeLogin: 'claude login',
  mcpServer: 'claudecommander MCP server',
  crossSessionInbound: 'cross-session inbound',
  doorbellPermissionMode: 'doorbell permission mode',
  doorbellLedger: 'doorbell ledger',
  lastDoorbell: 'last doorbell',
  claudeCodeVersion: 'Claude Code version',
  nodeVersion: 'Node version',
} as const;

// One name for the unit, shared with install (systemdUnit.ts).
const SERVICE_UNIT_NAME = SYSTEMD_SERVICE_NAME;
const RESTART_SERVICE_COMMAND = `systemctl --user restart ${SERVICE_UNIT_NAME}`;
const PAIR_AGAIN_ADVICE = `pair again with claudecommander daemon pair --force, then ${RESTART_SERVICE_COMMAND}`;
const REINSTALL_ADVICE = 're-run claudecommander daemon install';

// The daemon writes its status every 60 s; two missed writes means it is gone or stuck.
const LONGEST_HEALTHY_STATUS_AGE_MILLISECONDS = 2 * 60 * 1000;
// The minimum Claude Code version the spec sets for the plugin.
const MINIMUM_CLAUDE_CODE_VERSION: readonly [number, number, number] = [2, 1, 292];
const MINIMUM_NODE_MAJOR_VERSION = 22;
const CLAUDE_QUESTION_TIMEOUT_MILLISECONDS = 30_000;
const BACKEND_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
// A one-line detail never needs more than this from someone else's output.
const MAXIMUM_QUOTED_OUTPUT_CHARACTERS = 300;

// ---- small helpers ----

function okCheck(name: string, detail: string): DoctorCheck {
  return { name, status: 'ok', detail };
}
function warningCheck(name: string, detail: string): DoctorCheck {
  return { name, status: 'warning', detail };
}
function failedCheck(name: string, detail: string): DoctorCheck {
  return { name, status: 'failed', detail };
}

function describeAge(ageMilliseconds: number): string {
  const ageSeconds = Math.max(0, Math.floor(ageMilliseconds / 1000));
  if (ageSeconds < 120) return `${ageSeconds} s`;
  return `${Math.floor(ageSeconds / 60)} min`;
}

async function modificationTimeOf(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- the facts several checks share, each read once ----

type CredentialReading = { kind: 'paired'; credential: MachineCredential } | { kind: 'not_paired' } | { kind: 'unusable'; problem: string };

async function readCredentialForDoctor(paths: DaemonPaths): Promise<CredentialReading> {
  try {
    const credential = await readMachineCredential(paths);
    return credential === null ? { kind: 'not_paired' } : { kind: 'paired', credential };
  } catch (error) {
    // readMachineCredential's own messages name the file, never the secret.
    return { kind: 'unusable', problem: messageOf(error) };
  }
}

// The status fields doctor reads, each checked for its type. The file is
// written by the daemon, but an older daemon, a hand edit or a damaged write
// can leave anything there, and one strange field must not stop the report.
interface DaemonStatusAsDoctorReadsIt {
  updatedAt: number;
  loopRunning: boolean | null; // null when missing or not true/false
  machineRevoked: boolean;
  orchestratorError: string | null;
  ledgerError: string | null;
  // null when no ring is recorded; 'unreadable' when the field is there but has the wrong shape
  lastRingOutcome: { at: number; kind: string; reason: string | null } | null | 'unreadable';
  // Names of fields that were present with a type doctor cannot use.
  unreadableFieldNames: string[];
}

type StatusReading = { kind: 'missing' } | { kind: 'unusable'; problem: string } | { kind: 'read'; status: DaemonStatusAsDoctorReadsIt };

function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

// Text fields: missing or null means "no error"; text is kept; anything else
// is noted as unreadable and treated as no error.
function readOptionalTextField(fields: Record<string, unknown>, fieldName: string, unreadableFieldNames: string[]): string | null {
  const value = fields[fieldName];
  if (typeof value === 'string') return value;
  if (!isMissing(value)) unreadableFieldNames.push(fieldName);
  return null;
}

function readLastRingOutcome(fields: Record<string, unknown>, unreadableFieldNames: string[]): DaemonStatusAsDoctorReadsIt['lastRingOutcome'] {
  const value = fields.last_ring_outcome;
  if (isMissing(value)) return null;
  if (isRecord(value) && typeof value.at === 'number' && typeof value.kind === 'string' && (isMissing(value.reason) || typeof value.reason === 'string')) {
    return { at: value.at, kind: value.kind, reason: typeof value.reason === 'string' ? value.reason : null };
  }
  unreadableFieldNames.push('last_ring_outcome');
  return 'unreadable';
}

function readStatusFields(fields: Record<string, unknown>): DaemonStatusAsDoctorReadsIt {
  const unreadableFieldNames: string[] = [];
  let loopRunning: boolean | null = null;
  if (typeof fields.loop_running === 'boolean') loopRunning = fields.loop_running;
  else unreadableFieldNames.push('loop_running');
  if (!isMissing(fields.machine_revoked) && typeof fields.machine_revoked !== 'boolean') unreadableFieldNames.push('machine_revoked');
  const orchestratorError = readOptionalTextField(fields, 'orchestrator_error', unreadableFieldNames);
  const ledgerError = readOptionalTextField(fields, 'ledger_error', unreadableFieldNames);
  const lastRingOutcome = readLastRingOutcome(fields, unreadableFieldNames);
  return {
    updatedAt: fields.updated_at as number,
    loopRunning,
    machineRevoked: fields.machine_revoked === true,
    orchestratorError,
    ledgerError,
    lastRingOutcome,
    unreadableFieldNames,
  };
}

async function readStatusForDoctor(statusFile: string): Promise<StatusReading> {
  let statusText: string;
  try {
    statusText = await readFile(statusFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unusable', problem: `could not read ${statusFile}: ${messageOf(error)}` };
  }
  let parsedStatus: unknown;
  try {
    parsedStatus = JSON.parse(statusText);
  } catch {
    return { kind: 'unusable', problem: `${statusFile} is not readable JSON` };
  }
  // Without a time doctor cannot judge anything else in the file.
  if (!isRecord(parsedStatus) || typeof parsedStatus.updated_at !== 'number') return { kind: 'unusable', problem: `${statusFile} has no numeric updated_at` };
  return { kind: 'read', status: readStatusFields(parsedStatus) };
}

type SettingsReading = { kind: 'installed'; settings: OrchestratorSettings } | { kind: 'not_installed' } | { kind: 'unusable'; problem: string };

async function readOrchestratorSettingsForDoctor(settingsFile: string): Promise<SettingsReading> {
  try {
    const settings = await readOrchestratorSettings(settingsFile);
    return settings === null ? { kind: 'not_installed' } : { kind: 'installed', settings };
  } catch (error) {
    return { kind: 'unusable', problem: messageOf(error) };
  }
}

type InspectionReading = { kind: 'inspected'; inspection: OrchestratorInspection } | { kind: 'not_inspected'; problem: string };

// The one entry the orchestrator check is about, when there is exactly one.
function singleOrchestratorEntry(inspection: InspectionReading): BackgroundSessionEntry | null {
  if (inspection.kind !== 'inspected') return null;
  const result = inspection.inspection;
  if (result.kind === 'running' || result.kind === 'waiting_for_owner' || result.kind === 'stopped') return result.entry;
  return null;
}

// ---- backend ----

async function checkBackendIsReachable(backendUrl: string, fetchFunction: typeof fetch): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.backend;
  const metadataUrl = `${backendUrl}/.well-known/oauth-authorization-server`;
  try {
    const response = await fetchFunction(metadataUrl, { method: 'GET', signal: AbortSignal.timeout(BACKEND_REQUEST_TIMEOUT_MILLISECONDS) });
    // The body is not needed; reading it lets the connection close cleanly.
    await response.text().catch(() => '');
    if (response.status === 200) return okCheck(name, `${metadataUrl} answered`);
    return failedCheck(name, `${metadataUrl} answered HTTP ${response.status}`);
  } catch {
    return failedCheck(name, `could not reach ${metadataUrl} (offline, or the backend is down)`);
  }
}

// ---- machine credential ----

// /daemon/token only mints a custom token; it writes nothing on the backend.
// The token is never printed or kept: doctor only wants to know it was given.
async function checkMachineCredential(credentialReading: CredentialReading, fetchFunction: typeof fetch): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.machineCredential;
  if (credentialReading.kind === 'not_paired') return failedCheck(name, 'this machine is not paired: run claudecommander daemon pair');
  if (credentialReading.kind === 'unusable') return failedCheck(name, credentialReading.problem);

  const credential = credentialReading.credential;
  const tokenUrl = `${credential.backendUrl}/daemon/token`;
  let response: Response;
  let responseText: string;
  try {
    response = await fetchFunction(tokenUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.machineSecret}` },
      signal: AbortSignal.timeout(BACKEND_REQUEST_TIMEOUT_MILLISECONDS),
    });
    responseText = await response.text();
  } catch {
    return failedCheck(name, `could not reach ${tokenUrl}, so the credential of machine ${credential.machineId} was not checked`);
  }

  // Only the error code is read from a refusal; the body is never quoted.
  let answer: unknown;
  try {
    answer = JSON.parse(responseText);
  } catch {
    answer = null;
  }
  if (response.status === 401) {
    if (isRecord(answer) && answer.error === 'machine_revoked') return failedCheck(name, `machine revoked: machine ${credential.machineId} was revoked; ${PAIR_AGAIN_ADVICE}`);
    return failedCheck(name, `the backend refused the credential of machine ${credential.machineId} (the machine is unknown, or its owner is no longer allowed); ${PAIR_AGAIN_ADVICE}`);
  }
  if (response.status !== 200) return failedCheck(name, `${tokenUrl} answered HTTP ${response.status}`);
  if (!isRecord(answer) || answer.machine_id !== credential.machineId || typeof answer.custom_token !== 'string') {
    return failedCheck(name, `${tokenUrl} gave an unexpected answer`);
  }
  return okCheck(name, `machine ${credential.machineId} is accepted by ${tokenUrl}`);
}

// ---- the service unit ----

// A re-pair writes a new machine.json, but a daemon that stopped on a revoked
// machine exited 0, so systemd did not restart it. A machine.json newer than
// the daemon's last status is the sign that only a restart is missing.
async function machineCredentialIsNewerThanStatus(paths: DaemonPaths): Promise<boolean> {
  const credentialTime = await modificationTimeOf(paths.machineCredentialFile);
  const statusTime = await modificationTimeOf(paths.daemonStatusFile);
  return credentialTime !== null && statusTime !== null && credentialTime > statusTime;
}

async function checkServiceUnit(runSystemctl: DoctorDependencies['runSystemctl'], credentialIsNewerThanStatus: boolean): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.serviceUnit;
  let result: ClaudeCommandResult;
  try {
    result = await runSystemctl(['--user', 'is-active', SERVICE_UNIT_NAME]);
  } catch (error) {
    return failedCheck(name, `could not run systemctl --user is-active ${SERVICE_UNIT_NAME}: ${messageOf(error)}`);
  }
  const unitState = result.standardOutput.trim() || `unknown (exit ${result.exitCode})`;
  if (result.exitCode === 0 && unitState === 'active') return okCheck(name, `${SERVICE_UNIT_NAME} is active`);

  if (credentialIsNewerThanStatus) {
    return failedCheck(name, `${SERVICE_UNIT_NAME} is ${unitState}, and machine.json changed after the daemon last ran: run ${RESTART_SERVICE_COMMAND}`);
  }
  return failedCheck(
    name,
    `${SERVICE_UNIT_NAME} is ${unitState}: start it with systemctl --user start ${SERVICE_UNIT_NAME} (see journalctl --user -u ${SERVICE_UNIT_NAME}); if the unit is not installed, run claudecommander daemon install`,
  );
}

// `systemctl show -p ExecStart --value` prints
//   { path=/usr/bin/node ; argv[]=/usr/bin/node /home/u/.local/share/claudecommander/daemon/cli.js daemon run ; ... }
// The entry file is the argument right after the node executable. Paths with
// spaces are not expected here (Task 22 writes the unit) and would be split.
function readExecStartArguments(showOutput: string): string[] {
  const argvMatch = /argv\[\]=([^;]*)/.exec(showOutput);
  const commandLine = argvMatch === null ? showOutput : argvMatch[1]!;
  return commandLine.trim().split(/\s+/).filter((argument) => argument !== '');
}

function isInsideDirectory(candidatePath: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, candidatePath);
  return pathFromDirectory !== '' && !pathFromDirectory.startsWith('..') && !isAbsolute(pathFromDirectory);
}

export async function checkServiceEntryFile(runSystemctl: DoctorDependencies['runSystemctl'], installedDaemonDirectory: string): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.serviceEntryFile;
  let result: ClaudeCommandResult;
  try {
    result = await runSystemctl(['--user', 'show', SERVICE_UNIT_NAME, '--property=ExecStart', '--value']);
  } catch (error) {
    return failedCheck(name, `could not run systemctl --user show ${SERVICE_UNIT_NAME}: ${messageOf(error)}`);
  }
  if (result.exitCode !== 0) return failedCheck(name, `systemctl --user show ${SERVICE_UNIT_NAME} failed (exit ${result.exitCode}): ${firstNonEmptyLine(result.standardError, MAXIMUM_QUOTED_OUTPUT_CHARACTERS)}`);

  const execStartArguments = readExecStartArguments(result.standardOutput);
  const entryFile = execStartArguments[1];
  if (entryFile === undefined) return failedCheck(name, `the ${SERVICE_UNIT_NAME} unit has no ExecStart entry file (is it installed?); ${REINSTALL_ADVICE}`);

  // A unit that runs the plugin cache directly breaks on the next plugin
  // update, which removes the versioned folder under it.
  if (!isInsideDirectory(entryFile, installedDaemonDirectory)) {
    return failedCheck(name, `the unit runs ${entryFile}, which is not inside ${installedDaemonDirectory}; ${REINSTALL_ADVICE}`);
  }
  try {
    if (!(await stat(entryFile)).isFile()) throw new Error('not a file');
  } catch {
    return failedCheck(name, `the unit runs ${entryFile}, which does not exist; ${REINSTALL_ADVICE}`);
  }
  return okCheck(name, `the unit runs ${entryFile}`);
}

// ---- the daemon loop, judged by how fresh its status file is ----

// loop_running only means "the loop runs and the machine is not revoked". It
// says nothing about the Firestore listener, so it is never shown as that.
function checkDaemonLoop(statusReading: StatusReading, statusFile: string, now: number, credentialIsNewerThanStatus: boolean): DoctorCheck {
  const name = DOCTOR_CHECK_NAMES.daemonLoop;
  if (statusReading.kind === 'missing') {
    return failedCheck(name, `no status file ${statusFile}: the daemon has not run yet, or has not finished its first check (see systemctl --user status ${SERVICE_UNIT_NAME})`);
  }
  if (statusReading.kind === 'unusable') return failedCheck(name, statusReading.problem);

  const status = statusReading.status;
  if (status.machineRevoked) {
    if (credentialIsNewerThanStatus) {
      return failedCheck(name, `the daemon stopped because the machine was revoked, and this machine has been paired again since: run ${RESTART_SERVICE_COMMAND}`);
    }
    return failedCheck(name, `machine revoked: the daemon stopped; ${PAIR_AGAIN_ADVICE}`);
  }

  const statusAge = now - status.updatedAt;
  if (statusAge > LONGEST_HEALTHY_STATUS_AGE_MILLISECONDS) {
    return failedCheck(name, `the daemon last wrote its status ${describeAge(statusAge)} ago (more than 2 min): it is not running or is stuck; see systemctl --user status ${SERVICE_UNIT_NAME}`);
  }
  const unreadableFieldsNote =
    status.unreadableFieldNames.length > 0 ? `; doctor cannot read these status fields and ignored them: ${status.unreadableFieldNames.join(', ')}` : '';
  if (status.loopRunning === null) return failedCheck(name, `the status file has no true/false loop_running${unreadableFieldsNote}`);
  if (!status.loopRunning) return failedCheck(name, `the status file says the daemon loop is not running; see systemctl --user status ${SERVICE_UNIT_NAME}${unreadableFieldsNote}`);
  const loopIsAlive = `the daemon loop is running; status written ${describeAge(statusAge)} ago (this shows the loop is alive, not that the inbox listener is connected)`;
  if (unreadableFieldsNote !== '') return warningCheck(name, `${loopIsAlive}${unreadableFieldsNote}`);
  return okCheck(name, loopIsAlive);
}

// ---- the orchestrator ----

function describeEntries(entries: BackgroundSessionEntry[]): string {
  return entries.map((entry) => entry.id || '(no id)').join(', ');
}

function lastStartErrorSuffix(statusReading: StatusReading): string {
  if (statusReading.kind !== 'read' || statusReading.status.orchestratorError === null) return '';
  return ` (the daemon's last attempt failed: ${statusReading.status.orchestratorError.slice(0, MAXIMUM_QUOTED_OUTPUT_CHARACTERS)})`;
}

function checkOrchestrator(settingsReading: SettingsReading, inspectionReading: InspectionReading, statusReading: StatusReading, settingsFile: string): DoctorCheck {
  const name = DOCTOR_CHECK_NAMES.orchestrator;
  if (settingsReading.kind === 'not_installed') return failedCheck(name, `${settingsFile} does not exist: run claudecommander daemon install`);
  if (settingsReading.kind === 'unusable') return failedCheck(name, settingsReading.problem);
  if (inspectionReading.kind === 'not_inspected') return failedCheck(name, `could not list the sessions: ${inspectionReading.problem}`);

  const sessionName = settingsReading.settings.sessionName;
  const inspection = inspectionReading.inspection;
  switch (inspection.kind) {
    case 'running': {
      const entry = inspection.entry;
      // Task 2 Q2/Q7: a live row that is blocked with no permission prompt is
      // what an expired login looks like (it is ambiguous, hence a warning).
      if (entry.state === 'blocked' && entry.waitingFor === null) {
        return warningCheck(name, `${sessionName} (${entry.id}) is blocked without a permission prompt: its login may have expired; run claude attach ${sessionName} to see`);
      }
      return okCheck(name, `${sessionName} (${entry.id}) is running`);
    }
    case 'waiting_for_owner':
      return warningCheck(name, `${sessionName} (${inspection.entry.id}) is waiting on a ${inspection.entry.waitingFor}: run claude attach ${sessionName} to answer it`);
    case 'stopped':
      return warningCheck(name, `${sessionName} (${inspection.entry.id || 'no id'}) is stopped; the daemon wakes it on the next message${lastStartErrorSuffix(statusReading)}`);
    case 'absent':
      return warningCheck(name, `no background session is named ${sessionName}; the daemon launches it on its next check, within a minute${lastStartErrorSuffix(statusReading)}`);
    case 'duplicated':
      return failedCheck(
        name,
        `${inspection.entries.length} background sessions are named ${sessionName} (${describeEntries(inspection.entries)}), so the daemon rings none of them: keep one and stop the others with claude stop <id>`,
      );
    case 'conflict': {
      // Task 18 carry: a row with no kind at all may mean the listing format
      // changed; calling it interactive would send the owner to rename the
      // wrong thing.
      const interactiveEntries = inspection.entries.filter((entry) => entry.kind === 'interactive');
      if (interactiveEntries.length > 0) {
        return failedCheck(name, `an interactive session is named ${sessionName}; rename it (${describeEntries(interactiveEntries)}), then the daemon launches the orchestrator`);
      }
      const entriesWithoutKind = inspection.entries.filter((entry) => entry.kind === null);
      if (entriesWithoutKind.length > 0) {
        return failedCheck(
          name,
          `a session named ${sessionName} (${describeEntries(entriesWithoutKind)}) has no kind in claude agents --json --all, so it cannot be told apart from a terminal session (the listing format may have changed); the daemon launches and rings nothing while it is there`,
        );
      }
      const otherKinds = [...new Set(inspection.entries.map((entry) => entry.kind))].join(', ');
      return failedCheck(name, `a session named ${sessionName} has kind ${otherKinds}, not background; rename it`);
    }
  }
}

// ---- claude's own login and the MCP server's ----

// Task 2 Q7: `claude auth status` reports a login in doctor's own environment.
// It does not prove the login works, nor that the orchestrator has the same one.
async function checkClaudeLogin(runner: ClaudeCommandRunner, workingDirectory: string): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.claudeLogin;
  let result: ClaudeCommandResult;
  try {
    result = await runner(['auth', 'status'], { workingDirectory, timeoutMilliseconds: CLAUDE_QUESTION_TIMEOUT_MILLISECONDS });
  } catch (error) {
    return failedCheck(name, messageOf(error));
  }
  if (result.exitCode === 1) return failedCheck(name, 'not logged in: run claude auth login');

  let parsedAnswer: unknown;
  try {
    parsedAnswer = JSON.parse(result.standardOutput);
  } catch {
    parsedAnswer = null;
  }
  if (result.exitCode === 0 && isRecord(parsedAnswer) && parsedAnswer.loggedIn === true) {
    return okCheck(name, 'login configured (not verified; this is the login doctor sees, the orchestrator may hold another)');
  }
  return warningCheck(name, `claude auth status gave an answer doctor cannot read (exit ${result.exitCode}); run it yourself to see`);
}

// Task 2 Q3: MCP sign-in is shared with --bg sessions, so a `claude mcp login`
// reaches the orchestrator once it restarts. Only the Status: line is judged;
// a plugin server also prints "Scope: Dynamic config (from command line)".
async function checkMcpServer(runner: ClaudeCommandRunner, workingDirectory: string, orchestratorEntry: BackgroundSessionEntry | null): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.mcpServer;
  let result: ClaudeCommandResult;
  try {
    result = await runner(['mcp', 'get', PLUGIN_MCP_SERVER_NAME], { workingDirectory, timeoutMilliseconds: CLAUDE_QUESTION_TIMEOUT_MILLISECONDS });
  } catch (error) {
    return failedCheck(name, messageOf(error));
  }

  // The real refusal (2.1.301) is on stderr, with the name quoted; stdout is
  // checked too in case a later version moves it.
  if (/No MCP server named/.test(result.standardOutput) || /No MCP server named/.test(result.standardError)) {
    return failedCheck(name, `claude knows no server named ${PLUGIN_MCP_SERVER_NAME}: the claudecommander plugin is not installed or not enabled (see claude plugin list)`);
  }

  const statusLine = result.standardOutput.split('\n').find((line) => /^\s*Status:/.test(line));
  if (statusLine === undefined) {
    if (result.exitCode !== 0) return failedCheck(name, `claude mcp get ${PLUGIN_MCP_SERVER_NAME} failed (exit ${result.exitCode}): ${firstNonEmptyLine(result.standardError, MAXIMUM_QUOTED_OUTPUT_CHARACTERS)}`);
    return warningCheck(name, `claude mcp get ${PLUGIN_MCP_SERVER_NAME} printed no Status: line`);
  }
  const serverStatus = statusLine.replace(/^\s*Status:\s*/, '').trim().slice(0, MAXIMUM_QUOTED_OUTPUT_CHARACTERS);
  if (serverStatus.includes('Needs authentication')) {
    const orchestratorId = orchestratorEntry?.id || "<the orchestrator's id from claude agents>";
    return warningCheck(name, `needs authentication: run claude mcp login ${PLUGIN_MCP_SERVER_NAME}, then claude stop ${orchestratorId} so the daemon wakes it with the token`);
  }
  if (/(^|\s)Connected\b/.test(serverStatus)) return okCheck(name, `${PLUGIN_MCP_SERVER_NAME}: ${serverStatus}`);
  return failedCheck(name, `${PLUGIN_MCP_SERVER_NAME} status is "${serverStatus}"`);
}

// ---- crossSessionInbound and permission modes, from the settings files ----
//
// `claude config get` is not a command in Claude Code 2.1.301 (it is taken as
// a prompt and starts a model turn), so doctor reads the settings files itself.
// It never writes them: changing crossSessionInbound is the owner's decision.

interface SettingsFileReading {
  file: string;
  contents: Record<string, unknown> | null; // null when the file does not exist or cannot be read
  problem: string | null;
}

async function readClaudeSettingsFile(file: string): Promise<SettingsFileReading> {
  let fileText: string;
  try {
    fileText = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, contents: null, problem: null };
    return { file, contents: null, problem: `could not read ${file}: ${messageOf(error)}` };
  }
  try {
    const parsedSettings: unknown = JSON.parse(fileText);
    if (!isRecord(parsedSettings)) throw new Error('not an object');
    return { file, contents: parsedSettings, problem: null };
  } catch {
    return { file, contents: null, problem: `${file} is not readable JSON` };
  }
}

// The settings a session started in `directory` sees, highest precedence first.
interface SettingsForDirectory {
  managed: SettingsFileReading;
  projectLocal: SettingsFileReading | null; // <dir>/.claude/settings.local.json
  project: SettingsFileReading | null; // <dir>/.claude/settings.json
  user: SettingsFileReading;
}

async function readSettingsForDirectory(locations: ClaudeSettingsFileLocations, directory: string | null): Promise<SettingsForDirectory> {
  return {
    managed: await readClaudeSettingsFile(locations.managedSettingsFile),
    projectLocal: directory === null ? null : await readClaudeSettingsFile(join(directory, '.claude', 'settings.local.json')),
    project: directory === null ? null : await readClaudeSettingsFile(join(directory, '.claude', 'settings.json')),
    user: await readClaudeSettingsFile(locations.userSettingsFile),
  };
}

function settingsProblems(settings: SettingsForDirectory): string[] {
  return [settings.managed, settings.projectLocal, settings.project, settings.user].flatMap((reading) => (reading?.problem ? [reading.problem] : []));
}

interface EffectiveSetting {
  value: string | null; // null when no file sets it
  file: string | null;
}

// The Claude Code docs: managed settings win; from project or local settings
// only `refuse` applies (a repository cannot make you accept messages); from
// user settings any value applies.
function effectiveCrossSessionInbound(settings: SettingsForDirectory): EffectiveSetting {
  const valueIn = (reading: SettingsFileReading | null): string | null => {
    const value = reading?.contents?.crossSessionInbound;
    return typeof value === 'string' ? value : null;
  };
  if (valueIn(settings.managed) !== null) return { value: valueIn(settings.managed), file: settings.managed.file };
  for (const projectReading of [settings.projectLocal, settings.project]) {
    if (valueIn(projectReading) === 'refuse') return { value: 'refuse', file: projectReading!.file };
  }
  if (valueIn(settings.user) !== null) return { value: valueIn(settings.user), file: settings.user.file };
  return { value: null, file: null };
}

// The doorbell's `claude -p` has no --permission-mode, so it takes
// permissions.defaultMode from the usual settings precedence, or "default".
function effectiveDefaultPermissionMode(settings: SettingsForDirectory): EffectiveSetting {
  for (const reading of [settings.managed, settings.projectLocal, settings.project, settings.user]) {
    const permissions = reading?.contents?.permissions;
    if (isRecord(permissions) && typeof permissions.defaultMode === 'string') return { value: permissions.defaultMode, file: reading!.file };
  }
  return { value: 'default', file: null };
}

// Cross-session delivery is decided by mode class: a session that bypasses
// permission prompts and one that asks for them hold each other's messages.
function permissionModeClass(permissionMode: string): 'bypassing' | 'prompting' {
  return permissionMode === 'bypassPermissions' ? 'bypassing' : 'prompting';
}

function describeSetting(setting: EffectiveSetting): string {
  return setting.file === null ? `${setting.value ?? 'not set'}` : `${setting.value} (from ${setting.file})`;
}

// Without orchestrator.json doctor does not know the projects root, so only
// the user and managed settings are read; the detail says so.
const PROJECT_SETTINGS_NOT_CHECKED = 'not checked: orchestrator.json missing';

function checkCrossSessionInbound(orchestratorSettings: SettingsForDirectory, projectsRootIsKnown: boolean): DoctorCheck {
  const name = DOCTOR_CHECK_NAMES.crossSessionInbound;
  const inbound = effectiveCrossSessionInbound(orchestratorSettings);
  const problems = settingsProblems(orchestratorSettings);
  if (!projectsRootIsKnown) problems.push(`project settings ${PROJECT_SETTINGS_NOT_CHECKED}`);
  const problemSuffix = problems.length > 0 ? `; ${problems.join('; ')}` : '';
  const neverChanged = 'doctor never changes it; the owner sets it in /config ("Messages from your other sessions")';

  if (inbound.value === 'accept') {
    if (problems.length > 0) return warningCheck(name, `accept (from ${inbound.file}), but ${problems.join('; ')}`);
    return okCheck(name, `accept (from ${inbound.file})`);
  }
  if (inbound.value === null) {
    return warningCheck(name, `crossSessionInbound is not set for the orchestrator: rings may be held when the doorbell runs in another permission mode, and a held ring still looks sent; ${neverChanged}${problemSuffix}`);
  }
  return warningCheck(name, `crossSessionInbound is ${describeSetting(inbound)}: rings may be held, and a held ring still looks sent; ${neverChanged}${problemSuffix}`);
}

function checkDoorbellPermissionMode(orchestratorSettings: SettingsForDirectory, senderSettings: SettingsForDirectory, projectsRootIsKnown: boolean): DoctorCheck {
  const name = DOCTOR_CHECK_NAMES.doorbellPermissionMode;
  // The two sessions run from directories only orchestrator.json names, so
  // comparing only the user settings would say ok without having looked.
  if (!projectsRootIsKnown) return warningCheck(name, `${PROJECT_SETTINGS_NOT_CHECKED}; run claudecommander daemon install`);
  // A settings file doctor cannot read may hold the value that decides, so
  // no comparison is trusted until it is fixed.
  const problems = [...new Set([...settingsProblems(orchestratorSettings), ...settingsProblems(senderSettings)])];
  if (problems.length > 0) return warningCheck(name, `could not compare the orchestrator with the doorbell sender: ${problems.join('; ')}`);
  const heldRingsWarning = 'rings may be held: the orchestrator holds cross-session messages from a session in another permission mode';
  const orchestratorInbound = effectiveCrossSessionInbound(orchestratorSettings);
  const senderInbound = effectiveCrossSessionInbound(senderSettings);
  const senderMode = effectiveDefaultPermissionMode(senderSettings);
  const modes = `orchestrator: ${ORCHESTRATOR_PERMISSION_MODE}, doorbell sender: ${describeSetting(senderMode)}`;

  // The orchestrator may run from another directory than the doorbell (a
  // woken session keeps its own cwd), so their project settings can differ.
  if (orchestratorInbound.value !== senderInbound.value) {
    return warningCheck(
      name,
      `${heldRingsWarning} (crossSessionInbound is ${describeSetting(orchestratorInbound)} where the orchestrator runs, and ${describeSetting(senderInbound)} where the doorbell runs)`,
    );
  }
  // Task 2 Q4: with accept, messages from a bypassing sender were delivered too.
  if (orchestratorInbound.value === 'accept') return okCheck(name, `crossSessionInbound accept delivers whatever the sender's mode (${modes})`);
  if (permissionModeClass(senderMode.value!) !== permissionModeClass(ORCHESTRATOR_PERMISSION_MODE)) return warningCheck(name, `${heldRingsWarning} (${modes})`);
  if (orchestratorInbound.value === null) return okCheck(name, `both ask for permissions, so rings are delivered (${modes})`);
  return warningCheck(name, `${heldRingsWarning}, and crossSessionInbound is ${describeSetting(orchestratorInbound)} (${modes})`);
}

// ---- the doorbell ledger and the last ring ----

async function checkDoorbellLedger(rungMessageIdsFile: string, statusReading: StatusReading): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.doorbellLedger;
  if (statusReading.kind === 'read' && statusReading.status.ledgerError) {
    return failedCheck(name, `${rungMessageIdsFile}: the daemon cannot use it (${statusReading.status.ledgerError.slice(0, MAXIMUM_QUOTED_OUTPUT_CHARACTERS)}); fix or remove it`);
  }
  try {
    const rungMessageIds = await readRungMessageIds(rungMessageIdsFile);
    return okCheck(name, `${rungMessageIdsFile} is readable (${rungMessageIds.length} ids remembered)`);
  } catch (error) {
    const problem = messageOf(error);
    return failedCheck(name, problem.includes(rungMessageIdsFile) ? problem : `${rungMessageIdsFile}: ${problem}`);
  }
}

function checkLastDoorbell(statusReading: StatusReading, now: number): DoctorCheck {
  const name = DOCTOR_CHECK_NAMES.lastDoorbell;
  if (statusReading.kind !== 'read') return warningCheck(name, 'no readable status file to take the last doorbell from');
  const lastRing = statusReading.status.lastRingOutcome;
  if (lastRing === null) return okCheck(name, 'none yet');
  if (lastRing === 'unreadable') return warningCheck(name, 'the status file has a last_ring_outcome doctor cannot read');
  const age = describeAge(now - lastRing.at);
  if (lastRing.kind === 'rung') return okCheck(name, `rung ${age} ago`);
  // A missed ring is recovered when the orchestrator next checks its inbox,
  // so it is a warning, not a failure.
  const reason = lastRing.reason ? `: ${lastRing.reason.slice(0, MAXIMUM_QUOTED_OUTPUT_CHARACTERS)}` : '';
  return warningCheck(name, `${lastRing.kind} ${age} ago${reason}`);
}

// ---- versions ----

function isAtLeast(found: readonly number[], minimum: readonly number[]): boolean {
  for (let position = 0; position < minimum.length; position += 1) {
    const foundPart = found[position] ?? 0;
    if (foundPart !== minimum[position]) return foundPart > minimum[position]!;
  }
  return true;
}

async function checkClaudeCodeVersion(runner: ClaudeCommandRunner, workingDirectory: string): Promise<DoctorCheck> {
  const name = DOCTOR_CHECK_NAMES.claudeCodeVersion;
  const minimumText = MINIMUM_CLAUDE_CODE_VERSION.join('.');
  let result: ClaudeCommandResult;
  try {
    result = await runner(['--version'], { workingDirectory, timeoutMilliseconds: CLAUDE_QUESTION_TIMEOUT_MILLISECONDS });
  } catch (error) {
    return failedCheck(name, messageOf(error));
  }
  const versionMatch = /(\d+)\.(\d+)\.(\d+)/.exec(result.standardOutput);
  if (result.exitCode !== 0 || versionMatch === null) return failedCheck(name, `claude --version gave no version (exit ${result.exitCode}); ${minimumText} or newer is needed`);
  const foundVersion = [Number(versionMatch[1]), Number(versionMatch[2]), Number(versionMatch[3])];
  const foundText = foundVersion.join('.');
  if (!isAtLeast(foundVersion, MINIMUM_CLAUDE_CODE_VERSION)) return failedCheck(name, `Claude Code ${foundText} found; ${minimumText} or newer is needed (claude update)`);
  return okCheck(name, `Claude Code ${foundText}`);
}

function checkNodeVersion(nodeVersion: string): DoctorCheck {
  const name = DOCTOR_CHECK_NAMES.nodeVersion;
  const versionText = nodeVersion.replace(/^v/, '');
  const majorVersion = Number(versionText.split('.')[0]);
  if (!Number.isInteger(majorVersion) || majorVersion < MINIMUM_NODE_MAJOR_VERSION) return failedCheck(name, `Node ${versionText} found; ${MINIMUM_NODE_MAJOR_VERSION} or newer is needed`);
  return okCheck(name, `Node ${versionText}`);
}

// ---- all checks ----

export async function runDoctorChecks(dependencies: DoctorDependencies): Promise<DoctorCheck[]> {
  const paths = dependencies.daemonPaths;
  const runner = dependencies.claudeCommandRunner;
  const now = dependencies.clock();

  // Read each shared fact once, so every check judges the same moment.
  const credentialReading = await readCredentialForDoctor(paths);
  const statusReading = await readStatusForDoctor(paths.daemonStatusFile);
  const settingsReading = await readOrchestratorSettingsForDoctor(paths.orchestratorSettingsFile);
  const credentialIsNewerThanStatus = await machineCredentialIsNewerThanStatus(paths);

  let inspectionReading: InspectionReading = { kind: 'not_inspected', problem: 'the orchestrator settings are missing' };
  if (settingsReading.kind === 'installed') {
    try {
      // Read-only: inspectOrchestrator only lists; it never wakes or launches.
      inspectionReading = { kind: 'inspected', inspection: await inspectOrchestrator(settingsReading.settings, runner, dependencies.isProcessAlive) };
    } catch (error) {
      inspectionReading = { kind: 'not_inspected', problem: messageOf(error) };
    }
  }
  const orchestratorEntry = singleOrchestratorEntry(inspectionReading);
  const projectsRoot = settingsReading.kind === 'installed' ? settingsReading.settings.projectsRoot : null;
  // The orchestrator runs from its row's cwd (a woken session keeps it); the
  // doorbell always runs from the projects root.
  const orchestratorDirectory = orchestratorEntry?.workingDirectory || projectsRoot;
  const orchestratorClaudeSettings = await readSettingsForDirectory(dependencies.claudeSettingsFiles, orchestratorDirectory);
  const doorbellClaudeSettings = await readSettingsForDirectory(dependencies.claudeSettingsFiles, projectsRoot);
  const backendUrl = credentialReading.kind === 'paired' ? credentialReading.credential.backendUrl : DEFAULT_BACKEND_URL;

  const projectsRootIsKnown = projectsRoot !== null;

  // Each check runs on its own: one that throws becomes a failed line, and
  // the rest of the report still prints.
  return [
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.backend, () => checkBackendIsReachable(backendUrl, dependencies.fetchFunction)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.machineCredential, () => checkMachineCredential(credentialReading, dependencies.fetchFunction)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.serviceUnit, () => checkServiceUnit(dependencies.runSystemctl, credentialIsNewerThanStatus)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.serviceEntryFile, () => checkServiceEntryFile(dependencies.runSystemctl, paths.installedDaemonDirectory)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.daemonLoop, () => checkDaemonLoop(statusReading, paths.daemonStatusFile, now, credentialIsNewerThanStatus)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.orchestrator, () => checkOrchestrator(settingsReading, inspectionReading, statusReading, paths.orchestratorSettingsFile)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.claudeLogin, () => checkClaudeLogin(runner, dependencies.homeDirectory)),
    // A project's settings can enable or disable plugins, so the server is
    // looked up from where the orchestrator runs.
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.mcpServer, () => checkMcpServer(runner, projectsRoot ?? dependencies.homeDirectory, orchestratorEntry)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.crossSessionInbound, () => checkCrossSessionInbound(orchestratorClaudeSettings, projectsRootIsKnown)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.doorbellPermissionMode, () =>
      checkDoorbellPermissionMode(orchestratorClaudeSettings, doorbellClaudeSettings, projectsRootIsKnown),
    ),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.doorbellLedger, () => checkDoorbellLedger(paths.rungMessageIdsFile, statusReading)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.lastDoorbell, () => checkLastDoorbell(statusReading, now)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.claudeCodeVersion, () => checkClaudeCodeVersion(runner, dependencies.homeDirectory)),
    await runCheckWithoutCrashing(DOCTOR_CHECK_NAMES.nodeVersion, () => checkNodeVersion(dependencies.nodeVersion)),
  ];
}

// Runs one check and turns anything it throws into a failed line for that
// check. A bug or a strange input in one check must never cost the owner the
// other thirteen lines.
async function runCheckWithoutCrashing(checkName: string, check: () => DoctorCheck | Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await check();
  } catch (error) {
    return failedCheck(checkName, `doctor could not run this check: ${messageOf(error)}`);
  }
}

// One line per check: "<status> <name>: <detail>", the status padded so the
// names line up. A line break in a detail (from someone else's output) is
// turned into a space so a check never spans two lines.
export function formatDoctorReport(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.status.padEnd(8)} ${check.name}: ${check.detail.replace(/\s*[\r\n]+\s*/g, ' ')}\n`).join('');
}

// 1 when anything failed; warnings alone still exit 0.
export function doctorExitCode(checks: DoctorCheck[]): 0 | 1 {
  return checks.some((check) => check.status === 'failed') ? 1 : 0;
}

// ---- the command line ----

// What `daemon doctor` needs beyond the general CLI dependencies.
export type DoctorEnvironment = Omit<DoctorDependencies, 'daemonPaths' | 'fetchFunction'>;

export const DOCTOR_USAGE_TEXT = 'usage: claudecommander daemon doctor\n';
const EXIT_CODE_FAILURE = 1;
const EXIT_CODE_USAGE_ERROR = 2;

export async function runDaemonDoctorSubcommand(
  optionList: readonly string[],
  dependencies: {
    writeStandardOutput: (text: string) => void;
    writeStandardError: (text: string) => void;
    daemonPaths: DaemonPaths;
    fetchFunction: typeof fetch;
    doctorEnvironment?: DoctorEnvironment;
  },
): Promise<number> {
  if (optionList.length > 0) {
    dependencies.writeStandardError(DOCTOR_USAGE_TEXT);
    return EXIT_CODE_USAGE_ERROR;
  }
  if (dependencies.doctorEnvironment === undefined) {
    dependencies.writeStandardError('claudecommander daemon doctor: no doctor environment was given (a bug in the entry point)\n');
    return EXIT_CODE_FAILURE;
  }
  const checks = await runDoctorChecks({ ...dependencies.doctorEnvironment, daemonPaths: dependencies.daemonPaths, fetchFunction: dependencies.fetchFunction });
  dependencies.writeStandardOutput(formatDoctorReport(checks));
  return doctorExitCode(checks);
}

// ---- outside-world helpers for main.ts ----

// Where Claude Code reads its user and managed settings. CLAUDE_CONFIG_DIR
// moves the user ones; an empty or relative value is ignored, as for XDG paths.
export function resolveClaudeSettingsFiles(homeDirectory: string, environment: Record<string, string | undefined>, platform: NodeJS.Platform): ClaudeSettingsFileLocations {
  const configuredDirectory = environment.CLAUDE_CONFIG_DIR;
  const claudeConfigDirectory = configuredDirectory && isAbsolute(configuredDirectory) ? configuredDirectory : join(homeDirectory, '.claude');
  const managedSettingsFile = platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
  return { userSettingsFile: join(claudeConfigDirectory, 'settings.json'), managedSettingsFile };
}

// Doctor only asks questions, which systemctl answers at once.
const SYSTEMCTL_QUESTION_TIMEOUT_MILLISECONDS = 15_000;

// Runs systemctl with the given arguments and no shell. A non-zero exit is a
// normal answer (is-active exits 3 for an inactive unit); only a systemctl
// that cannot be started at all, or that hangs, is an error. Install and
// uninstall pass a longer timeout: a restart or stop waits for the daemon's
// own stop, which may take up to the unit's TimeoutStopSec (180 s).
export function createSystemctlRunner(timeoutMilliseconds: number = SYSTEMCTL_QUESTION_TIMEOUT_MILLISECONDS): DoctorDependencies['runSystemctl'] {
  return (argumentList) =>
    new Promise((resolve, reject) => {
      execFile('systemctl', argumentList, { encoding: 'utf8', timeout: timeoutMilliseconds }, (error, standardOutput, standardError) => {
        if (error === null) return resolve({ exitCode: 0, standardOutput, standardError });
        const exitCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof exitCode === 'number' && !error.killed) return resolve({ exitCode, standardOutput, standardError });
        reject(new Error(error.killed ? `systemctl ${argumentList.join(' ')} did not finish within ${timeoutMilliseconds} ms` : error.message));
      });
    });
}
