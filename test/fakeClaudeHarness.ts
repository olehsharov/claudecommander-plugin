// Test helpers around test/fakeClaude.mjs: write a scenario, point the fake at
// it, and read back the calls it received. Tests only ever run this fake,
// never the real `claude`.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CLAUDE_EXECUTABLE = join(dirname(fileURLToPath(import.meta.url)), 'fakeClaude.mjs');

export interface FakeClaudeScenario {
  sessions?: Array<Record<string, unknown>>;
  plainListing?: Array<Record<string, unknown>>;
  rawAllListing?: string;
  livePid?: number;
  launch?: { exitCode?: number; standardError?: string; addsNoSession?: boolean };
  wake?: { exitCode?: number; standardError?: string };
  listingExitCode?: number;
  listingStandardError?: string;
  standardErrorBytes?: number;
  sleepMilliseconds?: number;
  oneShot?: { exitCode?: number; streamLines?: Array<Record<string, unknown> | string>; standardError?: string };
  // Doctor's read-only questions: `claude --version`, `claude auth status`, `claude mcp get <name>`.
  version?: ScriptedClaudeAnswer;
  authStatus?: ScriptedClaudeAnswer;
  mcpGet?: ScriptedClaudeAnswer;
}

export interface ScriptedClaudeAnswer {
  exitCode?: number;
  standardOutput?: string;
  standardError?: string;
}

export interface FakeClaude {
  scenarioFile: string;
  callLogFile: string;
  workingDirectory: string;
  allCalls: () => string[][];
  lastCall: () => string[];
  currentSessions: () => Array<Record<string, unknown>>;
  removeTemporaryFiles: () => void;
}

// Writes the scenario into a fresh temporary directory and sets the two
// environment variables the fake reads (child processes inherit them).
export function setUpFakeClaude(scenario: FakeClaudeScenario): FakeClaude {
  chmodSync(FAKE_CLAUDE_EXECUTABLE, 0o755);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'claudecommander-fake-claude-'));
  const scenarioFile = join(temporaryDirectory, 'scenario.json');
  const callLogFile = join(temporaryDirectory, 'calls.jsonl');
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  writeFileSync(callLogFile, '');
  process.env.FAKE_CLAUDE_SCENARIO = scenarioFile;
  process.env.FAKE_CLAUDE_CALL_LOG = callLogFile;

  const allCalls = (): string[][] =>
    readFileSync(callLogFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);

  return {
    scenarioFile,
    callLogFile,
    workingDirectory: temporaryDirectory,
    allCalls,
    lastCall: () => allCalls().at(-1) ?? [],
    currentSessions: () => (JSON.parse(readFileSync(scenarioFile, 'utf8')) as FakeClaudeScenario).sessions ?? [],
    removeTemporaryFiles: () => {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      delete process.env.FAKE_CLAUDE_CALL_LOG;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    },
  };
}
