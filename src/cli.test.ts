import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, test } from 'vitest';
import { runDaemonCli, type DaemonCliDependencies } from './cli.js';
import { resolveDaemonPaths } from './paths.js';

let standardOutputText = '';
let standardErrorText = '';
const dependencies: DaemonCliDependencies = {
  writeStandardOutput: (text) => { standardOutputText += text; },
  writeStandardError: (text) => { standardErrorText += text; },
  // None of these tests reaches a subcommand that touches files, the network
  // or the clock, so these only satisfy the type and fail loudly if used.
  daemonPaths: resolveDaemonPaths('/nonexistent-home-for-cli-tests', {}),
  fetchFunction: (async () => { throw new Error('cli tests never call the backend'); }) as typeof fetch,
  sleep: async () => { throw new Error('cli tests never sleep'); },
};
const capturedStdout = () => standardOutputText;
const capturedStderr = () => standardErrorText;

beforeEach(() => {
  standardOutputText = '';
  standardErrorText = '';
});

const USAGE_LINE = /usage: claudecommander daemon <install\|uninstall\|pair\|run\|status\|doctor>/;

test('an unknown daemon subcommand prints usage listing install, uninstall, pair, run, status, doctor and exits 2', async () => {
  expect(await runDaemonCli(['daemon', 'frobnicate'], dependencies)).toBe(2);
  expect(capturedStderr()).toMatch(USAGE_LINE);
  expect(capturedStdout()).toBe('');
});

test('a subcommand without the daemon group is refused with usage and exits 2', async () => {
  expect(await runDaemonCli(['run'], dependencies)).toBe(2);
  expect(capturedStderr()).toMatch(USAGE_LINE);
});

test('no arguments at all, or the daemon group without a subcommand, prints usage and exits 2', async () => {
  expect(await runDaemonCli([], dependencies)).toBe(2);
  expect(await runDaemonCli(['daemon'], dependencies)).toBe(2);
  expect(capturedStderr().match(new RegExp(USAGE_LINE, 'g'))).toHaveLength(2);
});

test('--help prints usage and exits 0', async () => {
  expect(await runDaemonCli(['--help'], dependencies)).toBe(0);
  expect(await runDaemonCli(['daemon', '--help'], dependencies)).toBe(0);
  expect(capturedStdout().match(new RegExp(USAGE_LINE, 'g'))).toHaveLength(2);
  expect(capturedStderr()).toBe('');
});

test('the built bin runs without tsx installed', () => {
  const binPath = fileURLToPath(new URL('../bin/claudecommander', import.meta.url));
  const result = spawnSync(process.execPath, [binPath, '--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: '' },
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(USAGE_LINE);
});
