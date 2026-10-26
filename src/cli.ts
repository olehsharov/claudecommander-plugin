// The `claudecommander` command line. Every daemon command lives under the
// `daemon` group: `claudecommander daemon <install|uninstall|pair|run|status|doctor>`.
// These are run by Claude or by the service manager, not typed by a person,
// so usage errors are short and machine-readable.
//
// Output goes through injected writers instead of process.stdout, so tests can
// capture it and later subcommands can keep stdout clean when it matters.

export const DAEMON_SUBCOMMANDS = ['install', 'uninstall', 'pair', 'run', 'status', 'doctor'] as const;
export type DaemonSubcommand = (typeof DAEMON_SUBCOMMANDS)[number];

import { readFile, stat } from 'node:fs/promises';
import { isValidOpaqueId } from './ids.js';
import { DEFAULT_BACKEND_URL, pairThisMachine } from './pairing.js';
import { runDaemonRunSubcommand, runDaemonStatusSubcommand, type DaemonRunEnvironment } from './daemonRun.js';
import { runDaemonDoctorSubcommand, type DoctorEnvironment } from './doctor.js';
import type { DaemonPaths } from './paths.js';
import { runDaemonInstallSubcommand, runDaemonUninstallSubcommand, type ServiceInstallEnvironment } from './systemdUnit.js';

// Everything a subcommand needs from the outside world, passed in so tests can
// use a temporary home, a fake backend and a sleep that returns at once.
export interface DaemonCliDependencies {
  writeStandardOutput: (text: string) => void;
  writeStandardError: (text: string) => void;
  daemonPaths: DaemonPaths;
  fetchFunction: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  // Only `daemon run` needs these; main.ts always passes them.
  daemonRunEnvironment?: DaemonRunEnvironment;
  // Only `daemon doctor` needs these; main.ts always passes them.
  doctorEnvironment?: DoctorEnvironment;
  // Only `daemon install` and `daemon uninstall` need these; main.ts always passes them.
  serviceInstallEnvironment?: ServiceInstallEnvironment;
}

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_FAILURE = 1;
// Exit code 2 is the shell convention for "the command line itself was wrong".
const EXIT_CODE_USAGE_ERROR = 2;

const USAGE_TEXT = `usage: claudecommander daemon <${DAEMON_SUBCOMMANDS.join('|')}>\n`;

function isHelpFlag(argument: string | undefined): boolean {
  return argument === '--help' || argument === '-h';
}

function isDaemonSubcommand(argument: string | undefined): argument is DaemonSubcommand {
  return (DAEMON_SUBCOMMANDS as readonly string[]).includes(argument ?? '');
}

// argumentList is everything after the executable, e.g. ['daemon', 'run'].
// Resolves to the process exit code.
export async function runDaemonCli(argumentList: readonly string[], dependencies: DaemonCliDependencies): Promise<number> {
  const [groupName, subcommandName] = argumentList;

  // `claudecommander --help` and `claudecommander daemon --help` are the only
  // requests for usage; they print it to stdout and succeed.
  if (isHelpFlag(groupName) || (groupName === 'daemon' && isHelpFlag(subcommandName))) {
    dependencies.writeStandardOutput(USAGE_TEXT);
    return EXIT_CODE_SUCCESS;
  }

  // Anything else that is not `daemon <known subcommand>` (no arguments, a
  // bare `run` without the group, an unknown subcommand) is a usage error.
  if (groupName !== 'daemon' || !isDaemonSubcommand(subcommandName)) {
    dependencies.writeStandardError(USAGE_TEXT);
    return EXIT_CODE_USAGE_ERROR;
  }

  const optionList = argumentList.slice(2);
  switch (subcommandName) {
    case 'install': return runDaemonInstallSubcommand(optionList, dependencies);
    case 'uninstall': return runDaemonUninstallSubcommand(optionList, dependencies);
    case 'pair': return runPairSubcommand(optionList, dependencies);
    case 'run': return runDaemonRunSubcommand(optionList, dependencies);
    case 'status': return runDaemonStatusSubcommand(optionList, dependencies);
    case 'doctor': return runDaemonDoctorSubcommand(optionList, dependencies);
  }
}

const PAIR_USAGE_TEXT = 'usage: claudecommander daemon pair [--force] [--backend <https-url>]\n';

interface PairOptions {
  replaceExistingCredential: boolean;
  backendUrl: string;
}

// Only http and https backends make sense (http for the local emulator). The
// URL is kept as typed, minus trailing slashes, so it is stored as given.
function parseBackendUrl(candidate: string | undefined): string | null {
  if (candidate === undefined) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return null;
  // A username or password in the URL would be stored in machine.json and
  // sent along with every request; the backend never needs one, so refuse it.
  if (parsedUrl.username !== '' || parsedUrl.password !== '') return null;
  return candidate.replace(/\/+$/, '');
}

// The options after `daemon pair`, or null when they are not usable.
function parsePairOptions(optionList: readonly string[]): PairOptions | null {
  const pairOptions: PairOptions = { replaceExistingCredential: false, backendUrl: DEFAULT_BACKEND_URL };
  for (let position = 0; position < optionList.length; position += 1) {
    const option = optionList[position];
    if (option === '--force') {
      pairOptions.replaceExistingCredential = true;
    } else if (option === '--backend') {
      position += 1;
      const backendUrl = parseBackendUrl(optionList[position]);
      if (backendUrl === null) return null;
      pairOptions.backendUrl = backendUrl;
    } else {
      return null;
    }
  }
  return pairOptions;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// The refusal names the machine from the non-secret machine-id file, never
// from machine.json, so the secret is not even read to print it.
async function describeExistingPairing(paths: DaemonPaths): Promise<string> {
  try {
    const machineId = (await readFile(paths.machineIdFile, 'utf8')).trim();
    if (isValidOpaqueId(machineId)) return `this machine is already paired as machine ${machineId}`;
  } catch {
    // No readable machine-id: fall through to the plain wording.
  }
  return `this machine is already paired (${paths.machineCredentialFile} exists)`;
}

async function runPairSubcommand(optionList: readonly string[], dependencies: DaemonCliDependencies): Promise<number> {
  const pairOptions = parsePairOptions(optionList);
  if (pairOptions === null) {
    dependencies.writeStandardError(PAIR_USAGE_TEXT);
    return EXIT_CODE_USAGE_ERROR;
  }

  try {
    // Pairing again makes a new machine on the backend and replaces this one's
    // credential, so it happens only when asked for explicitly. The check is
    // inside the try: a config path that cannot even be looked at (a file
    // where the directory should be, no permission) ends in one clean line.
    if (!pairOptions.replaceExistingCredential && (await fileExists(dependencies.daemonPaths.machineCredentialFile))) {
      const existingPairing = await describeExistingPairing(dependencies.daemonPaths);
      dependencies.writeStandardError(`claudecommander daemon pair: ${existingPairing}; pass --force to pair it again and replace the credential\n`);
      return EXIT_CODE_FAILURE;
    }

    await pairThisMachine({
      backendUrl: pairOptions.backendUrl,
      paths: dependencies.daemonPaths,
      fetchFunction: dependencies.fetchFunction,
      printLine: (line) => dependencies.writeStandardOutput(`${line}\n`),
      sleep: dependencies.sleep,
    });
    return EXIT_CODE_SUCCESS;
  } catch (error) {
    // PairingFailure messages are written to be shown. Any other error here
    // comes from checking for or saving the credential (a file system error),
    // whose message names a path at most.
    dependencies.writeStandardError(`claudecommander daemon pair: ${(error as Error).message}\n`);
    return EXIT_CODE_FAILURE;
  }
}
