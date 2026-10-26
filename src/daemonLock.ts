// One daemon per machine. Two daemons would each hand over the same notices,
// race on rung.json and run two keepers that could launch two orchestrators.
//
// `daemon run` therefore holds an exclusive flock(2) on
// <stateDirectory>/daemon.lock for its whole life. Node has no flock call of
// its own, so the lock is taken by util-linux's flock(1) on behalf of a tiny
// holder process:
//
//   daemon ──pipe on fd 3──> flock --nonblock <lock file> node -e <holder>
//
// flock takes the lock, then runs the holder, which prints "locked" and waits
// for its end of the pipe to close. The pipe is fd 3, not stdin: Node
// destroys a child's stdin as soon as that child (flock) exits, which would
// end the holder too if flock alone were killed. The daemon keeps that pipe open; when the daemon
// exits for any reason (even SIGKILL) the kernel closes the pipe, the holder
// and flock exit, and the kernel drops the lock. Nothing is left behind to go
// stale, unlike a pid written in a file. Linux only for now (spec: Linux
// first); macOS has no flock(1) and needs another holder when launchd lands.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DaemonLock {
  release(): Promise<void>;
  // The holder's process group (flock and the node holder in it), for
  // diagnostics and for tests that signal the holder.
  readonly holderProcessGroupId: number;
}

// flock's own exit code for "someone else holds the lock" (chosen here so it
// cannot be confused with the holder's or flock's other failures).
const LOCK_IS_HELD_EXIT_CODE = 75;
const LOCKED_SIGNAL = 'locked';

// Runs inside the holder. Exits only when the daemon's end of the pipe closes.
// systemd stops a service by sending SIGTERM to every process in its cgroup,
// the holder included; a holder that died then would drop the lock while the
// daemon is still stopping, and a new daemon could start beside it. So the
// stop signals are ignored. flock(1) itself may die of them: the holder
// inherited flock's lock descriptor, so the lock stays held until it exits.
const HOLDER_SCRIPT = [
  "for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});",
  `process.stdout.write(${JSON.stringify(LOCKED_SIGNAL + '\n')});`,
  "const pipeFromTheDaemon = new (require('net').Socket)({ fd: 3, readable: true, writable: false });",
  "for (const ending of ['end', 'close', 'error']) pipeFromTheDaemon.on(ending, () => process.exit(0));",
  'pipeFromTheDaemon.resume();',
].join(' ');

// Resolves to the lock, or to null when another daemon holds it. Throws when
// the lock could not be tried at all (no flock command, unwritable directory).
// options.log gets a warning if the holder ever exits before release(): the
// lock is then gone and a second daemon could start.
export async function acquireDaemonLock(lockFile: string, options: { log?: (line: string) => void } = {}): Promise<DaemonLock | null> {
  await mkdir(dirname(lockFile), { recursive: true });

  const holder = spawn('flock', ['--nonblock', '--conflict-exit-code', String(LOCK_IS_HELD_EXIT_CODE), lockFile, process.execPath, '-e', HOLDER_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    // Its own process group, so a Ctrl-C meant for a foreground `daemon run`
    // does not kill the holder (and drop the lock) before the daemon has stopped.
    detached: true,
  });

  // Both pipes are set to 'pipe' above, so they exist; the four-entry stdio
  // list only hides that from the types.
  const holderStandardOutput = holder.stdout!;
  const holderStandardError = holder.stderr!;
  const holderExited = new Promise<number | null>((resolve) => holder.once('close', (exitCode) => resolve(exitCode)));

  const acquired = await new Promise<boolean>((resolve, reject) => {
    let standardOutput = '';
    let standardError = '';
    holderStandardOutput.setEncoding('utf8');
    holderStandardError.setEncoding('utf8');
    holderStandardOutput.on('data', (text: string) => {
      standardOutput += text;
      if (standardOutput.includes(LOCKED_SIGNAL)) resolve(true);
    });
    holderStandardError.on('data', (text: string) => { standardError += text; });
    holder.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') reject(new Error('the flock command (util-linux) was not found; it is needed to make sure only one daemon runs'));
      else reject(new Error(`could not run flock for ${lockFile}: ${error.message}`));
    });
    void holderExited.then((exitCode) => {
      if (exitCode === LOCK_IS_HELD_EXIT_CODE) resolve(false);
      else reject(new Error(`could not lock ${lockFile} (flock exit ${exitCode}): ${standardError.trim() || 'no error output'}`));
    });
  });
  if (!acquired) return null;

  // The holder's output is not needed any more, but must keep draining.
  holderStandardOutput.resume();
  holderStandardError.resume();

  const pipeToTheHolder = holder.stdio[3] as NodeJS.WritableStream;
  let releaseRequested = false;
  void holderExited.then((exitCode) => {
    if (releaseRequested) return;
    options.log?.(`WARNING: the lock holder for ${lockFile} exited (exit ${exitCode}) while the daemon still runs; another daemon could now start on this machine`);
  });

  return {
    holderProcessGroupId: holder.pid!,
    async release() {
      releaseRequested = true;
      pipeToTheHolder.end();
      await holderExited;
    },
  };
}
