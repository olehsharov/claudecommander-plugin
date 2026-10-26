import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readMachineCredential, writeMachineCredential, type MachineCredential } from './machineCredential.js';
import { resolveDaemonPaths, type DaemonPaths } from './paths.js';

// open() is wrapped (it still opens files for real) so a test can see the mode
// each file is created with, not just the mode it ends up with.
const fileSystemPromises = vi.hoisted(() => ({ recordedOpenCalls: [] as Array<{ path: string; flags: unknown; mode: unknown }> }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actualModule = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actualModule,
    open: (path: string, flags?: string | number, mode?: number) => {
      fileSystemPromises.recordedOpenCalls.push({ path: String(path), flags, mode });
      return actualModule.open(path, flags, mode);
    },
  };
});

let temporaryHomeDirectory = '';
let paths: DaemonPaths;

const exampleCredential: MachineCredential = {
  backendUrl: 'https://backend.example.test',
  machineId: 'machine_abc-123',
  machineSecret: 'machine_abc-123.SECRET-PART-that-is-opaque',
};

beforeEach(() => {
  temporaryHomeDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-credential-'));
  paths = resolveDaemonPaths(temporaryHomeDirectory, {});
});

afterEach(() => {
  rmSync(temporaryHomeDirectory, { recursive: true, force: true });
});

// Only the permission bits (rwx for owner, group, others) of a file's mode.
async function permissionBitsOf(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

test('machine.json is written with mode 0600 and machine-id with mode 0644 containing only the id', async () => {
  await writeMachineCredential(paths, exampleCredential);
  expect(await permissionBitsOf(paths.machineCredentialFile)).toBe(0o600);
  expect(await permissionBitsOf(paths.machineIdFile)).toBe(0o644);
  expect(await readFile(paths.machineIdFile, 'utf8')).toBe(exampleCredential.machineId);
});

test('machine.json uses the keys backend_url, machine_id and machine_secret', async () => {
  await writeMachineCredential(paths, exampleCredential);
  expect(Object.keys(JSON.parse(await readFile(paths.machineCredentialFile, 'utf8'))).sort()).toEqual(['backend_url', 'machine_id', 'machine_secret']);
});

test('the machine secret is stored whole, exactly as received', async () => {
  await writeMachineCredential(paths, exampleCredential);
  expect(JSON.parse(await readFile(paths.machineCredentialFile, 'utf8')).machine_secret).toBe(exampleCredential.machineSecret);
});

// A permissive umask must not widen machine.json, and a strict one must not
// hide machine-id from the other local sessions that need to read it.
test('the file modes are exact whatever the umask: 0600 under umask 000, 0644 under umask 077', async () => {
  const umaskBeforeTheTest = process.umask();
  try {
    process.umask(0o000);
    await writeMachineCredential(paths, exampleCredential);
    expect(await permissionBitsOf(paths.machineCredentialFile)).toBe(0o600);

    rmSync(paths.configDirectory, { recursive: true, force: true });
    process.umask(0o077);
    await writeMachineCredential(paths, exampleCredential);
    expect(await permissionBitsOf(paths.machineIdFile)).toBe(0o644);
  } finally {
    process.umask(umaskBeforeTheTest);
  }
});

test('replacing an existing machine.json keeps mode 0600 and leaves no temporary files behind', async () => {
  await mkdir(paths.configDirectory, { recursive: true });
  // An older credential somebody left world-readable.
  await writeFile(paths.machineCredentialFile, '{}', { mode: 0o644 });
  await writeMachineCredential(paths, exampleCredential);
  expect(await permissionBitsOf(paths.machineCredentialFile)).toBe(0o600);
  expect((await readdir(paths.configDirectory)).sort()).toEqual(['machine-id', 'machine.json']);
});

// The secret must never sit in a file that someone else could read, even for
// the moment between creating the file and fixing its mode.
test('the file that receives the secret is created with mode 0600 from the start', async () => {
  fileSystemPromises.recordedOpenCalls.length = 0;
  await writeMachineCredential(paths, exampleCredential);
  const filesCreatedInTheConfigDirectory = fileSystemPromises.recordedOpenCalls.filter((call) => call.path.startsWith(paths.configDirectory));
  const creationOfTheSecretFile = filesCreatedInTheConfigDirectory.find((call) => call.path.includes('machine.json'));
  expect(creationOfTheSecretFile?.mode).toBe(0o600);
});

test('the config directory is created private to the owner (0700)', async () => {
  await writeMachineCredential(paths, exampleCredential);
  expect(await permissionBitsOf(paths.configDirectory)).toBe(0o700);
});

test('readMachineCredential returns what writeMachineCredential wrote', async () => {
  await writeMachineCredential(paths, exampleCredential);
  expect(await readMachineCredential(paths)).toEqual(exampleCredential);
});

test('readMachineCredential returns null when this machine was never paired', async () => {
  expect(await readMachineCredential(paths)).toBeNull();
});

test('readMachineCredential refuses a damaged machine.json without echoing its contents', async () => {
  await mkdir(paths.configDirectory, { recursive: true });
  await writeFile(paths.machineCredentialFile, '{"machine_id": "abc", "machine_secret": "LEAKED-SECRET"', { mode: 0o600 });
  const failure = await readMachineCredential(paths).then(() => null, (error: Error) => error);
  expect(failure?.message).toMatch(/machine\.json is damaged/);
  expect(failure?.message).not.toContain('LEAKED-SECRET');
});
