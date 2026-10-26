import { afterEach, expect, test, vi } from 'vitest';
import { FAKE_CLAUDE_EXECUTABLE, setUpFakeClaude, type FakeClaude, type FakeClaudeScenario } from '../test/fakeClaudeHarness.js';
import { ClaudeCommandError, createClaudeCommandRunner, listBackgroundSessions } from './claudeCli.js';

// stat() is wrapped (it still runs for real) so one test can make it slow and
// force the 'close' event to arrive before the ENOENT explanation is ready.
const slowStatControl = vi.hoisted(() => ({ extraDelayMilliseconds: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actualModule = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actualModule,
    stat: async (...statArguments: Parameters<typeof actualModule.stat>) => {
      if (slowStatControl.extraDelayMilliseconds > 0) await new Promise((resolve) => setTimeout(resolve, slowStatControl.extraDelayMilliseconds));
      return actualModule.stat(...statArguments);
    },
  };
});

let fakeClaude: FakeClaude | undefined;

afterEach(() => {
  slowStatControl.extraDelayMilliseconds = 0;
  fakeClaude?.removeTemporaryFiles();
  fakeClaude = undefined;
});

function useFakeClaude(scenario: FakeClaudeScenario): FakeClaude {
  fakeClaude = setUpFakeClaude(scenario);
  return fakeClaude;
}

const allCalls = () => fakeClaude!.allCalls();
const fakeRunner = () => createClaudeCommandRunner(FAKE_CLAUDE_EXECUTABLE);

function runnerPrinting(rows: Array<Record<string, unknown>>) {
  useFakeClaude({ sessions: rows });
  return fakeRunner();
}

test('listBackgroundSessions runs agents --json --all and keeps status and waitingFor', async () => {
  const entries = await listBackgroundSessions(runnerPrinting([{ pid: 7, id: 'a1', sessionId: 's1', name: 'orchestrator', cwd: '/p', status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }, { id: 'b2', sessionId: 's2', name: 'other', cwd: '/p', state: 'done' }]));
  expect(allCalls()).toEqual([['agents', '--json', '--all']]);
  expect(entries[0]).toEqual(expect.objectContaining({ status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' }));
  expect(entries[1]).toEqual(expect.objectContaining({ pid: null, status: null, waitingFor: null }));
});

test('listBackgroundSessions maps every field, cwd to workingDirectory', async () => {
  const entries = await listBackgroundSessions(runnerPrinting([{ pid: 7, id: 'a1', sessionId: 's1', name: 'orchestrator', cwd: '/projects', kind: 'background', status: 'idle', state: 'done' }]));
  expect(entries).toEqual([{ id: 'a1', sessionId: 's1', name: 'orchestrator', kind: 'background', pid: 7, status: 'idle', waitingFor: null, state: 'done', workingDirectory: '/projects' }]);
});

test('an interactive row keeps its kind, and a row with no kind gets null', async () => {
  // The interactive row shape seen in `claude agents --json --all`: pid and status, no id, no state.
  const entries = await listBackgroundSessions(runnerPrinting([
    { pid: 7, cwd: '/p', kind: 'interactive', sessionId: 's1', name: 'orchestrator', status: 'idle' },
    { id: 'a2', sessionId: 's2', name: 'other', cwd: '/p', state: 'done' },
  ]));
  expect(entries.map((entry) => entry.kind)).toEqual(['interactive', null]);
  expect(entries[0]).toEqual(expect.objectContaining({ id: '', state: '', pid: 7 }));
});

test('a name stored with literal quotes comes back without them', async () => {
  // Seen in the wild: `"name": "\"odyssey_delivery\""`.
  const entries = await listBackgroundSessions(runnerPrinting([{ id: 'a1', sessionId: 's1', name: '"orchestrator"', cwd: '/p', state: 'done' }]));
  expect(entries[0]!.name).toBe('orchestrator');
});

test('only one pair of enclosing quotes is stripped, and a lone quote is kept', async () => {
  const entries = await listBackgroundSessions(runnerPrinting([
    { id: 'a1', sessionId: 's1', name: '""orchestrator""', cwd: '/p', state: 'done' },
    { id: 'a2', sessionId: 's2', name: '"orchestrator', cwd: '/p', state: 'done' },
    { id: 'a3', sessionId: 's3', name: '"', cwd: '/p', state: 'done' },
  ]));
  expect(entries.map((entry) => entry.name)).toEqual(['"orchestrator"', '"orchestrator', '"']);
});

test('a pid that is not a positive whole number counts as no pid', async () => {
  const entries = await listBackgroundSessions(runnerPrinting([
    { pid: '7', id: 'a1', sessionId: 's1', name: 'x', cwd: '/p', state: 'done' },
    { pid: 0, id: 'a2', sessionId: 's2', name: 'y', cwd: '/p', state: 'done' },
    { pid: -3, id: 'a3', sessionId: 's3', name: 'z', cwd: '/p', state: 'done' },
  ]));
  expect(entries.map((entry) => entry.pid)).toEqual([null, null, null]);
});

test('a row without a string name is left out; one without a sessionId is kept with an empty one', async () => {
  const entries = await listBackgroundSessions(runnerPrinting([
    { id: 'a1', sessionId: 's1', cwd: '/p', state: 'done' },
    { id: 'a2', name: 'orchestrator', cwd: '/p', state: 'done' },
  ]));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toEqual(expect.objectContaining({ name: 'orchestrator', sessionId: '' }));
});

test('an empty listing is an empty list', async () => {
  useFakeClaude({ rawAllListing: '[]\n' });
  expect(await listBackgroundSessions(fakeRunner())).toEqual([]);
});

test('a listing that is not a JSON array fails with a clear error', async () => {
  useFakeClaude({ rawAllListing: 'Error: something odd\n' });
  await expect(listBackgroundSessions(fakeRunner())).rejects.toThrow(/claude agents --json --all printed something that is not a JSON list/);
});

test('a listing that exits non-zero fails with the first line of its stderr', async () => {
  useFakeClaude({ listingExitCode: 1, listingStandardError: 'Login expired · Please run /login\nmore detail\n' });
  await expect(listBackgroundSessions(fakeRunner())).rejects.toThrow('claude agents --json --all failed (exit 1): Login expired · Please run /login');
});

test('the runner returns exit code, stdout and stderr of a finished command', async () => {
  useFakeClaude({ launch: { exitCode: 0, standardError: 'warning: hello\n' } });
  const result = await fakeRunner()(['--bg', '-n', 'name-a', 'note'], { workingDirectory: fakeClaude!.workingDirectory, timeoutMilliseconds: 10_000 });
  expect(result.exitCode).toBe(0);
  expect(result.standardOutput).toContain('backgrounded');
  expect(result.standardError).toBe('warning: hello\n');
});

test('the runner runs the command in the given working directory', async () => {
  useFakeClaude({});
  await fakeRunner()(['--bg', '-n', 'name-a', 'note'], { workingDirectory: fakeClaude!.workingDirectory, timeoutMilliseconds: 10_000 });
  expect(fakeClaude!.currentSessions()[0]!.cwd).toBe(fakeClaude!.workingDirectory);
});

test('the runner resolves (does not throw) on a non-zero exit', async () => {
  useFakeClaude({ wake: { exitCode: 1, standardError: 'Workspace not trusted.\n' } });
  const result = await fakeRunner()(['--resume', 's1', '--bg', 'note'], { workingDirectory: fakeClaude!.workingDirectory, timeoutMilliseconds: 10_000 });
  expect(result).toEqual({ exitCode: 1, standardOutput: '', standardError: 'Workspace not trusted.\n' });
});

test('the runner drains a large stderr and still finishes', async () => {
  useFakeClaude({ sessions: [], standardErrorBytes: 2_000_000 });
  const result = await fakeRunner()(['agents', '--json', '--all'], { workingDirectory: fakeClaude!.workingDirectory, timeoutMilliseconds: 10_000 });
  expect(result.exitCode).toBe(0);
  expect(result.standardOutput.trim()).toBe('[]');
});

test('a command that runs past its timeout is stopped and fails with a timeout error', async () => {
  useFakeClaude({ sessions: [], sleepMilliseconds: 5_000 });
  const startedAt = Date.now();
  await expect(fakeRunner()(['agents', '--json', '--all'], { workingDirectory: fakeClaude!.workingDirectory, timeoutMilliseconds: 300 })).rejects.toThrow(/claude agents --json --all did not finish within 300 ms/);
  expect(Date.now() - startedAt).toBeLessThan(3_000);
});

test('a missing claude executable fails with a clear spawn error instead of hanging', async () => {
  const runner = createClaudeCommandRunner('/nonexistent/directory/claude');
  const failure = runner(['agents', '--json', '--all'], { workingDirectory: '/', timeoutMilliseconds: 10_000 });
  await expect(failure).rejects.toBeInstanceOf(ClaudeCommandError);
  await expect(failure).rejects.toThrow("could not run claude: '/nonexistent/directory/claude' was not found; make sure claude is on the daemon's PATH");
});

test('a missing claude executable always rejects with the PATH message, never resolves with the close code', async () => {
  // Node emits 'error' and then 'close' (code -2) a few milliseconds later; the
  // error must win every time, not only when the race happens to go its way.
  const runner = createClaudeCommandRunner('/nonexistent/directory/claude');
  const outcomes: PromiseSettledResult<unknown>[] = [];
  for (let runNumber = 0; runNumber < 200; runNumber += 1) {
    outcomes.push(...(await Promise.allSettled([runner(['agents', '--json', '--all'], { workingDirectory: '/', timeoutMilliseconds: 10_000 })])));
  }
  const runsThatDidNotRejectWithThePathMessage = outcomes.filter(
    (outcome) => outcome.status !== 'rejected' || !String((outcome.reason as Error).message).includes("make sure claude is on the daemon's PATH"),
  );
  expect(runsThatDidNotRejectWithThePathMessage).toEqual([]);
}, 30_000);

test('a missing claude executable rejects with the PATH message even when the explanation is slower than close', async () => {
  slowStatControl.extraDelayMilliseconds = 100;
  const runner = createClaudeCommandRunner('/nonexistent/directory/claude');
  await expect(runner(['agents', '--json', '--all'], { workingDirectory: '/', timeoutMilliseconds: 10_000 })).rejects.toThrow("make sure claude is on the daemon's PATH");
});

test('a working directory that does not exist is named in the error, not blamed on claude', async () => {
  useFakeClaude({});
  await expect(fakeRunner()(['agents', '--json', '--all'], { workingDirectory: '/nonexistent/projects-root', timeoutMilliseconds: 10_000 })).rejects.toThrow("could not run claude: the working directory '/nonexistent/projects-root' does not exist");
});
