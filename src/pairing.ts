// `claudecommander daemon pair`: attaches this machine to the person's account
// through the backend's device-style flow (spec 4 step 11, spec 6.1):
//   1. POST /pair/start answers a pairing id, a short user code and a lifetime;
//   2. we print only the user code. The person's own Claude session approves it
//      with the MCP tool approve_machine_pairing;
//   3. we POST /pair/poll with the pairing id every 3 s until the backend says
//      approved (with the machine id and the machine secret, handed out once)
//      or expired;
//   4. we save the credential (machineCredential.ts) and print who we are
//      paired for.
//
// This command runs inside Claude's Bash tool, so everything it prints, and
// every error message it raises, lands in a model's context. Two values must
// therefore never appear in any of it:
//   - the machine secret, which is this machine's credential;
//   - the pairing id, which is what collects the secret, so until the pairing
//     ends it is worth as much as the secret itself.
// Anything else we print that came from the backend (the user code, the
// machine id, the approver's email) is checked or cleaned first, and an error
// answer's body is never repeated, only its HTTP status.
import { isValidOpaqueId } from './ids.js';
import { writeMachineCredential } from './machineCredential.js';
import type { DaemonPaths } from './paths.js';

export const DEFAULT_BACKEND_URL = 'https://claudecommander-1cf54c.web.app';

const DEFAULT_POLL_INTERVAL_MILLISECONDS = 3000;
// The backend's codes: four consonants, a dash, four digits (pairing.ts in the backend).
const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXYZ]{4}-[0-9]{4}$/;
// The backend gives pairings 5 minutes; anything above an hour is not a real answer.
const LONGEST_BELIEVABLE_PAIRING_LIFETIME_SECONDS = 3600;
// How long we wait out a busy backend at /pair/start before giving up.
const LONGEST_WAIT_FOR_A_BUSY_BACKEND_MILLISECONDS = 5 * 60 * 1000;
// Used when a 503 has no usable Retry-After header. The backend sends 60.
const DEFAULT_BUSY_RETRY_MILLISECONDS = 60 * 1000;
// A Retry-After above this is treated as this, so one odd header cannot stall us.
const LONGEST_RETRY_AFTER_MILLISECONDS = 5 * 60 * 1000;
// Emails are at most 254 characters; the cap keeps a strange value short.
const LONGEST_PRINTED_EMAIL_LENGTH = 254;

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

// A pairing that cannot go on. Its message is safe to print as it is.
export class PairingFailure extends Error {}

export interface PairThisMachineOptions {
  backendUrl: string;
  paths: DaemonPaths;
  fetchFunction: typeof fetch;
  printLine: (line: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMilliseconds?: number;
}

// What one POST to the backend came back with. `parsedBody` is undefined when
// the body was not JSON (a framework's HTML error page, for example).
type BackendAnswer =
  | { kind: 'unreachable' }
  | { kind: 'answered'; httpStatus: number; parsedBody: unknown; retryAfterMilliseconds: number | null };

// Retry-After is either a number of seconds or an HTTP date. Anything else,
// or a time already past, counts as absent.
function readRetryAfterMilliseconds(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const trimmedValue = headerValue.trim();
  let milliseconds: number;
  if (/^[0-9]+$/.test(trimmedValue)) {
    milliseconds = Number(trimmedValue) * 1000;
  } else {
    const retryTime = Date.parse(trimmedValue);
    if (Number.isNaN(retryTime)) return null;
    milliseconds = retryTime - Date.now();
  }
  if (milliseconds <= 0) return null;
  return Math.min(milliseconds, LONGEST_RETRY_AFTER_MILLISECONDS);
}

async function postJsonToBackend(options: PairThisMachineOptions, endpointPath: string, requestBody: unknown): Promise<BackendAnswer> {
  const endpointUrl = `${options.backendUrl.replace(/\/+$/, '')}${endpointPath}`;
  let response: Response;
  let responseText: string;
  try {
    response = await options.fetchFunction(endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    responseText = await response.text();
  } catch {
    // The error itself is not shown: it says nothing the person can act on
    // beyond "could not reach", and we keep error text from outside short.
    return { kind: 'unreachable' };
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(responseText);
  } catch {
    parsedBody = undefined;
  }
  return {
    kind: 'answered',
    httpStatus: response.status,
    parsedBody,
    retryAfterMilliseconds: readRetryAfterMilliseconds(response.headers.get('Retry-After')),
  };
}

function backendRefusedError(httpStatus: number): PairingFailure {
  return new PairingFailure(`the backend refused the pairing request (HTTP ${httpStatus}); run claudecommander daemon pair again, and if it keeps failing, check the backend URL`);
}

function unexpectedAnswerError(endpointPath: string): PairingFailure {
  return new PairingFailure(`the backend gave an unexpected answer to ${endpointPath}; check the backend URL and try again`);
}

const EXPIRED_ERROR_MESSAGE = 'the pairing code expired before it was approved; run claudecommander daemon pair again for a new code';

// Removes control, format (including bidi) and line-separator characters, so
// the approver's email prints as one plain line. The backend already does
// this; doing it again here costs nothing.
function cleanForOneLineOfOutput(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, LONGEST_PRINTED_EMAIL_LENGTH);
}

interface StartedPairing {
  pairingId: string;
  userCode: string;
  lifetimeSeconds: number;
}

// POST /pair/start, waiting out a busy backend (503) for as long as its
// Retry-After asks, up to LONGEST_WAIT_FOR_A_BUSY_BACKEND_MILLISECONDS in all.
async function startPairing(options: PairThisMachineOptions): Promise<StartedPairing> {
  let millisecondsWaitedForBusyBackend = 0;
  for (;;) {
    const answer = await postJsonToBackend(options, '/pair/start', {});
    if (answer.kind === 'unreachable') {
      throw new PairingFailure(`could not reach the backend at ${options.backendUrl}; check the network and try again`);
    }
    if (answer.httpStatus === HTTP_STATUS_SERVICE_UNAVAILABLE) {
      const waitMilliseconds = answer.retryAfterMilliseconds ?? DEFAULT_BUSY_RETRY_MILLISECONDS;
      if (millisecondsWaitedForBusyBackend + waitMilliseconds > LONGEST_WAIT_FOR_A_BUSY_BACKEND_MILLISECONDS) {
        throw new PairingFailure('the pairing service is still busy; try claudecommander daemon pair again in a few minutes');
      }
      options.printLine(`The pairing service is busy; trying again in ${Math.ceil(waitMilliseconds / 1000)} seconds`);
      await options.sleep(waitMilliseconds);
      millisecondsWaitedForBusyBackend += waitMilliseconds;
      continue;
    }
    if (answer.httpStatus !== HTTP_STATUS_OK) throw backendRefusedError(answer.httpStatus);

    // Every field is checked before anything is printed: the user code is
    // the one value from this answer that goes on screen.
    const startBody = answer.parsedBody as { pairing_id?: unknown; user_code?: unknown; expires_in?: unknown } | null | undefined;
    const pairingId = startBody?.pairing_id;
    const userCode = startBody?.user_code;
    const lifetimeSeconds = startBody?.expires_in;
    if (
      !isValidOpaqueId(pairingId) ||
      typeof userCode !== 'string' ||
      !USER_CODE_PATTERN.test(userCode) ||
      typeof lifetimeSeconds !== 'number' ||
      !Number.isInteger(lifetimeSeconds) ||
      lifetimeSeconds <= 0 ||
      lifetimeSeconds > LONGEST_BELIEVABLE_PAIRING_LIFETIME_SECONDS
    ) {
      throw unexpectedAnswerError('/pair/start');
    }
    return { pairingId, userCode, lifetimeSeconds };
  }
}

interface ApprovedPairing {
  machineId: string;
  machineSecret: string;
  approverEmail: string;
}

// POST /pair/poll every poll interval until approved, expired, or our own
// count of the pairing's lifetime runs out (the backend's word is final, but
// we do not poll forever if it never says expired).
async function waitForApproval(options: PairThisMachineOptions, pairing: StartedPairing): Promise<ApprovedPairing> {
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const pairingLifetimeMilliseconds = pairing.lifetimeSeconds * 1000;
  let millisecondsWaited = 0;
  let nextWaitMilliseconds = pollIntervalMilliseconds;

  for (;;) {
    const millisecondsLeft = pairingLifetimeMilliseconds - millisecondsWaited;
    if (millisecondsLeft <= 0) throw new PairingFailure(EXPIRED_ERROR_MESSAGE);
    const waitMilliseconds = Math.min(nextWaitMilliseconds, millisecondsLeft);
    await options.sleep(waitMilliseconds);
    millisecondsWaited += waitMilliseconds;
    nextWaitMilliseconds = pollIntervalMilliseconds;

    const answer = await postJsonToBackend(options, '/pair/poll', { pairing_id: pairing.pairingId });
    // A dropped connection or a server error is probably passing: keep polling
    // until the pairing's time is up.
    if (answer.kind === 'unreachable') continue;
    if (answer.httpStatus === HTTP_STATUS_SERVICE_UNAVAILABLE) {
      nextWaitMilliseconds = Math.max(pollIntervalMilliseconds, answer.retryAfterMilliseconds ?? pollIntervalMilliseconds);
      continue;
    }
    if (answer.httpStatus >= 500) continue;
    if (answer.httpStatus !== HTTP_STATUS_OK) throw backendRefusedError(answer.httpStatus);

    const pollBody = answer.parsedBody as
      | { status?: unknown; machine_id?: unknown; machine_secret?: unknown; approved_by_email?: unknown }
      | null
      | undefined;
    if (pollBody?.status === 'pending') continue;
    if (pollBody?.status === 'expired') throw new PairingFailure(EXPIRED_ERROR_MESSAGE);
    // A 200 that is not JSON, or names no status we know, is most likely a
    // proxy's page or a cut-off body: as passing as a 5xx, so keep polling.
    // An approved answer is different: the secret is handed out only once,
    // so a broken one cannot be asked for again and is reported below.
    if (pollBody?.status !== 'approved') continue;

    // The secret is opaque: only checked to be a non-empty string, never split.
    const machineId = pollBody.machine_id;
    const machineSecret = pollBody.machine_secret;
    if (!isValidOpaqueId(machineId) || typeof machineSecret !== 'string' || machineSecret === '') {
      throw unexpectedAnswerError('/pair/poll');
    }
    // The backend hands the secret out only once, so a missing email must not
    // cost us the credential: it is only printed, never stored.
    const approverEmail =
      typeof pollBody.approved_by_email === 'string' && cleanForOneLineOfOutput(pollBody.approved_by_email) !== ''
        ? cleanForOneLineOfOutput(pollBody.approved_by_email)
        : 'an account the backend did not name';
    return { machineId, machineSecret, approverEmail };
  }
}

export async function pairThisMachine(options: PairThisMachineOptions): Promise<{ machineId: string }> {
  const pairing = await startPairing(options);
  const lifetimeMinutes = Math.max(1, Math.round(pairing.lifetimeSeconds / 60));
  options.printLine(
    `Pairing code: ${pairing.userCode} (approve with approve_machine_pairing; expires in ${lifetimeMinutes} minute${lifetimeMinutes === 1 ? '' : 's'})`,
  );

  const approval = await waitForApproval(options, pairing);
  await writeMachineCredential(options.paths, {
    backendUrl: options.backendUrl,
    machineId: approval.machineId,
    machineSecret: approval.machineSecret,
  });
  options.printLine(`Paired as machine ${approval.machineId} for ${approval.approverEmail}`);
  return { machineId: approval.machineId };
}
