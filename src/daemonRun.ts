// `claudecommander daemon run` and `daemon status`.
//
// `run` is what the service manager starts. In order, it:
//   1. takes the one-daemon-per-machine lock (daemon.lock), or exits 1;
//   2. waits for machine.json (setup installs the service before pairing, so
//      an unpaired machine must wait, not crash-loop under Restart=on-failure)
//      and for orchestrator.json (written by `daemon install`);
//   3. reads the Firebase web config from the paired backend (or uses the
//      emulator one with --emulators) and connects, retrying passing failures;
//   4. runs the daemon loop until SIGTERM or SIGINT (exit 0), or until the
//      backend revokes the machine (recorded in the status file, exit 0: a
//      restart would only be refused again).
import { readFile } from 'node:fs/promises';
import {
  MachineRevokedError,
  type BackendConnection,
  type ConnectToBackendOptions,
  type PublishedSession,
} from './backendConnection.js';
import { listBackgroundSessions, type BackgroundSessionEntry, type ClaudeCommandRunner } from './claudeCli.js';
import { startDaemonLoop, writeDaemonStatusFile, type DaemonStatus } from './daemonLoop.js';
import { acquireDaemonLock } from './daemonLock.js';
import { createOneShotSendMessageDoorbell, openRungMessageLedger } from './doorbell.js';
import { EMULATOR_FIREBASE_WEB_CONFIG, readFirebaseWebConfigWithCache } from './firebaseWebConfig.js';
import { readMachineCredential, type MachineCredential } from './machineCredential.js';
import { ensureOrchestratorIsRunning, readOrchestratorSettings, type OrchestratorSettings } from './orchestratorKeeper.js';
import type { DaemonPaths } from './paths.js';

// Everything `daemon run` needs from the outside world beyond the general CLI
// dependencies, passed in so tests can use fakes and a fake clock.
export interface DaemonRunEnvironment {
  connectToBackend: (credential: MachineCredential, options: ConnectToBackendOptions) => Promise<BackendConnection>;
  claudeCommandRunner: ClaudeCommandRunner;
  isProcessAlive: (pid: number) => boolean;
  clock: () => number;
  scheduleEvery: (intervalMilliseconds: number, task: () => Promise<void>) => () => void;
  log: (line: string) => void;
  // Resolves on SIGTERM or SIGINT. Called once, when `run` starts.
  waitForStopSignal: () => Promise<void>;
}

export interface DaemonRunCommandDependencies {
  writeStandardOutput: (text: string) => void;
  writeStandardError: (text: string) => void;
  daemonPaths: DaemonPaths;
  fetchFunction: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  daemonRunEnvironment?: DaemonRunEnvironment;
}

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_FAILURE = 1;
const EXIT_CODE_USAGE_ERROR = 2;

export const RUN_USAGE_TEXT = 'usage: claudecommander daemon run [--emulators]\n';

// How often an unpaired (or not yet installed) machine looks for its files.
const WAIT_BETWEEN_SETUP_FILE_CHECKS_MILLISECONDS = 5_000;
// A connection that fails for a passing reason (offline, backend briefly
// down) is tried again after 5 s, doubling up to 5 minutes.
const FIRST_WAIT_BEFORE_RECONNECTING_MILLISECONDS = 5_000;
const LONGEST_WAIT_BEFORE_RECONNECTING_MILLISECONDS = 5 * 60 * 1000;

// The emulator addresses from firebase.json, unless the emulator suite's own
// environment variables say otherwise (firebase emulators:exec sets them).
function emulatorHosts(): { auth: string; firestore: string } {
  return {
    auth: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199'}`,
    firestore: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8199',
  };
}

// ---- the local session list ----

function isWaitingOnPermissionPrompt(entry: BackgroundSessionEntry): boolean {
  return entry.status === 'waiting' && entry.waitingFor === 'permission prompt';
}

// One published entry per row of `claude agents --json --all`. Only a
// background row with the orchestrator's name is the orchestrator (an
// interactive one is a work session, as the keeper sees it). A row with no pid,
// or a dead one, is stopped; the loop leaves stopped work sessions out. The
// full working directory is passed on; the connection publishes only its last folder.
export function publishedSessionsFromListing(
  entries: BackgroundSessionEntry[],
  orchestratorName: string,
  isProcessAlive: (pid: number) => boolean,
): PublishedSession[] {
  return entries.map((entry) => {
    const isLive = entry.pid !== null && isProcessAlive(entry.pid);
    let state: string;
    if (!isLive) state = 'stopped';
    else if (isWaitingOnPermissionPrompt(entry)) state = 'waiting_for_owner';
    else state = entry.state || entry.status || 'running';
    return {
      sessionName: entry.name,
      projectName: entry.workingDirectory,
      state,
      role: entry.name === orchestratorName && entry.kind === 'background' ? 'orchestrator' : 'session',
    };
  });
}

// ---- run ----

interface RunOptions {
  useEmulators: boolean;
}

function parseRunOptions(optionList: readonly string[]): RunOptions | null {
  const runOptions: RunOptions = { useEmulators: false };
  for (const option of optionList) {
    if (option === '--emulators') runOptions.useEmulators = true;
    else return null;
  }
  return runOptions;
}

// What a wait resolves to when SIGTERM or SIGINT arrived first.
type StopRequested = { stopRequested: true };
const STOP_REQUESTED: StopRequested = { stopRequested: true };

export async function runDaemonRunSubcommand(optionList: readonly string[], dependencies: DaemonRunCommandDependencies): Promise<number> {
  const runOptions = parseRunOptions(optionList);
  if (runOptions === null) {
    dependencies.writeStandardError(RUN_USAGE_TEXT);
    return EXIT_CODE_USAGE_ERROR;
  }
  const environment = dependencies.daemonRunEnvironment;
  if (environment === undefined) {
    dependencies.writeStandardError('claudecommander daemon run: no run environment was given (a bug in the entry point)\n');
    return EXIT_CODE_FAILURE;
  }
  const paths = dependencies.daemonPaths;

  let daemonLock;
  try {
    daemonLock = await acquireDaemonLock(paths.daemonLockFile, { log: environment.log });
  } catch (error) {
    dependencies.writeStandardError(`claudecommander daemon run: ${(error as Error).message}\n`);
    return EXIT_CODE_FAILURE;
  }
  if (daemonLock === null) {
    dependencies.writeStandardError(`another claudecommander daemon is already running on this machine (${paths.daemonLockFile})\n`);
    return EXIT_CODE_FAILURE;
  }

  const stopSignal: Promise<StopRequested> = environment.waitForStopSignal().then(() => STOP_REQUESTED);
  try {
    return await runUntilStopped(runOptions, dependencies, environment, stopSignal);
  } finally {
    await daemonLock.release();
  }
}

// Sleeps, but wakes early (with STOP_REQUESTED) on SIGTERM or SIGINT.
async function sleepUnlessStopped(milliseconds: number, dependencies: DaemonRunCommandDependencies, stopSignal: Promise<StopRequested>): Promise<StopRequested | null> {
  return Promise.race([dependencies.sleep(milliseconds).then(() => null), stopSignal]);
}

// Reads a setup file until it exists and can be used. The waiting line is
// logged once; a damaged file's error is logged each time it changes.
async function waitForSetupFile<Contents>(
  readSetupFile: () => Promise<Contents | null>,
  waitingLine: string,
  dependencies: DaemonRunCommandDependencies,
  environment: DaemonRunEnvironment,
  stopSignal: Promise<StopRequested>,
): Promise<Contents | StopRequested> {
  let waitingLineLogged = false;
  let lastErrorLogged: string | null = null;
  for (;;) {
    try {
      const contents = await readSetupFile();
      if (contents !== null) return contents;
      if (!waitingLineLogged) {
        environment.log(waitingLine);
        waitingLineLogged = true;
      }
    } catch (error) {
      const errorText = (error as Error).message;
      if (errorText !== lastErrorLogged) {
        environment.log(`${errorText}; waiting for it to be fixed`);
        lastErrorLogged = errorText;
      }
    }
    if ((await sleepUnlessStopped(WAIT_BETWEEN_SETUP_FILE_CHECKS_MILLISECONDS, dependencies, stopSignal)) !== null) return STOP_REQUESTED;
  }
}

function isStopRequested(value: unknown): value is StopRequested {
  return value === STOP_REQUESTED;
}

async function recordRevocationInStatusFile(credential: MachineCredential, paths: DaemonPaths, environment: DaemonRunEnvironment): Promise<void> {
  const status: DaemonStatus = {
    updated_at: environment.clock(),
    machine_id: credential.machineId,
    backend_url: credential.backendUrl,
    loop_running: false,
    orchestrator_state: null,
    orchestrator_error: null,
    last_ring_outcome: null,
    ledger_error: null,
    machine_revoked: true,
    pending_notice_count: 0,
  };
  try {
    await writeDaemonStatusFile(paths.daemonStatusFile, status);
  } catch (error) {
    environment.log(`could not write the status file ${paths.daemonStatusFile}: ${(error as Error).message}`);
  }
}

// Connects, retrying passing failures with a growing pause. Resolves to the
// connection, to STOP_REQUESTED, or to the MachineRevokedError.
async function connectWithRetries(
  credential: MachineCredential,
  runOptions: RunOptions,
  dependencies: DaemonRunCommandDependencies,
  environment: DaemonRunEnvironment,
  stopSignal: Promise<StopRequested>,
): Promise<BackendConnection | StopRequested | MachineRevokedError> {
  let waitBeforeNextAttempt = FIRST_WAIT_BEFORE_RECONNECTING_MILLISECONDS;
  for (;;) {
    try {
      const firebaseConfig = runOptions.useEmulators
        ? EMULATOR_FIREBASE_WEB_CONFIG
        : await readFirebaseWebConfigWithCache(credential.backendUrl, dependencies.fetchFunction, dependencies.daemonPaths.firebaseWebConfigCacheFile, environment.log);
      return await environment.connectToBackend(credential, {
        fetchFunction: dependencies.fetchFunction,
        firebaseConfig,
        ...(runOptions.useEmulators ? { useEmulators: emulatorHosts() } : {}),
        log: environment.log,
        clock: environment.clock,
      });
    } catch (error) {
      if (error instanceof MachineRevokedError) return error;
      environment.log(`could not connect to ${credential.backendUrl}: ${(error as Error).message}; trying again in ${waitBeforeNextAttempt / 1000} s`);
    }
    if ((await sleepUnlessStopped(waitBeforeNextAttempt, dependencies, stopSignal)) !== null) return STOP_REQUESTED;
    waitBeforeNextAttempt = Math.min(waitBeforeNextAttempt * 2, LONGEST_WAIT_BEFORE_RECONNECTING_MILLISECONDS);
  }
}

async function runUntilStopped(
  runOptions: RunOptions,
  dependencies: DaemonRunCommandDependencies,
  environment: DaemonRunEnvironment,
  stopSignal: Promise<StopRequested>,
): Promise<number> {
  const paths = dependencies.daemonPaths;

  const credential = await waitForSetupFile(() => readMachineCredential(paths), 'not paired yet; waiting for claudecommander daemon pair', dependencies, environment, stopSignal);
  if (isStopRequested(credential)) return EXIT_CODE_SUCCESS;
  const settings = await waitForSetupFile(
    () => readOrchestratorSettings(paths.orchestratorSettingsFile),
    `${paths.orchestratorSettingsFile} does not exist yet; waiting for claudecommander daemon install`,
    dependencies,
    environment,
    stopSignal,
  );
  if (isStopRequested(settings)) return EXIT_CODE_SUCCESS;

  const connected = await connectWithRetries(credential, runOptions, dependencies, environment, stopSignal);
  if (isStopRequested(connected)) return EXIT_CODE_SUCCESS;
  if (connected instanceof MachineRevokedError) {
    environment.log(`${connected.message}; the daemon is not running`);
    await recordRevocationInStatusFile(credential, paths, environment);
    return EXIT_CODE_SUCCESS;
  }

  const connection = connected;
  environment.log(`connected to ${credential.backendUrl} as machine ${credential.machineId}`);
  const daemonLoop = startDaemonLoop(buildDaemonLoopDependencies(connection, credential, settings, paths, environment));
  await Promise.race([stopSignal, daemonLoop.whenMachineRevoked]);
  await daemonLoop.stop();
  await connection.close();
  environment.log('the daemon stopped');
  return EXIT_CODE_SUCCESS;
}

function buildDaemonLoopDependencies(
  connection: BackendConnection,
  credential: MachineCredential,
  settings: OrchestratorSettings,
  paths: DaemonPaths,
  environment: DaemonRunEnvironment,
) {
  const runner = environment.claudeCommandRunner;
  return {
    connection,
    keepOrchestratorRunning: () => ensureOrchestratorIsRunning(settings, runner, environment.isProcessAlive),
    // The doorbell uses the orchestrator's model: the one-shot only has to
    // call SendMessage, and that model is known to be available on this account.
    doorbell: createOneShotSendMessageDoorbell({ runner, orchestratorSessionName: settings.sessionName, workingDirectory: settings.projectsRoot, model: settings.model }),
    ledger: openRungMessageLedger(paths.rungMessageIdsFile),
    listLocalSessions: async () => publishedSessionsFromListing(await listBackgroundSessions(runner), settings.sessionName, environment.isProcessAlive),
    log: environment.log,
    clock: environment.clock,
    scheduleEvery: environment.scheduleEvery,
    daemonStatusFile: paths.daemonStatusFile,
    machineId: credential.machineId,
    backendUrl: credential.backendUrl,
  };
}

// ---- status ----

function formatTime(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

function formatDaemonStatus(status: DaemonStatus): string {
  const lines = [
    `machine id: ${status.machine_id}`,
    `backend: ${status.backend_url}`,
    `updated: ${formatTime(status.updated_at)}`,
    `loop running: ${status.loop_running ? 'yes' : 'no'}`,
    `orchestrator: ${status.orchestrator_state ?? 'not checked yet'}${status.orchestrator_error ? ` (${status.orchestrator_error})` : ''}`,
    `pending notices: ${status.pending_notice_count}`,
  ];
  const lastRing = status.last_ring_outcome;
  if (lastRing === null) lines.push('last ring: none yet');
  else lines.push(`last ring: ${lastRing.kind} at ${formatTime(lastRing.at)}${lastRing.reason ? ` (${lastRing.reason})` : ''}`);
  if (status.ledger_error) lines.push(`ledger error: ${status.ledger_error}`);
  if (status.machine_revoked) lines.push('machine revoked: yes (pair again with claudecommander daemon pair --force)');
  return lines.join('\n') + '\n';
}

export const STATUS_USAGE_TEXT = 'usage: claudecommander daemon status\n';

export async function runDaemonStatusSubcommand(optionList: readonly string[], dependencies: DaemonRunCommandDependencies): Promise<number> {
  if (optionList.length > 0) {
    dependencies.writeStandardError(STATUS_USAGE_TEXT);
    return EXIT_CODE_USAGE_ERROR;
  }
  const statusFile = dependencies.daemonPaths.daemonStatusFile;
  let statusText: string;
  try {
    statusText = await readFile(statusFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      dependencies.writeStandardError(`no daemon status yet (${statusFile}): the daemon has not run, or has not finished its first check\n`);
    } else {
      dependencies.writeStandardError(`could not read ${statusFile}: ${(error as Error).message}\n`);
    }
    return EXIT_CODE_FAILURE;
  }
  let status: DaemonStatus;
  try {
    status = JSON.parse(statusText) as DaemonStatus;
  } catch {
    dependencies.writeStandardError(`${statusFile} is not readable JSON\n`);
    return EXIT_CODE_FAILURE;
  }
  dependencies.writeStandardOutput(formatDaemonStatus(status));
  return EXIT_CODE_SUCCESS;
}
