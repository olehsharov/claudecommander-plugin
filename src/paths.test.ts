import { expect, test } from 'vitest';
import { resolveDaemonPaths } from './paths.js';

test('paths default to ~/.config, ~/.local/state and ~/.local/share under claudecommander', () => {
  const paths = resolveDaemonPaths('/home/u', {});
  expect(paths.machineCredentialFile).toBe('/home/u/.config/claudecommander/machine.json');
  expect(paths.daemonStatusFile).toBe('/home/u/.local/state/claudecommander/status.json');
  expect(paths.installedDaemonDirectory).toBe('/home/u/.local/share/claudecommander/daemon');
});

test('every default path has its documented file name', () => {
  expect(resolveDaemonPaths('/home/u', {})).toEqual({
    configDirectory: '/home/u/.config/claudecommander',
    machineCredentialFile: '/home/u/.config/claudecommander/machine.json',
    machineIdFile: '/home/u/.config/claudecommander/machine-id',
    orchestratorSettingsFile: '/home/u/.config/claudecommander/orchestrator.json',
    stateDirectory: '/home/u/.local/state/claudecommander',
    rungMessageIdsFile: '/home/u/.local/state/claudecommander/rung.json',
    logFile: '/home/u/.local/state/claudecommander/daemon.log',
    daemonStatusFile: '/home/u/.local/state/claudecommander/status.json',
    firebaseWebConfigCacheFile: '/home/u/.local/state/claudecommander/firebase-web-config.json',
    daemonLockFile: '/home/u/.local/state/claudecommander/daemon.lock',
    installedDaemonDirectory: '/home/u/.local/share/claudecommander/daemon',
  });
});

test('paths honour XDG_CONFIG_HOME, XDG_STATE_HOME and XDG_DATA_HOME', () => {
  const paths = resolveDaemonPaths('/home/u', {
    XDG_CONFIG_HOME: '/xdg/config',
    XDG_STATE_HOME: '/xdg/state',
    XDG_DATA_HOME: '/xdg/data',
  });
  expect(paths.machineCredentialFile).toBe('/xdg/config/claudecommander/machine.json');
  expect(paths.machineIdFile).toBe('/xdg/config/claudecommander/machine-id');
  expect(paths.orchestratorSettingsFile).toBe('/xdg/config/claudecommander/orchestrator.json');
  expect(paths.rungMessageIdsFile).toBe('/xdg/state/claudecommander/rung.json');
  expect(paths.logFile).toBe('/xdg/state/claudecommander/daemon.log');
  expect(paths.daemonStatusFile).toBe('/xdg/state/claudecommander/status.json');
  expect(paths.installedDaemonDirectory).toBe('/xdg/data/claudecommander/daemon');
});

// The XDG Base Directory spec says an empty or relative value must be ignored,
// so a stray `XDG_CONFIG_HOME=` or `XDG_CONFIG_HOME=config` falls back to the
// default instead of writing the machine credential relative to the cwd.
test('empty or relative XDG values are ignored in favour of the defaults', () => {
  const paths = resolveDaemonPaths('/home/u', { XDG_CONFIG_HOME: '', XDG_STATE_HOME: 'relative/state', XDG_DATA_HOME: './data' });
  expect(paths.configDirectory).toBe('/home/u/.config/claudecommander');
  expect(paths.stateDirectory).toBe('/home/u/.local/state/claudecommander');
  expect(paths.installedDaemonDirectory).toBe('/home/u/.local/share/claudecommander/daemon');
});
