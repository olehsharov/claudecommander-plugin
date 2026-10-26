#!/usr/bin/env node
// A stand-in for the `claude` executable, used only by the plugin's tests, so
// no test ever runs the real `claude`. It understands just the commands the
// daemon runs:
//
//   claude agents --json [--all]                 print the scripted session list
//   claude --bg -n <name> ... "<startup note>"   a launch: add a live session
//   claude --resume <sessionId> --bg "<note>"    a wake: give a stopped session a pid again
//   claude -p ... "<prompt>"                     a one-shot (the doorbell): print the scripted stream
//   claude --version, claude auth status,
//   claude mcp get <name>                        doctor's read-only questions: print the scripted answer
//
// Environment:
//   FAKE_CLAUDE_SCENARIO  path to a scenario JSON file. The fake reads it on
//                         every call and writes it back after a launch or a
//                         wake, so a later `agents --json --all` sees the change.
//   FAKE_CLAUDE_CALL_LOG  path to a file; every call appends its argument list
//                         as one JSON line.
//
// Scenario shape (every field optional):
//   {
//     "sessions": [ { ...a row of `agents --json --all`, plus "respawnFlags": [...] } ],
//     "plainListing": [ ...rows printed by `agents --json` without --all ],
//                     (when absent, the plain listing is the sessions that have a pid)
//     "rawAllListing": "text printed for `agents --json --all` instead of the sessions",
//     "livePid": 4242,              the pid a launched or woken session gets
//     "launch": { "exitCode": 0, "standardError": "...", "addsNoSession": false },
//     "wake":   { "exitCode": 0, "standardError": "..." },
//     "listingExitCode": 0, "listingStandardError": "...",
//     "standardErrorBytes": 0,      extra bytes written to stderr on every call (pipe-draining tests)
//     "sleepMilliseconds": 0,       wait this long before answering (timeout tests)
//     "oneShot": { "exitCode": 0, "streamLines": [ {...} | "raw text" ], "standardError": "..." }
//                                   what `claude -p` prints: each stream line as one line of
//                                   stdout (objects as JSON, strings as they are)
//     "version":    { "exitCode": 0, "standardOutput": "2.1.301 (Claude Code)\n", "standardError": "" },
//     "authStatus": { "exitCode": 0, "standardOutput": "{...}", "standardError": "" },
//     "mcpGet":     { "exitCode": 0, "standardOutput": "...", "standardError": "" }
//                                   what doctor's three questions print; each has a
//                                   healthy default when absent
//   }
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argumentList = process.argv.slice(2);
const scenarioFile = process.env.FAKE_CLAUDE_SCENARIO;
const callLogFile = process.env.FAKE_CLAUDE_CALL_LOG;

if (callLogFile) appendFileSync(callLogFile, JSON.stringify(argumentList) + '\n');

const scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, 'utf8')) : {};
scenario.sessions ??= [];

function saveScenario() {
  if (scenarioFile) writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));
}

// The real listing never shows respawnFlags (they live in ~/.claude/jobs/<id>/state.json).
function withoutRespawnFlags(row) {
  const { respawnFlags, ...visibleRow } = row;
  return visibleRow;
}

function finish(exitCode, standardOutput, standardError) {
  if (scenario.standardErrorBytes) process.stderr.write('e'.repeat(scenario.standardErrorBytes));
  if (standardError) process.stderr.write(standardError);
  if (standardOutput) process.stdout.write(standardOutput);
  process.exitCode = exitCode;
}

function finishWithScriptedAnswer(scriptedAnswer, healthyDefault) {
  const chosenAnswer = scriptedAnswer ?? healthyDefault;
  return finish(chosenAnswer.exitCode ?? 0, chosenAnswer.standardOutput ?? '', chosenAnswer.standardError ?? '');
}

function answer() {
  // claude agents --json [--all]
  if (argumentList[0] === 'agents') {
    const listingExitCode = scenario.listingExitCode ?? 0;
    if (listingExitCode !== 0) return finish(listingExitCode, '', scenario.listingStandardError ?? 'agents failed\n');
    if (argumentList.includes('--all')) {
      if (typeof scenario.rawAllListing === 'string') return finish(0, scenario.rawAllListing, '');
      return finish(0, JSON.stringify(scenario.sessions.map(withoutRespawnFlags), null, 2) + '\n', '');
    }
    const plainRows = scenario.plainListing ?? scenario.sessions.filter((row) => typeof row.pid === 'number');
    return finish(0, JSON.stringify(plainRows.map(withoutRespawnFlags), null, 2) + '\n', '');
  }

  // claude --resume <sessionId> --bg "<note>"
  if (argumentList[0] === '--resume') {
    const wake = scenario.wake ?? {};
    if ((wake.exitCode ?? 0) !== 0) return finish(wake.exitCode, '', wake.standardError ?? 'wake failed\n');
    const sessionId = argumentList[1];
    const row = scenario.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!row) return finish(1, '', `No session found with ID: ${sessionId}\n`);
    row.pid = scenario.livePid ?? 4242;
    row.status = 'busy';
    row.state = 'working';
    row.wokenFromDirectory = process.cwd();
    // A wake with extra flags would make a copy; the fake records which flags it restored.
    const restoredOptionNames = (row.respawnFlags ?? []).filter((flag) => flag.startsWith('-')).map((flag) => flag.split('=')[0]);
    saveScenario();
    return finish(0, `backgrounded · ${row.id} · ${row.name}\n`, `note: woke session ${row.id} with its saved options (${restoredOptionNames.join(', ')}).\n` + (wake.standardError ?? ''));
  }

  // claude -p ... "<prompt>": the doorbell's one-shot SendMessage call
  if (argumentList[0] === '-p') {
    const oneShot = scenario.oneShot ?? {};
    const streamText = (oneShot.streamLines ?? [])
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
      .join('');
    return finish(oneShot.exitCode ?? 0, streamText, oneShot.standardError ?? '');
  }

  // Doctor's read-only questions. Each answers with the scripted text, or a
  // healthy default taken from real Claude Code 2.1.301 output.
  if (argumentList.length === 1 && argumentList[0] === '--version') {
    return finishWithScriptedAnswer(scenario.version, { standardOutput: '2.1.301 (Claude Code)\n' });
  }
  if (argumentList[0] === 'auth' && argumentList[1] === 'status') {
    return finishWithScriptedAnswer(scenario.authStatus, { standardOutput: '{\n  "loggedIn": true,\n  "authMethod": "oauth_token",\n  "apiProvider": "firstParty"\n}\n' });
  }
  if (argumentList[0] === 'mcp' && argumentList[1] === 'get') {
    const serverName = argumentList[2];
    return finishWithScriptedAnswer(scenario.mcpGet, {
      standardOutput: `${serverName}:\n  Scope: Dynamic config (from command line)\n  Status: ✔ Connected\n  Type: http\n`,
    });
  }

  // claude --bg -n <name> ... "<startup note>"
  if (argumentList[0] === '--bg') {
    const launch = scenario.launch ?? {};
    if ((launch.exitCode ?? 0) !== 0) return finish(launch.exitCode, '', launch.standardError ?? 'launch failed\n');
    const sessionName = argumentList[argumentList.indexOf('-n') + 1];
    const shortId = 'fa' + String(scenario.sessions.length).padStart(6, '0');
    if (!launch.addsNoSession) {
      scenario.sessions.push({
        pid: scenario.livePid ?? 4242,
        id: shortId,
        cwd: process.cwd(),
        kind: 'background',
        sessionId: `${shortId}-0000-4000-8000-000000000000`,
        name: sessionName,
        status: 'idle',
        state: 'blocked',
        // Everything but --bg and the startup note, which is what the real supervisor saves.
        respawnFlags: argumentList.slice(1, -1),
      });
      saveScenario();
    }
    return finish(0, `Starting background service…\nbackgrounded · ${shortId} · ${sessionName}\n`, launch.standardError ?? '');
  }

  return finish(2, '', `fake claude: unexpected arguments ${JSON.stringify(argumentList)}\n`);
}

if (scenario.sleepMilliseconds) setTimeout(answer, scenario.sleepMilliseconds);
else answer();
