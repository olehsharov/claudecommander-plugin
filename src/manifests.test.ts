import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { MCP_SERVER_KEY_IN_MCP_JSON, PLUGIN_MCP_SERVER_NAME, PLUGIN_MCP_TOOL_PREFIX } from './pluginMcpNames.js';

// Every path here is relative to plugin/, so these checks run the same way
// after plugin/ becomes the root of its own public repository.
const pluginDirectory = fileURLToPath(new URL('..', import.meta.url));

const PRODUCTION_MCP_ENDPOINT = 'https://claudecommander-1cf54c.web.app/mcp';

function readJsonFileInPlugin(relativePath: string) {
  return JSON.parse(readFileSync(join(pluginDirectory, relativePath), 'utf8'));
}

// Claude Code loads both shapes (plan Task 3 question 3): the documented one
// with an "mcpServers" wrapper, and a flat one keyed by server name.
function serversDeclaredInMcpJson(): Record<string, Record<string, unknown>> {
  const mcpJson = readJsonFileInPlugin('.mcp.json');
  return mcpJson.mcpServers ?? mcpJson;
}

function claudeCodeIsInstalled(): boolean {
  return spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
}

test('the marketplace lists exactly one plugin named claudecommander sourced from the repo root', () => {
  const marketplace = readJsonFileInPlugin('.claude-plugin/marketplace.json');
  expect(marketplace.name).toBe('claudecommander');
  expect(marketplace.plugins).toHaveLength(1);
  expect(marketplace.plugins[0].name).toBe('claudecommander');
  expect(marketplace.plugins[0].source).toBe('./');
});

test('the marketplace source folder holds a plugin.json whose name matches the marketplace entry', () => {
  // The plugin id Claude Code shows is <plugin name>@<marketplace name>.
  const marketplace = readJsonFileInPlugin('.claude-plugin/marketplace.json');
  const pluginSourceFolder = resolve(pluginDirectory, marketplace.plugins[0].source);
  const pluginManifestPath = join(pluginSourceFolder, '.claude-plugin', 'plugin.json');
  expect(existsSync(pluginManifestPath)).toBe(true);
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
  expect(`${pluginManifest.name}@${marketplace.name}`).toBe('claudecommander@claudecommander');
  expect(pluginManifest.description).toEqual(expect.any(String));
});

test('every relative path the manifests and package.json reference exists inside plugin/', () => {
  const marketplace = readJsonFileInPlugin('.claude-plugin/marketplace.json');
  const packageJson = readJsonFileInPlugin('package.json');
  const referencedPaths: string[] = [
    ...marketplace.plugins.map((plugin: { source: string }) => plugin.source),
    ...Object.values(packageJson.bin as Record<string, string>),
    '.mcp.json',
    'dist/cli.js',
  ];
  for (const referencedPath of referencedPaths) {
    const absolutePath = resolve(pluginDirectory, referencedPath);
    // A path that climbs out of plugin/ would break once plugin/ is its own repository.
    expect(absolutePath.startsWith(resolve(pluginDirectory))).toBe(true);
    expect(existsSync(absolutePath), `${referencedPath} should exist`).toBe(true);
  }
});

test('.mcp.json points the claudecommander server at the production /mcp endpoint over http transport', () => {
  const server = serversDeclaredInMcpJson()[MCP_SERVER_KEY_IN_MCP_JSON];
  expect(server.type).toBe('http');
  expect(server.url).toBe(PRODUCTION_MCP_ENDPOINT);
});

test('.mcp.json declares the claudecommander server with only type and url', () => {
  // No oauth block: discovery already gives the same login, and a wrong-typed
  // field there makes the plugin loader silently drop the server.
  const server = serversDeclaredInMcpJson()[MCP_SERVER_KEY_IN_MCP_JSON];
  expect(Object.keys(server).sort()).toEqual(['type', 'url']);
});

test('plugin.json version equals package.json version and is at least 0.1.0', () => {
  // The plugin cache is keyed by version, and versions 0.0.1 and 0.0.2 hold
  // leftover spike copies, so the real plugin starts at 0.1.0.
  const pluginVersion = readJsonFileInPlugin('.claude-plugin/plugin.json').version;
  const packageVersion = readJsonFileInPlugin('package.json').version;
  expect(pluginVersion).toBe(packageVersion);
  const [major, minor] = pluginVersion.split('.').map(Number);
  expect(major > 0 || minor >= 1).toBe(true);
});

test('marketplace.json has a top-level description, which validate --strict requires', () => {
  expect(readJsonFileInPlugin('.claude-plugin/marketplace.json').description).toEqual(expect.any(String));
});

// Runs only where Claude Code is installed (the CI workflow installs it first).
// A throwaway HOME and config directory keep the real ~/.claude untouched.
test.skipIf(!claudeCodeIsInstalled())('claude plugin validate . --strict exits 0', () => {
  const throwawayHome = mkdtempSync(join(tmpdir(), 'claudecommander-validate-home-'));
  try {
    const validation = spawnSync('claude', ['plugin', 'validate', '.', '--strict'], {
      cwd: pluginDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: throwawayHome, CLAUDE_CONFIG_DIR: join(throwawayHome, '.claude') },
    });
    expect(validation.stdout + validation.stderr).toContain('Validation passed');
    expect(validation.status).toBe(0);
  } finally {
    rmSync(throwawayHome, { recursive: true, force: true });
  }
}, 60_000);

// The plugin has no YAML parser among its dependencies, so these checks match
// whole lines (anchored with ^ and $ in multiline mode) instead of parsing.
function readWorkflowText(): string {
  return readFileSync(join(pluginDirectory, '.github/workflows/validate.yml'), 'utf8');
}

test('the CI workflow runs on pushes to main only, and on every pull request', () => {
  const workflow = readWorkflowText();
  expect(workflow).toMatch(/^on:\n  push:\n    branches: \[main\]\n  pull_request:\n/m);
});

test('the CI workflow token can only read the repository contents', () => {
  expect(readWorkflowText()).toMatch(/^permissions:\n  contents: read\n/m);
});

test('the CI workflow installs, tests, typechecks and runs claude plugin validate . --strict', () => {
  const workflow = readWorkflowText();
  const requiredRunSteps = ['npm ci', 'npm install -g @anthropic-ai/claude-code@2.1.301', 'npm test', 'npm run typecheck', 'claude plugin validate . --strict'];
  for (const requiredRunStep of requiredRunSteps) {
    const escapedRunStep = requiredRunStep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(workflow).toMatch(new RegExp(`^        run: ${escapedRunStep}$`, 'm'));
  }
  expect(workflow).toMatch(/^          node-version: '22'$/m);
});

test('the CI workflow pins every action to a full commit SHA with its version tag in a comment', () => {
  const usesLines = readWorkflowText().match(/^\s*- uses: .*$/gm) ?? [];
  expect(usesLines.length).toBeGreaterThanOrEqual(2);
  for (const usesLine of usesLines) expect(usesLine).toMatch(/^\s*- uses: actions\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
});

test('dependabot keeps the pinned GitHub Actions up to date every week', () => {
  const dependabotConfig = readFileSync(join(pluginDirectory, '.github/dependabot.yml'), 'utf8');
  expect(dependabotConfig).toMatch(/^  - package-ecosystem: github-actions$/m);
  expect(dependabotConfig).toMatch(/^      interval: weekly$/m);
});

// plugin/.gitignore must not drop the committed bundle, because installs never build.
// After the public split plugin/ is the repository root, so ask git from inside plugin/.
test('git does not ignore dist/cli.js, but does ignore node_modules/', () => {
  const askGitWhetherIgnored = (relativePath: string) =>
    spawnSync('git', ['check-ignore', '--no-index', '--quiet', relativePath], { cwd: pluginDirectory }).status;
  // git check-ignore exits 0 when the path is ignored and 1 when it is not.
  expect(askGitWhetherIgnored('dist/cli.js')).toBe(1);
  expect(askGitWhetherIgnored('node_modules/some-package/index.js')).toBe(0);
  expect(readFileSync(join(pluginDirectory, '.gitignore'), 'utf8')).toMatch(/^node_modules\/$/m);
});

test('the plugin ships no monitors/ directory in v1', () => {
  // A plugin monitor would run in every session that loads the plugin.
  expect(existsSync(join(pluginDirectory, 'monitors'))).toBe(false);
  expect(readJsonFileInPlugin('.claude-plugin/plugin.json').monitors).toBeUndefined();
});

test('the exported MCP tool-name constant matches the .mcp.json server key under the plugin namespacing rule', () => {
  expect(Object.keys(serversDeclaredInMcpJson())).toEqual([MCP_SERVER_KEY_IN_MCP_JSON]);
  expect(PLUGIN_MCP_SERVER_NAME).toBe(`plugin:claudecommander:${MCP_SERVER_KEY_IN_MCP_JSON}`);
  expect(PLUGIN_MCP_TOOL_PREFIX).toBe(`mcp__plugin_claudecommander_${MCP_SERVER_KEY_IN_MCP_JSON}__`);
});

test('every bin/ entry is executable by its owner, group and others', () => {
  const packageJson = readJsonFileInPlugin('package.json');
  for (const binPath of Object.values(packageJson.bin as Record<string, string>)) {
    const permissionBits = statSync(join(pluginDirectory, binPath)).mode & 0o777;
    expect(permissionBits & 0o111, `${binPath} should be executable`).toBe(0o111);
  }
});

test('bin/claudecommander passes its arguments through and hands back the CLI exit status', () => {
  const run = spawnSync(join(pluginDirectory, 'bin', 'claudecommander'), ['daemon', 'bogus-sub'], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_PATH: '', NODE_OPTIONS: '' },
  });
  expect(run.stderr).toMatch(/^usage:/m);
  expect(run.status).toBe(2);
});

// Claude Code puts the installed plugin's bin/ on the Bash PATH, so the entry
// is started from some other directory, and may be reached through a symlink.
// It must still find dist/cli.js next to itself.
test('bin/claudecommander runs dist/cli.js relative to itself, from another directory and through a symlink', () => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-bin-'));
  try {
    const installedPluginCopy = join(scratchDirectory, 'installed-plugin');
    cpSync(join(pluginDirectory, 'bin'), join(installedPluginCopy, 'bin'), { recursive: true });
    cpSync(join(pluginDirectory, 'dist'), join(installedPluginCopy, 'dist'), { recursive: true });
    cpSync(join(pluginDirectory, 'package.json'), join(installedPluginCopy, 'package.json'));
    chmodSync(join(installedPluginCopy, 'bin', 'claudecommander'), 0o755);

    const directoryOnPath = join(scratchDirectory, 'on-path');
    mkdirSync(directoryOnPath);
    symlinkSync(join(installedPluginCopy, 'bin', 'claudecommander'), join(directoryOnPath, 'claudecommander'));

    const unrelatedWorkingDirectory = join(scratchDirectory, 'somewhere-else');
    mkdirSync(unrelatedWorkingDirectory);

    for (const commandToRun of [join(installedPluginCopy, 'bin', 'claudecommander'), 'claudecommander']) {
      const run = spawnSync(commandToRun, ['daemon', '--help'], {
        cwd: unrelatedWorkingDirectory,
        encoding: 'utf8',
        env: { PATH: `${directoryOnPath}:${process.env.PATH}`, NODE_PATH: '', NODE_OPTIONS: '' },
      });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('daemon');
    }
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}, 30_000);
