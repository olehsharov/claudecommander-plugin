// The machine credential: what `daemon pair` receives from the backend and
// `daemon run` later trades for a Firebase custom token (spec 6.2).
//
// Two files in the config directory:
//   - machine.json, mode 0600: {backend_url, machine_id, machine_secret}. The
//     secret is the only thing that lets this machine read its inbox, so the
//     file is readable by its owner and nobody else.
//   - machine-id, mode 0644: the machine id alone. It is not secret; any local
//     session reads it to pass as reply_to_machine_id.
//
// The machine secret is opaque. Today the backend makes it
// "<machine_id>.<random>", but that is the backend's business: it is stored
// whole, exactly as received, and never split or checked here.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DaemonPaths } from './paths.js';

// The in-memory form. On disk the keys are snake_case (MachineCredentialOnDisk).
export interface MachineCredential {
  backendUrl: string;
  machineId: string;
  machineSecret: string;
}

interface MachineCredentialOnDisk {
  backend_url: string;
  machine_id: string;
  machine_secret: string;
}

const OWNER_ONLY_FILE_MODE = 0o600;
const EVERYONE_CAN_READ_FILE_MODE = 0o644;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;

// Writes `contents` to `finalPath` so that no reader ever sees a half-written
// file, and the file never exists, even for a moment, with a wider mode than
// `fileMode`. The steps:
//   1. create a new temporary file next to the final one. The `wx` flag makes
//      creation fail rather than reuse a file someone else made, and the mode
//      is given at creation, so the bytes never sit in a file with the default
//      (often world-readable) mode;
//   2. chmod it to exactly `fileMode`. The umask can only remove bits at
//      creation, but a strict umask could remove bits we need (machine-id
//      must stay readable), so the mode is set explicitly either way;
//   3. write, flush to disk, close;
//   4. rename over the final path. Rename is atomic on one filesystem, and the
//      final file takes the temporary file's mode, whatever the old one had.
async function writeFileAtomicallyWithMode(finalPath: string, contents: string, fileMode: number): Promise<void> {
  const temporaryPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomBytes(6).toString('hex')}.tmp`);
  const fileHandle = await open(temporaryPath, 'wx', fileMode);
  try {
    await fileHandle.chmod(fileMode);
    await fileHandle.writeFile(contents, 'utf8');
    await fileHandle.sync();
  } catch (error) {
    await fileHandle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await fileHandle.close();
  try {
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

// Saves the credential: machine.json first (the secret), then machine-id.
export async function writeMachineCredential(paths: DaemonPaths, credential: MachineCredential): Promise<void> {
  // The directory holds the secret's file, so it is the owner's alone. chmod
  // after mkdir because mkdir's mode is narrowed by the umask and does not
  // apply to a directory that already exists.
  await mkdir(paths.configDirectory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  await chmod(paths.configDirectory, OWNER_ONLY_DIRECTORY_MODE);

  const credentialOnDisk: MachineCredentialOnDisk = {
    backend_url: credential.backendUrl,
    machine_id: credential.machineId,
    machine_secret: credential.machineSecret,
  };
  await writeFileAtomicallyWithMode(paths.machineCredentialFile, `${JSON.stringify(credentialOnDisk, null, 2)}\n`, OWNER_ONLY_FILE_MODE);
  await writeFileAtomicallyWithMode(paths.machineIdFile, credential.machineId, EVERYONE_CAN_READ_FILE_MODE);
}

function isNonEmptyString(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate !== '';
}

// The saved credential, or null when this machine has never been paired.
// A file that exists but cannot be used is an error, not "never paired": the
// message names the file but never repeats its contents, which hold the secret.
export async function readMachineCredential(paths: DaemonPaths): Promise<MachineCredential | null> {
  let fileText: string;
  try {
    fileText = await readFile(paths.machineCredentialFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const damagedFileError = new Error(`${paths.machineCredentialFile} is damaged; run claudecommander daemon pair --force to pair this machine again`);
  let parsedFile: Partial<MachineCredentialOnDisk> | null;
  try {
    parsedFile = JSON.parse(fileText);
  } catch {
    throw damagedFileError;
  }
  if (
    parsedFile === null ||
    typeof parsedFile !== 'object' ||
    !isNonEmptyString(parsedFile.backend_url) ||
    !isNonEmptyString(parsedFile.machine_id) ||
    !isNonEmptyString(parsedFile.machine_secret)
  ) {
    throw damagedFileError;
  }
  return {
    backendUrl: parsedFile.backend_url,
    machineId: parsedFile.machine_id,
    machineSecret: parsedFile.machine_secret,
  };
}
