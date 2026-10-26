// The doorbell: tells the orchestrator session that messages are waiting, by
// id only (spec 6.2 "Ringing the doorbell", spec 7).
//
// The daemon never hands a message body, a sender name or any other outsider
// text to a model. The doorbell text is built from validated opaque ids and
// nothing else; the orchestrator fetches the bodies itself with get_message,
// where the backend has already wrapped them as a colleague's words.
//
// v1 rings with a one-shot `claude -p` whose only tool is SendMessage. The
// model is asked to send the fixed doorbell text to the orchestrator session.
// A model can answer "I sent it" without calling the tool, so a ring counts
// only when the stream shows the SendMessage tool result with success: true.
//
// success: true only means "accepted into the target's inbox". A real capture
// (Claude Code 2.1.301, .superpowers/research/2026-10-24/sendmessage-result-shapes.md)
// showed that a HELD message gets exactly the same tool result. The hold shows
// up only as a later, separate stream event:
//   {"type":"system","subtype":"informational","level":"warning",
//    "content":"Cross-session message held by the receiving session (recipient: @<name>). ..."}
// That notice is asynchronous: if the receiver decides after `claude -p` has
// exited, the stream carries no sign of the hold (Task 26 measured the notice
// about 0.5 s after the tool result, before the model's closing turn, in 3 of
// 3 runs). So `rung` means "accepted into the inbox, and no hold notice seen
// before exit", not "read". Matching the notice depends on its English
// wording, re-verified live in Task 26.
//
// This file also holds the at-most-once ledger (rung.json). The caller (the
// daemon loop) records ids in it BEFORE ringing, so a crash after a ring can
// never ring the same ids again. A missed ring is recoverable: the
// orchestrator calls check_inbox when it wakes and on every doorbell.
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ClaudeCommandError, type ClaudeCommandResult, type ClaudeCommandRunner } from './claudeCli.js';
import { firstNonEmptyLine } from './commandOutputText.js';
import { isValidOpaqueId } from './ids.js';
import { createLineAccumulator } from './lineAccumulator.js';
import { ACCEPTABLE_MODEL_PATTERN, describeSessionNameProblem } from './orchestratorKeeper.js';

export type DoorbellOutcome = { kind: 'rung' } | { kind: 'refused'; reason: string } | { kind: 'failed'; reason: string };

export interface OrchestratorDoorbell {
  ringOrchestratorDoorbell(messageIds: string[]): Promise<DoorbellOutcome>;
}

export interface RungMessageLedger {
  hasBeenRung(messageId: string): Promise<boolean>;
  recordRung(messageIds: string[]): Promise<void>;
}

// ---- the doorbell text ----

// Throws unless every id is a valid opaque id. The id alphabet (letters,
// digits, "_" and "-", at most 64 characters) cannot break a line or carry an
// instruction, so the text below is fixed apart from the ids themselves.
export function buildDoorbellText(messageIds: string[]): string {
  if (messageIds.length === 0) throw new Error('a doorbell needs at least one message id');
  for (const messageId of messageIds) {
    // The bad value is not quoted in the error: it may be outsider text.
    if (!isValidOpaqueId(messageId)) throw new Error('a doorbell can carry only valid message ids; one id was not valid');
  }
  return `claudecommander: new message(s) ${messageIds.join(', ')}. Fetch with get_message.`;
}

// The whole prompt of the one-shot model: a fixed instruction, the configured
// session name, and the doorbell text. Nothing else can reach it.
function buildOneShotPrompt(orchestratorSessionName: string, doorbellText: string): string {
  return (
    `Use the SendMessage tool once to send exactly the text below to the session named ${orchestratorSessionName}. ` +
    'Send it unchanged, add nothing to it, and do nothing else.\n\n' +
    doorbellText
  );
}

// ---- the one-shot SendMessage call ----

// About 6 s per call was measured (spec 6.2); the margin covers a slow start.
const ONE_SHOT_TIMEOUT_MILLISECONDS = 120_000;
// A reason is one line for the log and the status file; long stderr is cut.
const MAXIMUM_REASON_CHARACTERS = 300;

// Both tool flags are variadic, so they are always written with "=" (Task 2
// Q1: `--tools A B "prompt"` swallows the prompt). SendMessage never prompts
// in default mode (Task 3 Q9); --allowedTools stays as a harmless guard.
function buildOneShotArguments(model: string, prompt: string): string[] {
  return ['-p', '--tools=SendMessage', '--allowedTools=SendMessage', '--model', model, '--output-format', 'stream-json', '--verbose', prompt];
}

// What the stream said about the SendMessage calls to the orchestrator.
type SendMessageEvidence = 'delivered' | 'held_or_refused' | 'none';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocksOf(streamEvent: Record<string, unknown>): Record<string, unknown>[] {
  const message = streamEvent.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

// A tool result's content is either a string or a list of text blocks; both
// carry the SendMessage result as JSON text. The real stream also repeats the
// result as a top-level `tool_use_result` object on the same event, which is
// used when the content is not JSON. Returns null when neither is readable.
function readToolResultFields(toolResultBlock: Record<string, unknown>, streamEvent: Record<string, unknown>): Record<string, unknown> | null {
  const fieldsFromContent = readToolResultContentAsJson(toolResultBlock);
  if (fieldsFromContent !== null) return fieldsFromContent;
  return isRecord(streamEvent.tool_use_result) ? streamEvent.tool_use_result : null;
}

function readToolResultContentAsJson(toolResultBlock: Record<string, unknown>): Record<string, unknown> | null {
  let resultText = '';
  if (typeof toolResultBlock.content === 'string') {
    resultText = toolResultBlock.content;
  } else if (Array.isArray(toolResultBlock.content)) {
    for (const contentPart of toolResultBlock.content) {
      if (isRecord(contentPart) && contentPart.type === 'text' && typeof contentPart.text === 'string') resultText += contentPart.text;
    }
  }
  try {
    const parsedResult: unknown = JSON.parse(resultText);
    return isRecord(parsedResult) ? parsedResult : null;
  } catch {
    return null;
  }
}

// True when the notice names the session exactly as Claude Code writes the
// recipient: "(recipient: @<sessionName>)". Session names may contain ".",
// " " or "+", so a looser "@<name> not followed by a name character" check
// would let a notice for "orchestrator.old" count for "orchestrator". The
// wording was re-verified live in Task 26 (Claude Code 2.1.301).
function namesRecipient(text: string, sessionName: string): boolean {
  return text.includes(`(recipient: @${sessionName})`);
}

// The system/informational warning Claude Code prints when the receiving
// session holds (or refuses) a cross-session message. It has no message or
// tool-use id; the recipient's name in its text is the only link to the call.
function isHoldNoticeForSession(streamEvent: Record<string, unknown>, sessionName: string): boolean {
  return (
    streamEvent.type === 'system' &&
    streamEvent.subtype === 'informational' &&
    streamEvent.level === 'warning' &&
    typeof streamEvent.content === 'string' &&
    streamEvent.content.startsWith('Cross-session message ') &&
    namesRecipient(streamEvent.content, sessionName)
  );
}

// Reads the stream-json output line by line. Three things matter:
//   1. an assistant tool_use of SendMessage addressed to the orchestrator
//      (its id is remembered),
//   2. a user tool_result answering one of those ids, and
//   3. a hold notice naming the orchestrator.
// A result with success: true is the proof of a ring, unless a hold notice
// for the orchestrator appears anywhere in the stream: that always wins.
// success: false means the target refused it. Everything else (unknown event types, lines that
// are not JSON, results of other calls) is skipped. Nothing read here is kept
// or logged: the stream may hold the model's or the orchestrator's text.
function readSendMessageEvidence(standardOutput: string, orchestratorSessionName: string): SendMessageEvidence {
  const sendMessageToolUseIds = new Set<string>();
  let evidence: SendMessageEvidence = 'none';
  let holdNoticeSeen = false;

  const handleStreamLine = (line: string): void => {
    let streamEvent: unknown;
    try {
      streamEvent = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(streamEvent)) return;

    if (isHoldNoticeForSession(streamEvent, orchestratorSessionName)) {
      holdNoticeSeen = true;
      return;
    }

    if (streamEvent.type === 'assistant') {
      for (const block of contentBlocksOf(streamEvent)) {
        const isSendMessageToOrchestrator =
          block.type === 'tool_use' && block.name === 'SendMessage' && typeof block.id === 'string' && isRecord(block.input) && block.input.to === orchestratorSessionName;
        if (isSendMessageToOrchestrator) sendMessageToolUseIds.add(block.id as string);
      }
      return;
    }

    if (streamEvent.type === 'user') {
      for (const block of contentBlocksOf(streamEvent)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !sendMessageToolUseIds.has(block.tool_use_id)) continue;
        if (block.is_error === true) continue;
        const resultFields = readToolResultFields(block, streamEvent);
        if (resultFields === null) continue;
        // One delivered call is enough; a later refusal cannot undo it.
        if (resultFields.success === true) evidence = 'delivered';
        else if (resultFields.success === false && evidence === 'none') evidence = 'held_or_refused';
      }
    }
  };

  const acceptOutputChunk = createLineAccumulator(handleStreamLine);
  // The final newline makes the accumulator hand over a last unterminated line.
  acceptOutputChunk(standardOutput + '\n');
  if (holdNoticeSeen) return 'held_or_refused';
  return evidence;
}

function judgeOneShotResult(result: ClaudeCommandResult, orchestratorSessionName: string): DoorbellOutcome {
  if (result.exitCode !== 0) {
    return { kind: 'failed', reason: `the doorbell's claude -p call failed (exit ${result.exitCode}): ${firstNonEmptyLine(result.standardError, MAXIMUM_REASON_CHARACTERS)}` };
  }
  const evidence = readSendMessageEvidence(result.standardOutput, orchestratorSessionName);
  if (evidence === 'delivered') return { kind: 'rung' };
  // The result's own message is not quoted: it is text from the stream.
  if (evidence === 'held_or_refused') {
    return { kind: 'refused', reason: `the doorbell was held or refused by the ${orchestratorSessionName} session (check its crossSessionInbound and permission mode)` };
  }
  return { kind: 'failed', reason: `claude -p exited 0 without a successful SendMessage to ${orchestratorSessionName}` };
}

export function createOneShotSendMessageDoorbell(options: {
  runner: ClaudeCommandRunner;
  orchestratorSessionName: string;
  workingDirectory: string;
  model: string;
}): OrchestratorDoorbell {
  // The session name goes into the prompt and the model onto the command
  // line, so both are checked once, up front, with the keeper's own rules.
  const sessionNameProblem = describeSessionNameProblem(options.orchestratorSessionName);
  if (sessionNameProblem !== null) throw new Error(`the orchestrator session name ${JSON.stringify(options.orchestratorSessionName)} ${sessionNameProblem}`);
  if (!ACCEPTABLE_MODEL_PATTERN.test(options.model)) throw new Error(`the doorbell model ${JSON.stringify(options.model)} is not a model name`);

  return {
    async ringOrchestratorDoorbell(messageIds: string[]): Promise<DoorbellOutcome> {
      let doorbellText: string;
      try {
        doorbellText = buildDoorbellText(messageIds);
      } catch (error) {
        return { kind: 'failed', reason: (error as Error).message };
      }

      const oneShotArguments = buildOneShotArguments(options.model, buildOneShotPrompt(options.orchestratorSessionName, doorbellText));
      let result: ClaudeCommandResult;
      try {
        result = await options.runner(oneShotArguments, { workingDirectory: options.workingDirectory, timeoutMilliseconds: ONE_SHOT_TIMEOUT_MILLISECONDS });
      } catch (error) {
        // The runner's own one-line errors (claude not found, timed out).
        if (error instanceof ClaudeCommandError) return { kind: 'failed', reason: error.message };
        return { kind: 'failed', reason: `could not run the doorbell: ${(error as Error).message}` };
      }
      return judgeOneShotResult(result, options.orchestratorSessionName);
    },
  };
}

// ---- the at-most-once ledger (rung.json) ----

// Ids only need remembering until the backend marks the notice rung; after
// that the listener never hands it over again. The cap keeps the file small
// on a machine that runs for years; the oldest ids are dropped first.
export const MAXIMUM_REMEMBERED_RUNG_MESSAGE_IDS = 10_000;

interface RungLedgerFileContents {
  rung_message_ids: string[];
}

// Also used by doctor, which only reads the ledger and never writes it.
export async function readRungMessageIds(filePath: string): Promise<string[]> {
  let fileText: string;
  try {
    fileText = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // A broken file is an error, never "nothing rung yet": treating it as empty
  // could ring ids a second time. Writes are atomic, so this should not happen.
  let parsedContents: unknown;
  try {
    parsedContents = JSON.parse(fileText);
  } catch {
    parsedContents = undefined;
  }
  if (!isRecord(parsedContents) || !Array.isArray(parsedContents.rung_message_ids) || !parsedContents.rung_message_ids.every((value) => typeof value === 'string')) {
    throw new Error(`the doorbell ledger ${filePath} is not readable; fix or remove it`);
  }
  return parsedContents.rung_message_ids as string[];
}

// Write to a temporary file next to the ledger, sync it to disk, then rename
// it over the ledger. A rename within one directory is atomic, so a crash
// leaves either the old ledger or the new one, never half of one. The sync
// comes first because without it a power cut just after the rename can leave
// a renamed but empty file.
async function writeRungMessageIdsAtomically(filePath: string, rungMessageIds: string[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryFile = join(dirname(filePath), `.rung-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  const contents: RungLedgerFileContents = { rung_message_ids: rungMessageIds };
  const temporaryFileHandle = await open(temporaryFile, 'w', 0o600);
  try {
    await temporaryFileHandle.writeFile(JSON.stringify(contents, null, 2) + '\n', 'utf8');
    await temporaryFileHandle.sync();
  } finally {
    await temporaryFileHandle.close();
  }
  await rename(temporaryFile, filePath);
}

export function openRungMessageLedger(filePath: string): RungMessageLedger {
  // Writes run one after another, each reading the latest file, so two
  // overlapping recordRung calls never lose each other's ids.
  let previousWrite: Promise<void> = Promise.resolve();

  return {
    async hasBeenRung(messageId: string): Promise<boolean> {
      await previousWrite.catch(() => undefined);
      const rungMessageIds = await readRungMessageIds(filePath);
      return rungMessageIds.includes(messageId);
    },

    recordRung(messageIds: string[]): Promise<void> {
      const thisWrite = previousWrite
        .catch(() => undefined)
        .then(async () => {
          const rungMessageIds = await readRungMessageIds(filePath);
          const alreadyRecorded = new Set(rungMessageIds);
          for (const messageId of messageIds) {
            if (alreadyRecorded.has(messageId)) continue;
            rungMessageIds.push(messageId);
            alreadyRecorded.add(messageId);
          }
          const newestRungMessageIds = rungMessageIds.slice(-MAXIMUM_REMEMBERED_RUNG_MESSAGE_IDS);
          await writeRungMessageIdsAtomically(filePath, newestRungMessageIds);
        });
      previousWrite = thisWrite;
      return thisWrite;
    },
  };
}
