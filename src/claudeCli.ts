// Running the `claude` command line from the daemon, and reading its list of
// background sessions.
//
// The runner is a function type so tests can point it at test/fakeClaude.mjs;
// nothing in the tests ever runs the real `claude`.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';

export interface ClaudeCommandResult {
  exitCode: number;
  standardOutput: string;
  standardError: string;
}

export type ClaudeCommandRunner = (
  argumentList: string[],
  options: { workingDirectory: string; timeoutMilliseconds: number },
) => Promise<ClaudeCommandResult>;

// Thrown when `claude` could not be run at all, ran too long, or printed
// something the daemon cannot read. A command that ran and exited non-zero is
// not an error of the runner: its result carries the exit code.
export class ClaudeCommandError extends Error {
  override name = 'ClaudeCommandError';
}

// Output kept from one command. A session listing is a few kilobytes; the cap
// only stops a misbehaving child from growing the daemon's memory without end.
const MAXIMUM_KEPT_OUTPUT_CHARACTERS = 4 * 1024 * 1024;
// After SIGTERM on a timeout, how long to wait before SIGKILL.
const GRACE_BEFORE_FORCED_KILL_MILLISECONDS = 2_000;

function describeCommand(argumentList: string[]): string {
  return ['claude', ...argumentList].join(' ');
}

// ENOENT from spawn means either the executable or the working directory is
// missing; Node does not say which. Looking at the directory tells them apart,
// so the error points at the right thing.
async function explainMissingFile(claudeExecutablePath: string, workingDirectory: string): Promise<string> {
  try {
    const directoryStatus = await stat(workingDirectory);
    if (!directoryStatus.isDirectory()) return `could not run claude: the working directory '${workingDirectory}' is not a directory`;
  } catch {
    return `could not run claude: the working directory '${workingDirectory}' does not exist`;
  }
  return `could not run claude: '${claudeExecutablePath}' was not found; make sure claude is on the daemon's PATH`;
}

export function createClaudeCommandRunner(claudeExecutablePath: string): ClaudeCommandRunner {
  return (argumentList, options) =>
    new Promise<ClaudeCommandResult>((resolve, reject) => {
      let standardOutput = '';
      let standardError = '';
      let settled = false;
      // Set synchronously when spawn fails. Node then still emits 'close'
      // (code -2) a few milliseconds later, while the ENOENT explanation is
      // being worked out; that 'close' must not resolve the call first.
      let spawnFailed = false;
      let forcedKillTimer: NodeJS.Timeout | undefined;

      // No shell: every argument reaches claude exactly as given. stdin is
      // closed, because a --bg launch with a terminal-less stdin is how the
      // daemon runs it, and nothing here ever answers a prompt.
      const child = spawn(claudeExecutablePath, argumentList, {
        cwd: options.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      function settleWith(outcome: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        outcome();
      }

      // Both pipes are always read to the end. A child blocked on a full
      // stderr pipe would never exit, and the daemon would wait forever.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        if (standardOutput.length < MAXIMUM_KEPT_OUTPUT_CHARACTERS) standardOutput += text;
      });
      child.stderr.on('data', (text: string) => {
        if (standardError.length < MAXIMUM_KEPT_OUTPUT_CHARACTERS) standardError += text;
      });

      const timeoutTimer = setTimeout(() => {
        settleWith(() => reject(new ClaudeCommandError(`${describeCommand(argumentList)} did not finish within ${options.timeoutMilliseconds} ms`)));
        child.kill('SIGTERM');
        forcedKillTimer = setTimeout(() => child.kill('SIGKILL'), GRACE_BEFORE_FORCED_KILL_MILLISECONDS);
        forcedKillTimer.unref();
      }, options.timeoutMilliseconds);

      child.on('error', (spawnError: NodeJS.ErrnoException) => {
        spawnFailed = true;
        if (spawnError.code === 'ENOENT') {
          void explainMissingFile(claudeExecutablePath, options.workingDirectory).then((explanation) =>
            settleWith(() => reject(new ClaudeCommandError(explanation))),
          );
          return;
        }
        settleWith(() => reject(new ClaudeCommandError(`could not run claude: ${spawnError.message}`)));
      });

      // 'close' (not 'exit') fires after both pipes are drained, so the
      // output is complete. A child killed by a signal has no exit code; it
      // is reported as a failure exit.
      child.on('close', (exitCode) => {
        if (forcedKillTimer) clearTimeout(forcedKillTimer);
        if (spawnFailed) return;
        settleWith(() => resolve({ exitCode: exitCode ?? 1, standardOutput, standardError }));
      });
    });
}

// One row of `claude agents --json --all`, with only what the daemon uses.
export interface BackgroundSessionEntry {
  id: string; // short id, e.g. "9359e902"
  sessionId: string; // full session id, what `--resume` takes; '' when the row had none
  name: string; // literal enclosing quotes removed
  kind: string | null; // "background" for a --bg session, "interactive" for a terminal one; null when missing
  pid: number | null; // null for a stopped or idle-retired session
  status: string | null; // "idle", "busy", "waiting"; null when stopped
  waitingFor: string | null; // e.g. "permission prompt"
  state: string; // "done", "working", "blocked"; '' when missing
  workingDirectory: string; // the row's cwd
}

const LISTING_ARGUMENTS = ['agents', '--json', '--all'];
const LISTING_TIMEOUT_MILLISECONDS = 30_000;

// Names have been seen stored with literal quotes (`"name": "\"odyssey_delivery\""`),
// apparently when a name was typed with quotes. Exactly one enclosing pair is
// removed; anything else is kept as it is, so two different names never turn
// into the same one by guessing.
function removeEnclosingQuotes(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) return name.slice(1, -1);
  return name;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function positiveWholeNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

// A row with no string name cannot be the orchestrator and cannot be
// published by name, so it is left out. Every other missing field gets an
// empty value instead of dropping the row, so a strange row with the
// orchestrator's name still counts towards "duplicated".
function readListingRow(row: unknown): BackgroundSessionEntry | null {
  if (typeof row !== 'object' || row === null) return null;
  const fields = row as Record<string, unknown>;
  if (typeof fields.name !== 'string') return null;
  return {
    id: stringOrNull(fields.id) ?? '',
    sessionId: stringOrNull(fields.sessionId) ?? '',
    name: removeEnclosingQuotes(fields.name),
    kind: stringOrNull(fields.kind),
    pid: positiveWholeNumberOrNull(fields.pid),
    status: stringOrNull(fields.status),
    waitingFor: stringOrNull(fields.waitingFor),
    state: stringOrNull(fields.state) ?? '',
    workingDirectory: stringOrNull(fields.cwd) ?? '',
  };
}

// Always `--all`: a stopped or idle-retired session appears only there. Read
// without it, a retired orchestrator would look absent, a second one would be
// launched, and the next check would find a duplicate.
export async function listBackgroundSessions(runner: ClaudeCommandRunner): Promise<BackgroundSessionEntry[]> {
  // The listing does not depend on the directory; the home directory always exists.
  const result = await runner([...LISTING_ARGUMENTS], { workingDirectory: homedir(), timeoutMilliseconds: LISTING_TIMEOUT_MILLISECONDS });
  const listingCommand = describeCommand(LISTING_ARGUMENTS);
  if (result.exitCode !== 0) {
    const firstErrorLine = result.standardError.split('\n').find((line) => line.trim() !== '') ?? 'no error output';
    throw new ClaudeCommandError(`${listingCommand} failed (exit ${result.exitCode}): ${firstErrorLine.trim()}`);
  }

  let parsedListing: unknown;
  try {
    parsedListing = JSON.parse(result.standardOutput);
  } catch {
    parsedListing = undefined;
  }
  if (!Array.isArray(parsedListing)) throw new ClaudeCommandError(`${listingCommand} printed something that is not a JSON list`);

  const entries: BackgroundSessionEntry[] = [];
  for (const row of parsedListing) {
    const entry = readListingRow(row);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}
