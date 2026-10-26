import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { OPAQUE_ID_PATTERN } from './ids.js';

const pluginDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(pluginDirectory, '..');
const builtBundlePath = join(pluginDirectory, 'dist', 'cli.js');

// Some checks look outside plugin/, at the private repository it lives in
// today. After `git subtree split` the public repository has no such parent,
// so those checks skip there instead of failing its CI.
function isInsideThePrivateRepository(): boolean {
  const parentPackageJsonPath = join(repositoryRoot, 'package.json');
  if (!existsSync(parentPackageJsonPath)) return false;
  return JSON.parse(readFileSync(parentPackageJsonPath, 'utf8')).name === 'claudecommander';
}
const outsidePrivateRepository = !isInsideThePrivateRepository();

test.skipIf(outsidePrivateRepository)('plugin/dist/cli.js is tracked by git, not ignored', () => {
  expect(execFileSync('git', ['ls-files', 'plugin/dist/cli.js'], { cwd: repositoryRoot }).toString().trim()).toBe('plugin/dist/cli.js');
});

// A `./path` install runs the plugin from its source folder, and `daemon
// install` copies only dist/ to the stable daemon directory: neither has a
// node_modules. The bundle must therefore run entirely on its own.
test('dist/cli.js runs daemon --help when copied alone into an empty temp directory with NODE_PATH empty', () => {
  const emptyDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-dist-alone-'));
  try {
    cpSync(join(pluginDirectory, 'dist'), emptyDirectory, { recursive: true });
    const run = spawnSync(process.execPath, [join(emptyDirectory, 'cli.js'), 'daemon', '--help'], {
      cwd: emptyDirectory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: '' },
    });
    const result = { exitCode: run.status, standardError: run.stderr };
    expect(result.standardError).toBe('');
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(emptyDirectory, { recursive: true, force: true });
  }
});

// Guard for Task 17, which brings in the firebase client SDK: it must be
// inlined, because there is no node_modules next to the installed bundle.
test('the bundle has no bare firebase import', () => {
  const bundleText = readFileSync(builtBundlePath, 'utf8');
  expect(bundleText).not.toMatch(/(from\s*|import\(|require\()['"]firebase/);
});

// Since Task 20 main.ts reaches the backend connection through `daemon run`,
// so the test above sees firebase too. This also bundles backendConnection.ts
// on its own with the same build and loads it alone, the way an installed daemon would.
test('the firebase-backed backend connection bundles with no bare imports and loads with no node_modules', () => {
  const bundleDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-connection-bundle-'));
  try {
    execFileSync(process.execPath, ['build.mjs', '--outdir', bundleDirectory, '--entry', 'src/backendConnection.ts'], { cwd: pluginDirectory });
    const bundleText = readFileSync(join(bundleDirectory, 'cli.js'), 'utf8');
    expect(bundleText).not.toMatch(/(from\s*|import\(|require\()['"](firebase|@firebase|@grpc)/);
    const loadScript = "const loaded = await import('./cli.js'); process.stdout.write(typeof loaded.connectToBackend);";
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', loadScript], {
      cwd: bundleDirectory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: '' },
    });
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('function');
  } finally {
    rmSync(bundleDirectory, { recursive: true, force: true });
  }
}, 60_000);

// Installs never run a build, so the committed bundle is what users get. A
// fresh build into a temp directory must be byte-identical to it; when this
// fails, run `npm --prefix plugin run build` and commit plugin/dist/.
test('the committed dist/cli.js is identical to a fresh build of src/', () => {
  const freshBuildDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-fresh-build-'));
  try {
    execFileSync(process.execPath, ['build.mjs', '--outdir', freshBuildDirectory], { cwd: pluginDirectory });
    expect(readFileSync(join(freshBuildDirectory, 'cli.js'), 'utf8')).toBe(readFileSync(builtBundlePath, 'utf8'));
  } finally {
    rmSync(freshBuildDirectory, { recursive: true, force: true });
  }
}, 30_000);

test('plugin/tsconfig.json extends nothing outside plugin/', () => {
  const extendsValue = JSON.parse(readFileSync(join(pluginDirectory, 'tsconfig.json'), 'utf8')).extends;
  expect(extendsValue === undefined || !String(extendsValue).startsWith('..')).toBe(true);
});

test('plugin/package.json declares its own build and test tooling', () => {
  const devDependencies = JSON.parse(readFileSync(join(pluginDirectory, 'package.json'), 'utf8')).devDependencies;
  for (const name of ['typescript', 'esbuild', 'vitest']) expect(devDependencies).toHaveProperty(name);
});

test('plugin/package.json is version 0.1.0 and exposes bin/claudecommander', () => {
  const packageJson = JSON.parse(readFileSync(join(pluginDirectory, 'package.json'), 'utf8'));
  expect(packageJson.version).toBe('0.1.0');
  expect(packageJson.bin).toEqual({ claudecommander: 'bin/claudecommander' });
});

// The test run must use plugin/'s own vitest, not one found by walking up to
// the private repository's node_modules: a workspace hoist would hide a
// missing devDependency until the public repository's CI ran.
test('the running vitest is the one installed in plugin/node_modules', () => {
  expect(existsSync(join(pluginDirectory, 'node_modules', 'vitest', 'package.json'))).toBe(true);
  expect(process.argv.some((argument) => argument.startsWith(join(pluginDirectory, 'node_modules')))).toBe(true);
});

test.skipIf(outsidePrivateRepository)('the root workspaces never include plugin', () => {
  expect(JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).workspaces).not.toContain('plugin');
});

// The plugin's id check is a copy, so make sure the copy has not drifted from
// shared/src/ids.ts while both live in this repository. The path is built at
// run time so tsc never follows it outside plugin/.
test.skipIf(outsidePrivateRepository)("the plugin's OPAQUE_ID_PATTERN is the same as shared's", async () => {
  const sharedIdsModulePath = join(repositoryRoot, 'shared', 'src', 'ids.ts');
  const sharedIds = (await import(sharedIdsModulePath)) as { OPAQUE_ID_PATTERN: RegExp };
  expect(OPAQUE_ID_PATTERN.source).toBe(sharedIds.OPAQUE_ID_PATTERN.source);
  expect(OPAQUE_ID_PATTERN.flags).toBe(sharedIds.OPAQUE_ID_PATTERN.flags);
});
