// Every file and directory the daemon reads or writes, derived from one home
// directory and the XDG environment variables. Both are passed in rather than
// read from process.env and os.homedir() here, so tests can point the daemon
// at a temporary home without touching the real one.
import { isAbsolute, join } from 'node:path';

export interface DaemonPaths {
  configDirectory: string;
  machineCredentialFile: string; // machine.json, mode 0600: backend URL, machine id and machine secret
  machineIdFile: string; // machine-id, mode 0644: the machine id only, readable by any local session
  orchestratorSettingsFile: string; // orchestrator.json: session name, projects root and model
  stateDirectory: string;
  rungMessageIdsFile: string; // rung.json: ids already rung, for at-most-once ringing across restarts
  logFile: string; // daemon.log
  daemonStatusFile: string; // <state>/status.json, written by the daemon loop (Task 20), read by status and doctor
  firebaseWebConfigCacheFile: string; // <state>/firebase-web-config.json: last good /__/firebase/init.json, not secret
  daemonLockFile: string; // <state>/daemon.lock: flocked by `daemon run` for its whole life, so one daemon runs per machine
  installedDaemonDirectory: string; // <data>/daemon, the stable copy of dist/ the systemd unit runs (Task 22)
}

const APPLICATION_DIRECTORY_NAME = 'claudecommander';

// The XDG Base Directory spec says an unset, empty or relative value must be
// ignored and the default used instead. Honouring a relative value would put
// the machine credential somewhere relative to whatever the cwd happens to be.
function chooseBaseDirectory(environmentValue: string | undefined, defaultDirectory: string): string {
  if (environmentValue !== undefined && environmentValue !== '' && isAbsolute(environmentValue)) {
    return environmentValue;
  }
  return defaultDirectory;
}

export function resolveDaemonPaths(homeDirectory: string, environment: Record<string, string | undefined>): DaemonPaths {
  const configBaseDirectory = chooseBaseDirectory(environment.XDG_CONFIG_HOME, join(homeDirectory, '.config'));
  const stateBaseDirectory = chooseBaseDirectory(environment.XDG_STATE_HOME, join(homeDirectory, '.local', 'state'));
  const dataBaseDirectory = chooseBaseDirectory(environment.XDG_DATA_HOME, join(homeDirectory, '.local', 'share'));

  const configDirectory = join(configBaseDirectory, APPLICATION_DIRECTORY_NAME);
  const stateDirectory = join(stateBaseDirectory, APPLICATION_DIRECTORY_NAME);
  const dataDirectory = join(dataBaseDirectory, APPLICATION_DIRECTORY_NAME);

  return {
    configDirectory,
    machineCredentialFile: join(configDirectory, 'machine.json'),
    machineIdFile: join(configDirectory, 'machine-id'),
    orchestratorSettingsFile: join(configDirectory, 'orchestrator.json'),
    stateDirectory,
    rungMessageIdsFile: join(stateDirectory, 'rung.json'),
    logFile: join(stateDirectory, 'daemon.log'),
    daemonStatusFile: join(stateDirectory, 'status.json'),
    firebaseWebConfigCacheFile: join(stateDirectory, 'firebase-web-config.json'),
    daemonLockFile: join(stateDirectory, 'daemon.lock'),
    installedDaemonDirectory: join(dataDirectory, 'daemon'),
  };
}
