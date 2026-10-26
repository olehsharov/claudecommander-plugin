// `claudecommander daemon install` / `daemon uninstall`: the systemd user unit.
//
// Nothing here touches the real ~/.config/systemd/user or runs a real
// systemctl. Every test uses a temporary home (so the unit directory, the
// installed daemon directory and orchestrator.json all live in a temp
// directory) and a fake systemctl that only records what it was asked.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ClaudeCommandResult } from './claudeCli.js';
import { runDaemonCli, type DaemonCliDependencies } from './cli.js';
import { checkServiceEntryFile } from './doctor.js';
import { resolveDaemonPaths, type DaemonPaths } from './paths.js';
import {
  OUR_UNIT_MARKER_LINE,
  buildSystemdUnitText,
  installDaemonService,
  pickXdgBaseDirectories,
  replaceDirectoryWithCopy,
  systemdUserUnitFile,
  uninstallDaemonService,
  type InstallDaemonServiceOptions,
} from './systemdUnit.js';

const unitOptions = {
  nodeExecutablePath: '/usr/bin/node',
  daemonEntryPath: '/home/u/.local/share/claudecommander/daemon/cli.js',
  capturedPath: '/usr/local/bin:/usr/bin:/bin',
};

let temporaryHome: string;
let builtDistDirectory: string;
let paths: DaemonPaths;
let unitPath: string;
let systemctlCalls: string[][];
let copyCalls: string[][];
// One ordered record of everything install and uninstall did: copies, file
// writes and removals, and systemctl calls, so tests can check the order.
let actionLog: string[];
let removedFiles: string[];
let removedDirectories: string[];
// What the fake systemctl answers to `is-active`; every other call succeeds
// unless failingSystemctlCommand names it.
let serviceIsActive: boolean;
let failingSystemctlCommand: string | null;

async function fakeSystemctl(argumentList: string[]): Promise<ClaudeCommandResult> {
  systemctlCalls.push(argumentList);
  actionLog.push(`systemctl ${argumentList.slice(1).join(' ')}`);
  if (argumentList.join(' ') === failingSystemctlCommand) {
    return { exitCode: 1, standardOutput: '', standardError: 'Failed to connect to bus: No medium found\n' };
  }
  if (argumentList[1] === 'is-active') {
    return serviceIsActive ? { exitCode: 0, standardOutput: 'active\n', standardError: '' } : { exitCode: 3, standardOutput: 'inactive\n', standardError: '' };
  }
  return { exitCode: 0, standardOutput: '', standardError: '' };
}

// Systemctl calls that change something, without the read-only is-active question.
function stateChangingSystemctlCalls(): string[][] {
  return systemctlCalls.filter((argumentList) => argumentList[1] !== 'is-active');
}

function installOptions(overrides: Partial<InstallDaemonServiceOptions> = {}): InstallDaemonServiceOptions {
  return {
    paths,
    homeDirectory: temporaryHome,
    capturedPath: '/usr/local/bin:/usr/bin:/bin',
    nodeExecutablePath: '/usr/bin/node',
    builtDistDirectory,
    orchestratorSettings: { sessionName: 'orchestrator', projectsRoot: '/tmp/projects', model: 'sonnet' },
    replaceUnitWrittenByOthers: false,
    runSystemctl: fakeSystemctl,
    capturedXdgBaseDirectories: {},
    writeFile: (async (filePath: string, ...rest: unknown[]) => {
      actionLog.push(`write ${describeWrittenFile(String(filePath))}`);
      return (writeFile as (...anything: unknown[]) => Promise<void>)(filePath, ...rest);
    }) as typeof writeFile,
    copyDirectory: async (from, to) => {
      copyCalls.push([from, to]);
      actionLog.push('copy the daemon');
      await replaceDirectoryWithCopy(from, to);
    },
    ...overrides,
  };
}

// The unit is written to a temporary file next to it and renamed into place.
function describeWrittenFile(filePath: string): string {
  if (filePath.startsWith(unitPath)) return 'the unit';
  if (filePath === paths.orchestratorSettingsFile) return 'orchestrator.json';
  return filePath;
}

function uninstallOptions() {
  return {
    paths,
    homeDirectory: temporaryHome,
    runSystemctl: fakeSystemctl,
    removeFile: async (filePath: string) => {
      removedFiles.push(filePath);
      actionLog.push('remove the unit');
      rmSync(filePath);
    },
    removeDirectory: async (directoryPath: string) => {
      removedDirectories.push(directoryPath);
      actionLog.push('remove the installed daemon');
      rmSync(directoryPath, { recursive: true, force: true });
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OLD_PRODUCT_UNIT_TEXT = '[Unit]\nDescription=Claude Commander\n\n[Service]\nExecStart=/usr/bin/node /srv/old/packages/daemon/dist/cli.js\n';

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), 'claudecommander-systemd-test-'));
  builtDistDirectory = join(temporaryHome, 'plugin-cache', 'dist');
  mkdirSync(builtDistDirectory, { recursive: true });
  writeFileSync(join(builtDistDirectory, 'cli.js'), '// the freshly built bundle\n');
  paths = resolveDaemonPaths(temporaryHome, {});
  unitPath = systemdUserUnitFile(temporaryHome);
  systemctlCalls = [];
  copyCalls = [];
  actionLog = [];
  removedFiles = [];
  removedDirectories = [];
  serviceIsActive = false;
  failingSystemctlCommand = null;
});

afterEach(() => {
  rmSync(temporaryHome, { recursive: true, force: true });
});

// ---- the unit text ----

test('the unit file lives in the home directory\'s ~/.config/systemd/user as claudecommander.service', () => {
  expect(systemdUserUnitFile('/home/u')).toBe('/home/u/.config/systemd/user/claudecommander.service');
});

test('the unit has exactly one Environment line and it is PATH', () => {
  const unitText = buildSystemdUnitText(unitOptions);
  expect(unitText.match(/^Environment=/gm)).toHaveLength(1);
  expect(unitText).toMatch(/^Environment=PATH=\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
});

test('the unit never contains anything that looks like a token or secret', () => {
  expect(buildSystemdUnitText({ ...unitOptions, capturedPath: '/usr/bin:/home/u/.local/bin' })).not.toMatch(/TOKEN|SECRET|KEY|ANTHROPIC/);
});

test('the unit runs daemon run, restarts on failure after 5 s, waits 180 s on stop and is wanted by default.target', () => {
  const unitText = buildSystemdUnitText(unitOptions);
  expect(unitText).toMatch(/^Description=claudecommander daemon$/m);
  expect(unitText).toMatch(/^ExecStart=\/usr\/bin\/node \/home\/u\/\.local\/share\/claudecommander\/daemon\/cli\.js daemon run$/m);
  expect(unitText).toMatch(/^Restart=on-failure$/m);
  expect(unitText).toMatch(/^RestartSec=5$/m);
  expect(unitText).toMatch(/^TimeoutStopSec=180$/m);
  expect(unitText).toMatch(/^\[Install\]\nWantedBy=default\.target$/m);
});

test('the unit starts with the marker line that says this plugin wrote it', () => {
  expect(buildSystemdUnitText(unitOptions).split('\n')[0]).toBe(OUR_UNIT_MARKER_LINE);
});

test('a % in PATH is doubled, because systemd would read it as a specifier', () => {
  expect(buildSystemdUnitText({ ...unitOptions, capturedPath: '/opt/100%/bin:/usr/bin' })).toMatch(/^Environment=PATH=\/opt\/100%%\/bin:\/usr\/bin$/m);
});

test('PATH entries the unit cannot carry (spaces, quotes, backslashes, relative or empty) are left out', () => {
  const unitText = buildSystemdUnitText({ ...unitOptions, capturedPath: '/usr/bin:/mnt/c/Program Files/x:.:"/q":/a\\b::/bin' });
  expect(unitText).toMatch(/^Environment=PATH=\/usr\/bin:\/bin$/m);
});

test('the unit refuses a node or entry path with a space, because doctor splits ExecStart on spaces', () => {
  expect(() => buildSystemdUnitText({ ...unitOptions, daemonEntryPath: '/home/a user/.local/share/claudecommander/daemon/cli.js' })).toThrow(/space/);
  expect(() => buildSystemdUnitText({ ...unitOptions, nodeExecutablePath: '/opt/my node/bin/node' })).toThrow(/space/);
});

test('each XDG base directory that is set gets its own Environment line, % doubled', () => {
  const unitText = buildSystemdUnitText({
    ...unitOptions,
    xdgBaseDirectories: { XDG_CONFIG_HOME: '/home/u/cfg', XDG_STATE_HOME: '/home/u/state%1', XDG_DATA_HOME: '/home/u/data' },
  });
  expect(unitText).toMatch(/^Environment=XDG_CONFIG_HOME=\/home\/u\/cfg$/m);
  expect(unitText).toMatch(/^Environment=XDG_STATE_HOME=\/home\/u\/state%%1$/m);
  expect(unitText).toMatch(/^Environment=XDG_DATA_HOME=\/home\/u\/data$/m);
  expect(unitText.match(/^Environment=/gm)).toHaveLength(4);
});

test('an XDG base directory that is not set gets no line, so systemd\'s default matches the shell\'s', () => {
  const unitText = buildSystemdUnitText({ ...unitOptions, xdgBaseDirectories: { XDG_CONFIG_HOME: '/home/u/cfg' } });
  expect(unitText).toMatch(/^Environment=XDG_CONFIG_HOME=/m);
  expect(unitText).not.toMatch(/XDG_STATE_HOME|XDG_DATA_HOME/);
});

test('only set, non-empty XDG base directories are picked from the shell environment', () => {
  expect(pickXdgBaseDirectories({ XDG_CONFIG_HOME: '/c', XDG_STATE_HOME: '', HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1' })).toEqual({ XDG_CONFIG_HOME: '/c' });
});

test('an XDG base directory that is relative or has a space, quote, $ or ; is refused', () => {
  for (const badValue of ['relative/cfg', '/home/u/my cfg', '/home/u/"cfg"', "/home/u/'cfg'", '/home/u/$cfg', '/home/u/c;fg', '/home/u/c\\fg']) {
    expect(() => buildSystemdUnitText({ ...unitOptions, xdgBaseDirectories: { XDG_STATE_HOME: badValue } }), badValue).toThrow(/XDG_STATE_HOME/);
  }
});

// What systemd would hand the daemon: each Environment= line, with %% read back as %.
function environmentFromUnitText(unitText: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const match of unitText.matchAll(/^Environment=([A-Z_]+)=(.*)$/gm)) {
    environment[match[1]!] = match[2]!.replaceAll('%%', '%');
  }
  return environment;
}

test('a daemon started with the unit\'s environment resolves the same paths as the shell that ran install', () => {
  const shellEnvironment = { XDG_CONFIG_HOME: '/home/u/cfg', XDG_STATE_HOME: '/home/u/100%state', PATH: '/usr/bin', HOME: '/home/u' };
  const pathsInTheShell = resolveDaemonPaths('/home/u', shellEnvironment);
  const unitText = buildSystemdUnitText({
    nodeExecutablePath: '/usr/bin/node',
    daemonEntryPath: join(pathsInTheShell.installedDaemonDirectory, 'cli.js'),
    capturedPath: shellEnvironment.PATH,
    xdgBaseDirectories: pickXdgBaseDirectories(shellEnvironment),
  });
  expect(resolveDaemonPaths('/home/u', environmentFromUnitText(unitText))).toEqual(pathsInTheShell);
});

test('doctor reads the ExecStart line of a unit install wrote and finds the entry file ok', async () => {
  await installDaemonService(installOptions());
  const execStartCommand = /^ExecStart=(.*)$/m.exec(readFileSync(unitPath, 'utf8'))![1]!;
  // The shape `systemctl --user show -p ExecStart --value` prints for a loaded unit.
  const showOutput = `{ path=/usr/bin/node ; argv[]=${execStartCommand} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
  const check = await checkServiceEntryFile(async () => ({ exitCode: 0, standardOutput: showOutput, standardError: '' }), paths.installedDaemonDirectory);
  expect(check.status).toBe('ok');
});

// ---- install ----

test('install writes the unit, reloads systemd and enables it now', async () => {
  await installDaemonService(installOptions());
  expect(readFileSync(unitPath, 'utf8')).toBe(buildSystemdUnitText({
    nodeExecutablePath: '/usr/bin/node',
    daemonEntryPath: join(paths.installedDaemonDirectory, 'cli.js'),
    capturedPath: '/usr/local/bin:/usr/bin:/bin',
  }));
  expect(stateChangingSystemctlCalls()).toEqual([['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'claudecommander']]);
});

test('install copies, writes the files, then asks is-active, reloads and enables, in that order', async () => {
  await installDaemonService(installOptions());
  expect(actionLog).toEqual([
    'copy the daemon',
    'write orchestrator.json',
    'write the unit',
    'systemctl is-active claudecommander',
    'systemctl daemon-reload',
    'systemctl enable --now claudecommander',
  ]);
});

test('install restarts last, and only when the unit was active before', async () => {
  serviceIsActive = true;
  await installDaemonService(installOptions());
  expect(actionLog.slice(-4)).toEqual([
    'systemctl is-active claudecommander',
    'systemctl daemon-reload',
    'systemctl enable --now claudecommander',
    'systemctl restart claudecommander',
  ]);
});

test('install passes the shell\'s XDG base directories into the unit', async () => {
  await installDaemonService(installOptions({ capturedXdgBaseDirectories: { XDG_CONFIG_HOME: join(temporaryHome, 'cfg') } }));
  expect(readFileSync(unitPath, 'utf8')).toMatch(new RegExp(`^Environment=XDG_CONFIG_HOME=${escapeRegExp(join(temporaryHome, 'cfg'))}$`, 'm'));
});

test('install refuses an XDG base directory the unit cannot carry, and changes nothing', async () => {
  await expect(installDaemonService(installOptions({ capturedXdgBaseDirectories: { XDG_DATA_HOME: 'relative/data' } }))).rejects.toThrow(/XDG_DATA_HOME/);
  expect(copyCalls).toEqual([]);
  expect(systemctlCalls).toEqual([]);
});

test('install reports whether it copied the daemon', async () => {
  expect((await installDaemonService(installOptions())).copiedDaemon).toBe(true);
  expect((await installDaemonService(installOptions({ builtDistDirectory: paths.installedDaemonDirectory }))).copiedDaemon).toBe(false);
});

test('the unit is written through a temporary file and is mode 0644 even when an earlier one was 0600', async () => {
  await installDaemonService(installOptions());
  chmodSync(unitPath, 0o600);
  await installDaemonService(installOptions());
  expect(statSync(unitPath).mode & 0o777).toBe(0o644);
  expect(actionLog.filter((entry) => entry === 'write the unit')).toHaveLength(2);
  // Nothing but the unit itself is left in the unit directory.
  expect(existsSync(`${unitPath}.incoming`)).toBe(false);
});

test('a copy left half-done by an earlier crash (.incoming or .previous) is cleaned up', async () => {
  for (const leftOver of ['.incoming', '.previous']) {
    mkdirSync(`${paths.installedDaemonDirectory}${leftOver}`, { recursive: true });
    writeFileSync(join(`${paths.installedDaemonDirectory}${leftOver}`, 'cli.js'), '// left over\n');
  }
  await replaceDirectoryWithCopy(builtDistDirectory, paths.installedDaemonDirectory);
  expect(existsSync(`${paths.installedDaemonDirectory}.incoming`)).toBe(false);
  expect(existsSync(`${paths.installedDaemonDirectory}.previous`)).toBe(false);
  expect(readFileSync(join(paths.installedDaemonDirectory, 'cli.js'), 'utf8')).toBe('// the freshly built bundle\n');
});

test('install restarts the service when it was already running, so a re-install runs the new copy', async () => {
  serviceIsActive = true;
  const outcome = await installDaemonService(installOptions());
  expect(stateChangingSystemctlCalls()).toEqual([
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'claudecommander'],
    ['--user', 'restart', 'claudecommander'],
  ]);
  expect(outcome.restartedRunningService).toBe(true);
});

test('install writes orchestrator.json with the given projects root, name and model', async () => {
  await installDaemonService(installOptions({ orchestratorSettings: { sessionName: 'orchestrator-a', projectsRoot: '/tmp/p', model: 'sonnet' } }));
  expect(JSON.parse(readFileSync(paths.orchestratorSettingsFile, 'utf8'))).toEqual({ sessionName: 'orchestrator-a', projectsRoot: '/tmp/p', model: 'sonnet' });
});

test('install copies dist/ to the installed daemon directory and the unit runs that copy with daemon run', async () => {
  await installDaemonService(installOptions());
  expect(copyCalls).toEqual([[builtDistDirectory, paths.installedDaemonDirectory]]);
  expect(readFileSync(join(paths.installedDaemonDirectory, 'cli.js'), 'utf8')).toBe('// the freshly built bundle\n');
  expect(readFileSync(unitPath, 'utf8')).toMatch(new RegExp(`^ExecStart=\\S+ ${escapeRegExp(paths.installedDaemonDirectory)}/cli\\.js daemon run$`, 'm'));
});

test('a re-install replaces the old copy, so no file from the previous version is left behind', async () => {
  mkdirSync(paths.installedDaemonDirectory, { recursive: true });
  writeFileSync(join(paths.installedDaemonDirectory, 'cli.js'), '// the old bundle\n');
  writeFileSync(join(paths.installedDaemonDirectory, 'left-over.js'), '// gone in the new version\n');
  await installDaemonService(installOptions());
  expect(readFileSync(join(paths.installedDaemonDirectory, 'cli.js'), 'utf8')).toBe('// the freshly built bundle\n');
  expect(existsSync(join(paths.installedDaemonDirectory, 'left-over.js'))).toBe(false);
});

test('install run from the installed copy itself does not copy it onto itself', async () => {
  mkdirSync(paths.installedDaemonDirectory, { recursive: true });
  writeFileSync(join(paths.installedDaemonDirectory, 'cli.js'), '// the installed bundle\n');
  await installDaemonService(installOptions({ builtDistDirectory: paths.installedDaemonDirectory }));
  expect(copyCalls).toEqual([]);
  expect(readFileSync(join(paths.installedDaemonDirectory, 'cli.js'), 'utf8')).toBe('// the installed bundle\n');
});

test('install refuses when the installed daemon path has a space, and changes nothing', async () => {
  const pathsWithSpace = resolveDaemonPaths(temporaryHome, { XDG_DATA_HOME: join(temporaryHome, 'my data') });
  await expect(installDaemonService(installOptions({ paths: pathsWithSpace }))).rejects.toThrow(/contains a space/);
  expect(existsSync(unitPath)).toBe(false);
  expect(copyCalls).toEqual([]);
  expect(systemctlCalls).toEqual([]);
});

test('install refuses a node executable whose path has a space', async () => {
  await expect(installDaemonService(installOptions({ nodeExecutablePath: '/opt/my node/node' }))).rejects.toThrow(/contains a space/);
  expect(systemctlCalls).toEqual([]);
});

test('install refuses to overwrite a unit file this plugin did not write, naming the file and --replace', async () => {
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, OLD_PRODUCT_UNIT_TEXT);
  const installAttempt = installDaemonService(installOptions());
  await expect(installAttempt).rejects.toThrow(new RegExp(escapeRegExp(unitPath)));
  await expect(installAttempt).rejects.toThrow(/--replace/);
  expect(readFileSync(unitPath, 'utf8')).toBe(OLD_PRODUCT_UNIT_TEXT);
  expect(copyCalls).toEqual([]);
  expect(existsSync(paths.orchestratorSettingsFile)).toBe(false);
  expect(systemctlCalls).toEqual([]);
});

test('with --replace, install replaces a unit file this plugin did not write and restarts the running service', async () => {
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, OLD_PRODUCT_UNIT_TEXT);
  serviceIsActive = true;
  await installDaemonService(installOptions({ replaceUnitWrittenByOthers: true }));
  expect(readFileSync(unitPath, 'utf8').split('\n')[0]).toBe(OUR_UNIT_MARKER_LINE);
  expect(stateChangingSystemctlCalls()).toContainEqual(['--user', 'restart', 'claudecommander']);
});

test('install overwrites its own earlier unit without --replace', async () => {
  await installDaemonService(installOptions());
  await installDaemonService(installOptions({ capturedPath: '/usr/bin' }));
  expect(readFileSync(unitPath, 'utf8')).toMatch(/^Environment=PATH=\/usr\/bin$/m);
});

test('install refuses orchestrator settings the daemon would refuse to read', async () => {
  await expect(installDaemonService(installOptions({ orchestratorSettings: { sessionName: 'orchestrator', projectsRoot: 'relative/projects', model: 'sonnet' } }))).rejects.toThrow(/absolute/);
  await expect(installDaemonService(installOptions({ orchestratorSettings: { sessionName: '-x', projectsRoot: '/tmp/p', model: 'sonnet' } }))).rejects.toThrow(/session name/);
  await expect(installDaemonService(installOptions({ orchestratorSettings: { sessionName: 'o', projectsRoot: '/tmp/p', model: 'sonnet; rm' } }))).rejects.toThrow(/model/);
  expect(systemctlCalls).toEqual([]);
});

test('install refuses when the running plugin has no built dist/cli.js to copy', async () => {
  rmSync(join(builtDistDirectory, 'cli.js'));
  await expect(installDaemonService(installOptions())).rejects.toThrow(/cli\.js/);
  expect(existsSync(unitPath)).toBe(false);
});

test('a systemctl that fails stops the install with its exit code and first error line', async () => {
  failingSystemctlCommand = '--user daemon-reload';
  await expect(installDaemonService(installOptions())).rejects.toThrow(/systemctl --user daemon-reload failed \(exit 1\): Failed to connect to bus/);
});

test('install reports PATH entries it had to leave out', async () => {
  const outcome = await installDaemonService(installOptions({ capturedPath: '/usr/bin:/mnt/c/Program Files/x' }));
  expect(outcome.leftOutPathEntries).toEqual(['/mnt/c/Program Files/x']);
});

// ---- uninstall ----

test('uninstall disables, stops and removes the unit but keeps the machine credential', async () => {
  await installDaemonService(installOptions());
  mkdirSync(paths.configDirectory, { recursive: true });
  writeFileSync(paths.machineCredentialFile, '{"machine":"kept"}');
  systemctlCalls = [];

  const outcome = await uninstallDaemonService(uninstallOptions());

  expect(outcome.unitWasInstalled).toBe(true);
  expect(systemctlCalls).toEqual([['--user', 'disable', '--now', 'claudecommander'], ['--user', 'daemon-reload']]);
  expect(actionLog.slice(-4)).toEqual(['systemctl disable --now claudecommander', 'remove the unit', 'remove the installed daemon', 'systemctl daemon-reload']);
  expect(removedFiles).toEqual([unitPath]);
  expect(existsSync(unitPath)).toBe(false);
  expect(removedDirectories).toEqual([paths.installedDaemonDirectory]);
  expect(readFileSync(paths.machineCredentialFile, 'utf8')).toBe('{"machine":"kept"}');
  expect(existsSync(paths.orchestratorSettingsFile)).toBe(true);
});

test('uninstall with no unit file runs no systemctl and says so', async () => {
  const outcome = await uninstallDaemonService(uninstallOptions());
  expect(outcome.unitWasInstalled).toBe(false);
  expect(systemctlCalls).toEqual([]);
  expect(removedFiles).toEqual([]);
});

test('uninstall with no unit file still removes a left-over installed daemon directory', async () => {
  mkdirSync(paths.installedDaemonDirectory, { recursive: true });
  writeFileSync(join(paths.installedDaemonDirectory, 'cli.js'), '// left over\n');
  await uninstallDaemonService(uninstallOptions());
  expect(existsSync(paths.installedDaemonDirectory)).toBe(false);
  expect(systemctlCalls).toEqual([]);
});

test('uninstall refuses to stop or remove a unit file this plugin did not write', async () => {
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, OLD_PRODUCT_UNIT_TEXT);
  await expect(uninstallDaemonService(uninstallOptions())).rejects.toThrow(new RegExp(`${escapeRegExp(unitPath)}.*not written by`));
  expect(readFileSync(unitPath, 'utf8')).toBe(OLD_PRODUCT_UNIT_TEXT);
  expect(systemctlCalls).toEqual([]);
});

// ---- the command line ----

let standardOutputText: string;
let standardErrorText: string;

function cliDependencies(): DaemonCliDependencies {
  standardOutputText = '';
  standardErrorText = '';
  return {
    writeStandardOutput: (text) => { standardOutputText += text; },
    writeStandardError: (text) => { standardErrorText += text; },
    daemonPaths: paths,
    fetchFunction: (async () => { throw new Error('install never calls the backend'); }) as typeof fetch,
    sleep: async () => {},
    serviceInstallEnvironment: {
      homeDirectory: temporaryHome,
      capturedPath: '/usr/bin:/bin',
      nodeExecutablePath: '/usr/bin/node',
      builtDistDirectory,
      capturedXdgBaseDirectories: {},
      runSystemctl: fakeSystemctl,
      writeFile,
      copyDirectory: replaceDirectoryWithCopy,
      removeFile: async (filePath) => rmSync(filePath),
      removeDirectory: async (directoryPath) => rmSync(directoryPath, { recursive: true, force: true }),
    },
  };
}

test('daemon install without --projects-root prints usage and exits 2', async () => {
  const dependencies = cliDependencies();
  expect(await runDaemonCli(['daemon', 'install'], dependencies)).toBe(2);
  expect(standardErrorText).toMatch(/usage: claudecommander daemon install --projects-root <absolute-path>/);
  expect(systemctlCalls).toEqual([]);
});

test('daemon install with a relative projects root, an unknown option or a missing value prints usage and exits 2', async () => {
  const dependencies = cliDependencies();
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', 'projects'], dependencies)).toBe(2);
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p', '--frobnicate'], dependencies)).toBe(2);
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p', '--model'], dependencies)).toBe(2);
  expect(systemctlCalls).toEqual([]);
});

test('daemon install defaults the orchestrator name to orchestrator and the model to sonnet', async () => {
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p'], cliDependencies())).toBe(0);
  expect(JSON.parse(await readFile(paths.orchestratorSettingsFile, 'utf8'))).toEqual({ sessionName: 'orchestrator', projectsRoot: '/tmp/p', model: 'sonnet' });
  expect(standardOutputText).toMatch(/claudecommander is installed and started/);
  expect(standardOutputText).toMatch(/copied the daemon to/);
});

test('daemon install run from the installed copy does not claim it copied the daemon', async () => {
  const dependencies = cliDependencies();
  mkdirSync(paths.installedDaemonDirectory, { recursive: true });
  writeFileSync(join(paths.installedDaemonDirectory, 'cli.js'), '// installed\n');
  dependencies.serviceInstallEnvironment!.builtDistDirectory = paths.installedDaemonDirectory;
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p'], dependencies)).toBe(0);
  expect(standardOutputText).not.toMatch(/copied the daemon/);
});

test('daemon install takes --orchestrator-name and --model', async () => {
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p', '--orchestrator-name', 'boss', '--model', 'opus'], cliDependencies())).toBe(0);
  expect(JSON.parse(await readFile(paths.orchestratorSettingsFile, 'utf8'))).toEqual({ sessionName: 'boss', projectsRoot: '/tmp/p', model: 'opus' });
});

test('daemon install over a unit it did not write exits 1 naming --replace, and --replace goes ahead', async () => {
  mkdirSync(join(unitPath, '..'), { recursive: true });
  writeFileSync(unitPath, OLD_PRODUCT_UNIT_TEXT);
  let dependencies = cliDependencies();
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p'], dependencies)).toBe(1);
  expect(standardErrorText).toMatch(/--replace/);
  expect(readFileSync(unitPath, 'utf8')).toBe(OLD_PRODUCT_UNIT_TEXT);

  dependencies = cliDependencies();
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p', '--replace'], dependencies)).toBe(0);
  expect(readFileSync(unitPath, 'utf8').split('\n')[0]).toBe(OUR_UNIT_MARKER_LINE);
});

test('daemon uninstall removes the unit, keeps the credential and exits 0; extra arguments are a usage error', async () => {
  expect(await runDaemonCli(['daemon', 'install', '--projects-root', '/tmp/p'], cliDependencies())).toBe(0);
  const dependencies = cliDependencies();
  expect(await runDaemonCli(['daemon', 'uninstall', '--now'], dependencies)).toBe(2);
  expect(await runDaemonCli(['daemon', 'uninstall'], dependencies)).toBe(0);
  expect(existsSync(unitPath)).toBe(false);
  expect(standardOutputText).toMatch(/machine credential .* kept/);
});
