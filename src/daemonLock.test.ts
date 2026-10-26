// One daemon per machine: `daemon run` holds an flock on daemon.lock for its whole life.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { acquireDaemonLock, type DaemonLock } from './daemonLock.js';

const temporaryDirectories: string[] = [];
const locksToRelease: DaemonLock[] = [];

afterEach(async () => {
  for (const lock of locksToRelease.splice(0)) await lock.release();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lockFileInATemporaryStateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'claudecommander-lock-test-'));
  temporaryDirectories.push(directory);
  // The state directory may not exist yet on a fresh machine.
  return join(directory, 'state', 'daemon.lock');
}

test('the first daemon gets the lock and a second one is refused while it is held', async () => {
  const lockFile = lockFileInATemporaryStateDirectory();
  const firstLock = await acquireDaemonLock(lockFile);
  expect(firstLock).not.toBeNull();
  locksToRelease.push(firstLock!);
  expect(await acquireDaemonLock(lockFile)).toBeNull();
});

test('a released lock can be taken again', async () => {
  const lockFile = lockFileInATemporaryStateDirectory();
  const firstLock = await acquireDaemonLock(lockFile);
  await firstLock!.release();
  const secondLock = await acquireDaemonLock(lockFile);
  expect(secondLock).not.toBeNull();
  locksToRelease.push(secondLock!);
});

// The lock must belong to the kernel, not to a pid written in a file: a
// daemon killed with SIGKILL leaves no stale lock behind.
test('a lock held by a process that is killed outright is free again at once', async () => {
  const lockFile = lockFileInATemporaryStateDirectory();
  const holderScript = `
    const { acquireDaemonLock } = await import(${JSON.stringify(new URL('./daemonLock.ts', import.meta.url).href)});
    const lock = await acquireDaemonLock(${JSON.stringify(lockFile)});
    process.stdout.write(lock === null ? 'refused\\n' : 'locked\\n');
    setInterval(() => {}, 1000);
  `;
  const holder = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', holderScript], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const holderAnswer = await new Promise<string>((resolve) => holder.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim())));
    expect(holderAnswer).toBe('locked');
    expect(await acquireDaemonLock(lockFile)).toBeNull();
  } finally {
    holder.kill('SIGKILL');
  }
  await new Promise((resolve) => holder.once('exit', resolve));
  // The lock holder notices its parent is gone when the pipe on its fd 3 closes.
  let lockAfterTheKill: DaemonLock | null = null;
  for (let attempt = 0; attempt < 50 && lockAfterTheKill === null; attempt += 1) {
    lockAfterTheKill = await acquireDaemonLock(lockFile);
    if (lockAfterTheKill === null) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(lockAfterTheKill).not.toBeNull();
  locksToRelease.push(lockAfterTheKill!);
}, 20_000);

// systemd stops a service by sending SIGTERM to every process in its cgroup,
// the holder included. The holder must outlive that, so the lock is held until
// the daemon itself has finished stopping and closes the pipe.
test('SIGTERM, SIGINT and SIGHUP sent to the lock holder do not free the lock', async () => {
  const lockFile = lockFileInATemporaryStateDirectory();
  const lock = await acquireDaemonLock(lockFile);
  expect(lock).not.toBeNull();
  locksToRelease.push(lock!);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.kill(-lock!.holderProcessGroupId, signal);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await acquireDaemonLock(lockFile)).toBeNull();

  // Closing the pipe still ends it.
  locksToRelease.splice(locksToRelease.indexOf(lock!), 1);
  await lock!.release();
  const lockAfterRelease = await acquireDaemonLock(lockFile);
  expect(lockAfterRelease).not.toBeNull();
  locksToRelease.push(lockAfterRelease!);
}, 20_000);

test('a lock holder that dies before release is reported as a lost lock', async () => {
  const lockFile = lockFileInATemporaryStateDirectory();
  const warnings: string[] = [];
  const lock = await acquireDaemonLock(lockFile, { log: (line) => warnings.push(line) });
  process.kill(-lock!.holderProcessGroupId, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(warnings).toEqual([expect.stringMatching(/^WARNING: the lock holder for .*daemon\.lock exited/)]);
  await lock!.release();
  // A normal release is not reported.
  const secondWarnings: string[] = [];
  const secondLock = await acquireDaemonLock(lockFile, { log: (line) => secondWarnings.push(line) });
  await secondLock!.release();
  expect(secondWarnings).toEqual([]);
}, 20_000);
