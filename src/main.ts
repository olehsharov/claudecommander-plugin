// Entry point of the built bundle (dist/cli.js). Kept apart from cli.ts so
// that importing cli.ts in tests never runs the command line.
import { appendFileSync, mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectToBackend } from './backendConnection.js';
import { createClaudeCommandRunner } from './claudeCli.js';
import { runDaemonCli } from './cli.js';
import { createSystemctlRunner, resolveClaudeSettingsFiles } from './doctor.js';
import { isProcessAlive } from './orchestratorKeeper.js';
import { resolveDaemonPaths } from './paths.js';
import { pickXdgBaseDirectories, replaceDirectoryWithCopy } from './systemdUnit.js';

const daemonPaths = resolveDaemonPaths(homedir(), process.env);

// A systemctl restart or stop waits for the daemon's own stop (TimeoutStopSec=180),
// so install and uninstall give systemctl a little longer than that.
const SYSTEMCTL_STATE_CHANGE_TIMEOUT_MILLISECONDS = 240_000;

// Each daemon log line goes to stderr (the service manager's journal) and to
// daemon.log, which doctor and a person debugging can read without the journal.
// Written synchronously: lines are short, and an exit never loses the last ones.
let logFileProblemReported = false;
function logDaemonLine(line: string): void {
  const timestampedLine = `${new Date().toISOString()} ${line}\n`;
  process.stderr.write(timestampedLine);
  try {
    mkdirSync(daemonPaths.stateDirectory, { recursive: true });
    appendFileSync(daemonPaths.logFile, timestampedLine, 'utf8');
  } catch (error) {
    if (!logFileProblemReported) {
      logFileProblemReported = true;
      process.stderr.write(`could not write ${daemonPaths.logFile}: ${(error as Error).message}\n`);
    }
  }
}

// A task that throws must not stop its schedule or crash the daemon.
function scheduleEvery(intervalMilliseconds: number, task: () => Promise<void>): () => void {
  const timer = setInterval(() => {
    task().catch((error: unknown) => logDaemonLine(`a scheduled task failed: ${(error as Error).message}`));
  }, intervalMilliseconds);
  return () => clearInterval(timer);
}

function waitForStopSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  });
}

const commandLineArguments = process.argv.slice(2);
const exitCode = await runDaemonCli(commandLineArguments, {
  writeStandardOutput: (text) => process.stdout.write(text),
  writeStandardError: (text) => process.stderr.write(text),
  daemonPaths,
  fetchFunction: fetch,
  sleep: async (milliseconds) => { await sleepFor(milliseconds); },
  daemonRunEnvironment: {
    connectToBackend,
    // `claude` from the PATH the service was installed with (Task 22).
    claudeCommandRunner: createClaudeCommandRunner('claude'),
    isProcessAlive,
    clock: () => Date.now(),
    scheduleEvery,
    log: logDaemonLine,
    waitForStopSignal,
  },
  // `daemon doctor` only reads: these run claude and systemctl read-only questions.
  doctorEnvironment: {
    homeDirectory: homedir(),
    claudeCommandRunner: createClaudeCommandRunner('claude'),
    runSystemctl: createSystemctlRunner(),
    isProcessAlive,
    clock: () => Date.now(),
    nodeVersion: process.versions.node,
    claudeSettingsFiles: resolveClaudeSettingsFiles(homedir(), process.env, process.platform),
  },
  // `daemon install` copies the dist/ this bundle runs from, and the unit runs
  // this same node with the PATH (and XDG directories) of the shell that ran install.
  serviceInstallEnvironment: {
    homeDirectory: homedir(),
    capturedPath: process.env.PATH ?? '',
    nodeExecutablePath: process.execPath,
    builtDistDirectory: dirname(fileURLToPath(import.meta.url)),
    // The same XDG values daemonPaths was resolved from, so the service finds
    // its files where this shell put them.
    capturedXdgBaseDirectories: pickXdgBaseDirectories(process.env),
    runSystemctl: createSystemctlRunner(SYSTEMCTL_STATE_CHANGE_TIMEOUT_MILLISECONDS),
    writeFile,
    copyDirectory: replaceDirectoryWithCopy,
    removeFile: (filePath) => rm(filePath),
    removeDirectory: (directoryPath) => rm(directoryPath, { recursive: true, force: true }),
  },
});

if (commandLineArguments[0] === 'daemon' && commandLineArguments[1] === 'run') {
  // A stopped daemon must really end, even if some library left a handle
  // open (a lingering socket or timer). Its log lines were written synchronously.
  process.exit(exitCode);
}
// Setting exitCode (instead of calling process.exit) lets pending stdout and
// stderr writes finish before the process ends.
process.exitCode = exitCode;
