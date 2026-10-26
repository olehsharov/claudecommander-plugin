// `claudecommander daemon install` and `daemon uninstall`: run the daemon as a
// systemd user service on Linux.
//
// install, in order:
//   1. checks everything it can before changing anything: the orchestrator
//      settings, that the node and entry paths can go on an ExecStart line,
//      that an existing unit file was written by this plugin (or --replace was
//      given), and that the running plugin has a built dist/cli.js;
//   2. copies the plugin's dist/ to the installed daemon directory
//      (~/.local/share/claudecommander/daemon). Plugin cache paths change with
//      every plugin version, so a unit pointing into the cache would break on
//      the next update; re-running install after an update refreshes the copy;
//   3. writes orchestrator.json and the unit file;
//   4. systemctl --user daemon-reload, enable --now, and restart when the
//      service was already running, so a re-install runs the new copy.
//
// The unit carries PATH and the XDG base directories the install shell had
// set, and nothing else from the environment: no tokens, no secrets. The XDG
// ones matter because paths.ts derives every daemon file from them: a shell
// that exports XDG_CONFIG_HOME pairs into that directory, and a daemon started
// without it would look in ~/.config, find no credential and wait forever.
// The daemon reads its credential from machine.json itself.
//
// Which unit files are ours: every unit this plugin writes starts with
// OUR_UNIT_MARKER_LINE. The unit name claudecommander.service is shared with
// an older product, so a unit file without the marker is never overwritten
// (unless install is given --replace) and never stopped or removed by uninstall.
import { chmod, cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ClaudeCommandResult } from './claudeCli.js';
import { firstNonEmptyLine, messageOf } from './commandOutputText.js';
import {
  checkOrchestratorSettings,
  DEFAULT_ORCHESTRATOR_MODEL,
  DEFAULT_ORCHESTRATOR_SESSION_NAME,
  type OrchestratorSettings,
} from './orchestratorKeeper.js';
import type { DaemonPaths } from './paths.js';

// The service name doctor asks systemctl about (doctor.ts imports it from here).
export const SYSTEMD_SERVICE_NAME = 'claudecommander';

// The first line of every unit this plugin writes. Its presence is how install
// and uninstall tell our unit from someone else's with the same name.
export const OUR_UNIT_MARKER_LINE = '# Written by the claudecommander plugin (claudecommander daemon install). Re-run that command instead of editing this file.';

// The daemon's stop waits for an in-flight orchestrator launch or doorbell,
// which can take more than 150 s; systemd's default of 90 s would kill it mid-way.
const STOP_TIMEOUT_SECONDS = 180;

// The file name inside the copied dist/ that the unit runs.
const DAEMON_ENTRY_FILE_NAME = 'cli.js';

export type RunSystemctl = (argumentList: string[]) => Promise<ClaudeCommandResult>;

// Install or uninstall cannot go ahead; the message says why and what to do.
// Thrown before anything has been changed whenever the problem can be seen up front.
export class DaemonServiceRefusal extends Error {
  override name = 'DaemonServiceRefusal';
}

// systemd reads user units from ~/.config/systemd/user. This is computed from
// the home directory passed in, so tests point it at a temporary home.
export function systemdUserUnitFile(homeDirectory: string): string {
  return join(homeDirectory, '.config', 'systemd', 'user', `${SYSTEMD_SERVICE_NAME}.service`);
}

// ---- the unit text ----

// Characters that would change the meaning of an ExecStart line: whitespace
// splits it into more arguments (and doctor splits ExecStart on spaces too),
// quotes and backslashes are unquoted by systemd, $ is variable expansion and
// % is a specifier. Control characters never belong in a path.
function describeExecStartPathProblem(candidatePath: string): string | null {
  if (!isAbsolute(candidatePath)) return 'is not an absolute path';
  if (/\s/.test(candidatePath)) return 'contains a space, which the unit\'s ExecStart line (and doctor, which splits it on spaces) cannot carry';
  if (/["'\\$%;]/.test(candidatePath)) return 'contains a quote, backslash, $, % or ; that systemd would interpret on the ExecStart line';
  if (/[\u0000-\u001f\u007f]/.test(candidatePath)) return 'contains a control character';
  return null;
}

function checkExecStartPath(description: string, candidatePath: string): void {
  const problem = describeExecStartPathProblem(candidatePath);
  if (problem !== null) {
    throw new DaemonServiceRefusal(`the ${description} ${candidatePath} ${problem}; install the daemon from a location whose path has none of these`);
  }
}

// Splits the captured PATH into the entries the unit can carry and the ones it
// cannot. An entry is left out when it is empty or relative (in a service those
// mean "wherever systemd starts the process", which is never what was meant),
// or when it has whitespace, a quote, a backslash or a control character
// (systemd would split or unescape it). One odd entry, such as a Windows
// folder on WSL, should not stop the install.
function splitCapturedPath(capturedPath: string): { keptEntries: string[]; leftOutEntries: string[] } {
  const keptEntries: string[] = [];
  const leftOutEntries: string[] = [];
  for (const entry of capturedPath.split(':')) {
    if (entry === '') continue;
    const entryIsUsable = isAbsolute(entry) && !/[\s"'\\\u0000-\u001f\u007f]/.test(entry);
    if (entryIsUsable) keptEntries.push(entry);
    else leftOutEntries.push(entry);
  }
  return { keptEntries, leftOutEntries };
}

// The XDG variables paths.ts reads. Only these are passed into the unit.
export const XDG_BASE_DIRECTORY_VARIABLES = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME'] as const;
export type XdgBaseDirectoryVariable = (typeof XDG_BASE_DIRECTORY_VARIABLES)[number];
export type XdgBaseDirectories = Partial<Record<XdgBaseDirectoryVariable, string>>;

// The XDG base directories the shell has set to something. An unset or empty
// one gets no line in the unit, so systemd's default (which is also what
// paths.ts falls back to) applies on both sides.
export function pickXdgBaseDirectories(environment: Record<string, string | undefined>): XdgBaseDirectories {
  const pickedDirectories: XdgBaseDirectories = {};
  for (const variableName of XDG_BASE_DIRECTORY_VARIABLES) {
    const value = environment[variableName];
    if (value !== undefined && value !== '') pickedDirectories[variableName] = value;
  }
  return pickedDirectories;
}

// An XDG value goes into the unit as it is, so the daemon resolves exactly the
// directories the shell did. One the unit could not carry faithfully is
// refused rather than changed. A relative value is refused too: paths.ts would
// ignore it in the shell, and the person almost certainly meant something else.
function checkXdgBaseDirectory(variableName: string, value: string): void {
  let problem: string | null = null;
  if (!isAbsolute(value)) problem = 'is not an absolute path';
  else if (/\s/.test(value)) problem = 'contains a space';
  else if (/["'\\$;]/.test(value)) problem = 'contains a quote, backslash, $ or ;';
  else if (/[\u0000-\u001f\u007f]/.test(value)) problem = 'contains a control character';
  if (problem !== null) {
    throw new DaemonServiceRefusal(`${variableName}=${value} ${problem}, so the service cannot be given it; set ${variableName} to a plain absolute path (or unset it) and run install again`);
  }
}

// % starts a specifier in Environment= too; %% is a literal %.
function escapeForEnvironmentLine(value: string): string {
  return value.replaceAll('%', '%%');
}

export function buildSystemdUnitText(options: {
  nodeExecutablePath: string;
  daemonEntryPath: string;
  capturedPath: string;
  xdgBaseDirectories?: XdgBaseDirectories;
}): string {
  checkExecStartPath('node executable', options.nodeExecutablePath);
  checkExecStartPath('daemon entry file', options.daemonEntryPath);
  const pathForUnit = escapeForEnvironmentLine(splitCapturedPath(options.capturedPath).keptEntries.join(':'));
  const xdgEnvironmentLines: string[] = [];
  for (const variableName of XDG_BASE_DIRECTORY_VARIABLES) {
    const value = options.xdgBaseDirectories?.[variableName];
    if (value === undefined || value === '') continue;
    checkXdgBaseDirectory(variableName, value);
    xdgEnvironmentLines.push(`Environment=${variableName}=${escapeForEnvironmentLine(value)}`);
  }
  return [
    OUR_UNIT_MARKER_LINE,
    '[Unit]',
    'Description=claudecommander daemon',
    '',
    '[Service]',
    `ExecStart=${options.nodeExecutablePath} ${options.daemonEntryPath} daemon run`,
    // The PATH install was run with, so the daemon finds `claude` (and node's
    // own tools) the way the installing shell did, and the XDG directories it
    // had set, so the daemon finds its credential where pair wrote it.
    `Environment=PATH=${pathForUnit}`,
    ...xdgEnvironmentLines,
    // A revoked machine exits 0, so on-failure does not crash-loop it.
    'Restart=on-failure',
    'RestartSec=5',
    `TimeoutStopSec=${STOP_TIMEOUT_SECONDS}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ---- small file and systemctl helpers ----

// The file's text, or null when there is no such file.
async function readFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function unitWasWrittenByThisPlugin(unitText: string): boolean {
  return unitText.split('\n').some((line) => line.trim() === OUR_UNIT_MARKER_LINE);
}

// Runs one systemctl command that must succeed; a non-zero exit stops the
// install or uninstall with systemctl's own first error line.
async function runSystemctlOrThrow(runSystemctl: RunSystemctl, argumentList: string[]): Promise<void> {
  const result = await runSystemctl(argumentList);
  if (result.exitCode !== 0) {
    throw new Error(`systemctl ${argumentList.join(' ')} failed (exit ${result.exitCode}): ${firstNonEmptyLine(result.standardError + result.standardOutput, 300)}`);
  }
}

// is-active is a question, not a command: it exits 3 for an inactive unit.
async function serviceIsActive(runSystemctl: RunSystemctl): Promise<boolean> {
  const result = await runSystemctl(['--user', 'is-active', SYSTEMD_SERVICE_NAME]);
  return result.exitCode === 0 && result.standardOutput.trim() === 'active';
}

// Copies a directory over another one, leaving no file of the old one behind.
// Steps:
//   1. remove anything an earlier, interrupted run left in .incoming or .previous;
//   2. copy the new version to .incoming (a failed copy leaves the old one untouched);
//   3. rename the old version aside to .previous, and .incoming into its place.
//      Renames are near-instant, so the target is missing only for a moment
//      rather than for a whole recursive delete;
//   4. remove .previous.
// A daemon that is already running keeps the code it loaded; the restart after
// install picks up the new one.
export async function replaceDirectoryWithCopy(sourceDirectory: string, targetDirectory: string): Promise<void> {
  const incomingDirectory = `${targetDirectory}.incoming`;
  const previousDirectory = `${targetDirectory}.previous`;
  await mkdir(dirname(targetDirectory), { recursive: true });
  await rm(incomingDirectory, { recursive: true, force: true });
  await rm(previousDirectory, { recursive: true, force: true });
  await cp(sourceDirectory, incomingDirectory, { recursive: true });
  try {
    await rename(targetDirectory, previousDirectory);
  } catch (error) {
    // A first install has no old version to move aside.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rename(incomingDirectory, targetDirectory);
  await rm(previousDirectory, { recursive: true, force: true });
}

// Writes the unit to a temporary file in the same directory and renames it
// over the real one, so systemd never reads a half-written unit. The mode is
// set on the temporary file explicitly: writeFile's mode only applies to a new
// file and is narrowed by the umask, and the unit must end up 0644 either way.
async function writeUnitFileAtomically(writeFile: typeof fs.writeFile, unitFile: string, unitText: string): Promise<void> {
  const temporaryUnitFile = `${unitFile}.incoming`;
  await writeFile(temporaryUnitFile, unitText, { encoding: 'utf8', mode: 0o644 });
  await chmod(temporaryUnitFile, 0o644);
  await rename(temporaryUnitFile, unitFile);
}

// ---- install ----

export interface InstallDaemonServiceOptions {
  paths: DaemonPaths;
  homeDirectory: string;
  capturedPath: string;
  nodeExecutablePath: string;
  // The running plugin's dist/, copied to paths.installedDaemonDirectory.
  builtDistDirectory: string;
  // From --projects-root (required), --orchestrator-name and --model; written to orchestrator.json.
  orchestratorSettings: OrchestratorSettings;
  // The install shell's XDG base directories (pickXdgBaseDirectories), passed into the unit.
  capturedXdgBaseDirectories: XdgBaseDirectories;
  // --replace: overwrite a unit file with our name that this plugin did not write.
  replaceUnitWrittenByOthers: boolean;
  runSystemctl: RunSystemctl;
  writeFile: typeof fs.writeFile;
  copyDirectory: (from: string, to: string) => Promise<void>;
}

export interface InstallOutcome {
  unitFile: string;
  // False when install ran from the installed copy itself and so copied nothing.
  copiedDaemon: boolean;
  restartedRunningService: boolean;
  // Entries of the captured PATH the unit could not carry (see splitCapturedPath).
  leftOutPathEntries: string[];
}

function checkSettingsForOrchestratorFile(settings: OrchestratorSettings): void {
  if (!isAbsolute(settings.projectsRoot)) {
    throw new DaemonServiceRefusal(`the projects root ${JSON.stringify(settings.projectsRoot)} is not an absolute path`);
  }
  try {
    checkOrchestratorSettings(settings);
  } catch (error) {
    throw new DaemonServiceRefusal(messageOf(error));
  }
}

async function checkBuiltDaemonExists(builtDistDirectory: string): Promise<void> {
  const builtEntryFile = join(builtDistDirectory, DAEMON_ENTRY_FILE_NAME);
  try {
    if ((await stat(builtEntryFile)).isFile()) return;
  } catch {
    // Reported below.
  }
  throw new DaemonServiceRefusal(`there is no built daemon at ${builtEntryFile} to install`);
}

export async function installDaemonService(options: InstallDaemonServiceOptions): Promise<InstallOutcome> {
  const { paths } = options;
  const unitFile = systemdUserUnitFile(options.homeDirectory);
  const installedEntryFile = join(paths.installedDaemonDirectory, DAEMON_ENTRY_FILE_NAME);

  // 1. Every check that can fail comes before the first change.
  checkSettingsForOrchestratorFile(options.orchestratorSettings);
  checkExecStartPath('node executable', options.nodeExecutablePath);
  checkExecStartPath('installed daemon entry file', installedEntryFile);
  const existingUnitText = await readFileIfPresent(unitFile);
  if (existingUnitText !== null && !unitWasWrittenByThisPlugin(existingUnitText) && !options.replaceUnitWrittenByOthers) {
    throw new DaemonServiceRefusal(
      `${unitFile} already exists and was not written by this plugin (it has no "${OUR_UNIT_MARKER_LINE}" line); ` +
        'it may belong to another program using the same service name. Look at it, then run install again with --replace to overwrite it',
    );
  }
  await checkBuiltDaemonExists(options.builtDistDirectory);
  const unitText = buildSystemdUnitText({
    nodeExecutablePath: options.nodeExecutablePath,
    daemonEntryPath: installedEntryFile,
    capturedPath: options.capturedPath,
    xdgBaseDirectories: options.capturedXdgBaseDirectories,
  });

  // 2. The stable copy. When install is run from the installed copy itself,
  // that copy already is the stable one; copying it over itself would delete it.
  const copiedDaemon = resolve(options.builtDistDirectory) !== resolve(paths.installedDaemonDirectory);
  if (copiedDaemon) {
    await options.copyDirectory(options.builtDistDirectory, paths.installedDaemonDirectory);
  }

  // 3. The orchestrator settings `daemon run` waits for, then the unit.
  const { sessionName, projectsRoot, model } = options.orchestratorSettings;
  await mkdir(paths.configDirectory, { recursive: true });
  await options.writeFile(paths.orchestratorSettingsFile, `${JSON.stringify({ sessionName, projectsRoot, model }, null, 2)}\n`, 'utf8');
  await mkdir(dirname(unitFile), { recursive: true });
  await writeUnitFileAtomically(options.writeFile, unitFile, unitText);

  // 4. Asked before the reload: a service running before install is running
  // old code (ours or, with --replace, another program's) and needs a restart.
  // `enable --now` alone does not restart a running service.
  const wasRunningBeforeInstall = await serviceIsActive(options.runSystemctl);
  await runSystemctlOrThrow(options.runSystemctl, ['--user', 'daemon-reload']);
  await runSystemctlOrThrow(options.runSystemctl, ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME]);
  if (wasRunningBeforeInstall) {
    await runSystemctlOrThrow(options.runSystemctl, ['--user', 'restart', SYSTEMD_SERVICE_NAME]);
  }

  return { unitFile, copiedDaemon, restartedRunningService: wasRunningBeforeInstall, leftOutPathEntries: splitCapturedPath(options.capturedPath).leftOutEntries };
}

// ---- uninstall ----

export interface UninstallDaemonServiceOptions {
  paths: DaemonPaths;
  homeDirectory: string;
  runSystemctl: RunSystemctl;
  removeFile: (path: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
}

// Stops and disables the service, removes the unit and the installed copy of
// the daemon. machine.json, machine-id and orchestrator.json stay: removing the
// service is not unpairing the machine (revoke_machine does that).
export async function uninstallDaemonService(options: UninstallDaemonServiceOptions): Promise<{ unitWasInstalled: boolean; unitFile: string }> {
  const unitFile = systemdUserUnitFile(options.homeDirectory);
  const existingUnitText = await readFileIfPresent(unitFile);
  if (existingUnitText === null) {
    // No unit, but an earlier uninstall may have stopped half-way: the
    // installed copy is only code this plugin put there, so remove it anyway.
    await options.removeDirectory(options.paths.installedDaemonDirectory);
    return { unitWasInstalled: false, unitFile };
  }
  if (!unitWasWrittenByThisPlugin(existingUnitText)) {
    throw new DaemonServiceRefusal(`${unitFile} was not written by this plugin; leaving it and its service alone`);
  }

  // Everything is removed before the reload, so systemd reloads into a state
  // where neither the unit nor the code it ran exists.
  await runSystemctlOrThrow(options.runSystemctl, ['--user', 'disable', '--now', SYSTEMD_SERVICE_NAME]);
  await options.removeFile(unitFile);
  await options.removeDirectory(options.paths.installedDaemonDirectory);
  await runSystemctlOrThrow(options.runSystemctl, ['--user', 'daemon-reload']);
  return { unitWasInstalled: true, unitFile };
}

// ---- the command line ----

// What install and uninstall need beyond the general CLI dependencies; main.ts
// passes the real ones, tests pass a temporary home and a fake systemctl.
export interface ServiceInstallEnvironment {
  homeDirectory: string;
  capturedPath: string;
  nodeExecutablePath: string;
  builtDistDirectory: string;
  capturedXdgBaseDirectories: XdgBaseDirectories;
  runSystemctl: RunSystemctl;
  writeFile: typeof fs.writeFile;
  copyDirectory: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
}

interface ServiceCommandDependencies {
  writeStandardOutput: (text: string) => void;
  writeStandardError: (text: string) => void;
  daemonPaths: DaemonPaths;
  serviceInstallEnvironment?: ServiceInstallEnvironment;
}

export const INSTALL_USAGE_TEXT =
  'usage: claudecommander daemon install --projects-root <absolute-path> [--orchestrator-name <name>] [--model <model>] [--replace]\n';
export const UNINSTALL_USAGE_TEXT = 'usage: claudecommander daemon uninstall\n';

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_FAILURE = 1;
const EXIT_CODE_USAGE_ERROR = 2;

// The options after `daemon install`, or null when they are not usable.
function parseInstallOptions(optionList: readonly string[]): { orchestratorSettings: OrchestratorSettings; replaceUnitWrittenByOthers: boolean } | null {
  let projectsRoot: string | undefined;
  let sessionName = DEFAULT_ORCHESTRATOR_SESSION_NAME;
  let model = DEFAULT_ORCHESTRATOR_MODEL;
  let replaceUnitWrittenByOthers = false;
  for (let position = 0; position < optionList.length; position += 1) {
    const option = optionList[position];
    if (option === '--replace') {
      replaceUnitWrittenByOthers = true;
      continue;
    }
    // Every other option takes a value, which may not look like another option.
    const value = optionList[position + 1];
    if (value === undefined || value.startsWith('--')) return null;
    position += 1;
    if (option === '--projects-root') projectsRoot = value;
    else if (option === '--orchestrator-name') sessionName = value;
    else if (option === '--model') model = value;
    else return null;
  }
  if (projectsRoot === undefined || !isAbsolute(projectsRoot)) return null;
  return { orchestratorSettings: { sessionName, projectsRoot, model }, replaceUnitWrittenByOthers };
}

function missingEnvironmentFailure(subcommandName: string, dependencies: ServiceCommandDependencies): number {
  dependencies.writeStandardError(`claudecommander daemon ${subcommandName}: no install environment was given (a bug in the entry point)\n`);
  return EXIT_CODE_FAILURE;
}

export async function runDaemonInstallSubcommand(optionList: readonly string[], dependencies: ServiceCommandDependencies): Promise<number> {
  const installOptions = parseInstallOptions(optionList);
  if (installOptions === null) {
    dependencies.writeStandardError(INSTALL_USAGE_TEXT);
    return EXIT_CODE_USAGE_ERROR;
  }
  const environment = dependencies.serviceInstallEnvironment;
  if (environment === undefined) return missingEnvironmentFailure('install', dependencies);

  try {
    const outcome = await installDaemonService({
      paths: dependencies.daemonPaths,
      homeDirectory: environment.homeDirectory,
      capturedPath: environment.capturedPath,
      nodeExecutablePath: environment.nodeExecutablePath,
      builtDistDirectory: environment.builtDistDirectory,
      orchestratorSettings: installOptions.orchestratorSettings,
      capturedXdgBaseDirectories: environment.capturedXdgBaseDirectories,
      replaceUnitWrittenByOthers: installOptions.replaceUnitWrittenByOthers,
      runSystemctl: environment.runSystemctl,
      writeFile: environment.writeFile,
      copyDirectory: environment.copyDirectory,
    });
    const lines: string[] = [];
    if (outcome.copiedDaemon) lines.push(`copied the daemon to ${dependencies.daemonPaths.installedDaemonDirectory}`);
    lines.push(`wrote ${dependencies.daemonPaths.orchestratorSettingsFile}`, `wrote ${outcome.unitFile}`);
    if (outcome.leftOutPathEntries.length > 0) {
      lines.push(`left out of the service's PATH (the unit cannot carry them): ${outcome.leftOutPathEntries.join(', ')}`);
    }
    lines.push(
      outcome.restartedRunningService
        ? `${SYSTEMD_SERVICE_NAME} was running and has been restarted on the new copy`
        : `${SYSTEMD_SERVICE_NAME} is installed and started (systemctl --user status ${SYSTEMD_SERVICE_NAME})`,
    );
    dependencies.writeStandardOutput(lines.map((line) => `${line}\n`).join(''));
    return EXIT_CODE_SUCCESS;
  } catch (error) {
    dependencies.writeStandardError(`claudecommander daemon install: ${messageOf(error)}\n`);
    return EXIT_CODE_FAILURE;
  }
}

export async function runDaemonUninstallSubcommand(optionList: readonly string[], dependencies: ServiceCommandDependencies): Promise<number> {
  if (optionList.length > 0) {
    dependencies.writeStandardError(UNINSTALL_USAGE_TEXT);
    return EXIT_CODE_USAGE_ERROR;
  }
  const environment = dependencies.serviceInstallEnvironment;
  if (environment === undefined) return missingEnvironmentFailure('uninstall', dependencies);

  try {
    const outcome = await uninstallDaemonService({
      paths: dependencies.daemonPaths,
      homeDirectory: environment.homeDirectory,
      runSystemctl: environment.runSystemctl,
      removeFile: environment.removeFile,
      removeDirectory: environment.removeDirectory,
    });
    const keptFilesLine = `the machine credential (${dependencies.daemonPaths.machineCredentialFile}) and orchestrator.json are kept`;
    dependencies.writeStandardOutput(
      outcome.unitWasInstalled
        ? `stopped and disabled ${SYSTEMD_SERVICE_NAME}, removed ${outcome.unitFile} and ${dependencies.daemonPaths.installedDaemonDirectory}\n${keptFilesLine}\n`
        : `${SYSTEMD_SERVICE_NAME} is not installed (no ${outcome.unitFile}); nothing to do\n`,
    );
    return EXIT_CODE_SUCCESS;
  } catch (error) {
    dependencies.writeStandardError(`claudecommander daemon uninstall: ${messageOf(error)}\n`);
    return EXIT_CODE_FAILURE;
  }
}
