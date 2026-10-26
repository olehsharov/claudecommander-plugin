// Unit tests of the parts of the backend connection that need no Firebase:
// the /daemon/token exchange and its refresh schedule, and the shapes of what
// is read from and written to Firestore. The listener, the heartbeat and
// session publishing against real Firestore are in backendConnection.emu.test.ts.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  connectToBackend,
  createStalledListenerRestarter,
  LONGEST_STALLED_LISTENER_RESTART_DELAY_MILLISECONDS,
  NoticesAlreadyHandedOver,
  STALLED_LISTENER_RESTART_DELAY_MILLISECONDS,
  CUSTOM_TOKEN_REFRESH_MARGIN_MILLISECONDS,
  inboxNoticeFrom,
  MachineRevokedError,
  publishedSessionDocumentFor,
  RETRY_AFTER_FAILED_TOKEN_REFRESH_MILLISECONDS,
  startCustomTokenSession,
} from './backendConnection.js';
import type { MachineCredential } from './machineCredential.js';

// A sentinel secret: if it ever shows up in a log line or an error, it leaked.
const SENTINEL_MACHINE_SECRET = 'machine_42.SENTINEL_SECRET_must_never_be_logged_xxxxxxxxxxxxxxx';
const credential: MachineCredential = {
  backendUrl: 'https://backend.example.test',
  machineId: 'machine_42',
  machineSecret: SENTINEL_MACHINE_SECRET,
};

const ONE_HOUR_IN_SECONDS = 3600;

// A custom token shaped like the Admin SDK's: a JWT whose payload has iat and exp, an hour apart.
function customTokenIssuedNow(lifetimeSeconds = ONE_HOUR_IN_SECONDS): string {
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issuedAtSeconds, exp: issuedAtSeconds + lifetimeSeconds, uid: 'machine:machine_42' })}.signature`;
}

const tokenAnswer = () => new Response(JSON.stringify({ custom_token: customTokenIssuedNow(), machine_id: 'machine_42' }), { status: 200 });
const unauthorizedAnswer = () => new Response(JSON.stringify({ error: 'machine_revoked' }), { status: 401 });
const serverErrorAnswer = () => new Response(`<html>${SENTINEL_MACHINE_SECRET}</html>`, { status: 500 });

interface RecordedTokenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

// A /daemon/token that answers from a scripted list (the last answer repeats) and records each request.
function fakeTokenEndpoint(scriptedAnswers: Array<() => Response>) {
  const recordedRequests: RecordedTokenRequest[] = [];
  let answerPosition = 0;
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    recordedRequests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
    });
    const answer = scriptedAnswers[Math.min(answerPosition, scriptedAnswers.length - 1)];
    answerPosition += 1;
    return answer();
  }) as typeof fetch;
  return { fetchFunction, recordedRequests };
}

let loggedLines: string[] = [];
const log = (line: string) => { loggedLines.push(line); };

beforeEach(() => {
  loggedLines = [];
});

afterEach(() => {
  vi.useRealTimers();
});

test('/daemon/token is posted to the backend with the machine secret only in the Authorization header', async () => {
  const tokenEndpoint = fakeTokenEndpoint([tokenAnswer]);
  const signedInWith: string[] = [];
  const session = await startCustomTokenSession({
    credential,
    fetchFunction: tokenEndpoint.fetchFunction,
    signInWithCustomToken: async (customToken) => { signedInWith.push(customToken); },
    log,
    onMachineRevoked: () => {},
  });
  session.stop();
  expect(tokenEndpoint.recordedRequests).toHaveLength(1);
  const [request] = tokenEndpoint.recordedRequests;
  expect(request.url).toBe('https://backend.example.test/daemon/token');
  expect(request.method).toBe('POST');
  expect(request.headers.authorization).toBe(`Bearer ${SENTINEL_MACHINE_SECRET}`);
  expect(request.url).not.toContain(SENTINEL_MACHINE_SECRET);
  expect(String(request.body ?? '')).not.toContain(SENTINEL_MACHINE_SECRET);
  expect(signedInWith).toHaveLength(1);
});

test('the custom token is refreshed five minutes before it expires', async () => {
  vi.useFakeTimers();
  const tokenEndpoint = fakeTokenEndpoint([tokenAnswer]);
  let signInCount = 0;
  const session = await startCustomTokenSession({
    credential,
    fetchFunction: tokenEndpoint.fetchFunction,
    signInWithCustomToken: async () => { signInCount += 1; },
    log,
    onMachineRevoked: () => {},
  });
  expect(CUSTOM_TOKEN_REFRESH_MARGIN_MILLISECONDS).toBe(5 * 60 * 1000);
  const refreshDueAfterMilliseconds = ONE_HOUR_IN_SECONDS * 1000 - CUSTOM_TOKEN_REFRESH_MARGIN_MILLISECONDS;

  await vi.advanceTimersByTimeAsync(refreshDueAfterMilliseconds - 1);
  expect(signInCount).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(signInCount).toBe(2);
  // And again an hour-less-five-minutes after that refresh.
  await vi.advanceTimersByTimeAsync(refreshDueAfterMilliseconds);
  expect(signInCount).toBe(3);
  session.stop();
  await vi.advanceTimersByTimeAsync(10 * ONE_HOUR_IN_SECONDS * 1000);
  expect(signInCount).toBe(3);
});

test('a refresh that fails for a passing reason is logged without the secret and retried a minute later, not sooner', async () => {
  vi.useFakeTimers();
  const unreachable = () => { throw new TypeError(`fetch failed for ${SENTINEL_MACHINE_SECRET}`); };
  const tokenEndpoint = fakeTokenEndpoint([tokenAnswer, serverErrorAnswer, unreachable, tokenAnswer]);
  let signInCount = 0;
  const session = await startCustomTokenSession({
    credential,
    fetchFunction: tokenEndpoint.fetchFunction,
    signInWithCustomToken: async () => { signInCount += 1; },
    log,
    onMachineRevoked: () => { throw new Error('a 500 or an unreachable backend is not a revocation'); },
  });
  await vi.advanceTimersByTimeAsync(ONE_HOUR_IN_SECONDS * 1000 - CUSTOM_TOKEN_REFRESH_MARGIN_MILLISECONDS);
  expect(tokenEndpoint.recordedRequests).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(RETRY_AFTER_FAILED_TOKEN_REFRESH_MILLISECONDS - 1);
  expect(tokenEndpoint.recordedRequests).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(tokenEndpoint.recordedRequests).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(RETRY_AFTER_FAILED_TOKEN_REFRESH_MILLISECONDS);
  expect(tokenEndpoint.recordedRequests).toHaveLength(4);
  expect(signInCount).toBe(2);
  session.stop();

  expect(loggedLines.join('\n')).toMatch(/HTTP 500/);
  expect(loggedLines.join('\n')).toMatch(/could not reach/);
  expect(loggedLines.join('\n')).not.toContain(SENTINEL_MACHINE_SECRET);
  expect(loggedLines.join('\n')).not.toContain('SENTINEL_SECRET');
});

test('/daemon/token answering 401 on refresh reports the machine revoked once, logs it in one line, and stops refreshing', async () => {
  vi.useFakeTimers();
  const tokenEndpoint = fakeTokenEndpoint([tokenAnswer, unauthorizedAnswer]);
  const revocations: MachineRevokedError[] = [];
  await startCustomTokenSession({
    credential,
    fetchFunction: tokenEndpoint.fetchFunction,
    signInWithCustomToken: async () => {},
    log,
    onMachineRevoked: (error) => { revocations.push(error); },
  });
  await vi.advanceTimersByTimeAsync(ONE_HOUR_IN_SECONDS * 1000 - CUSTOM_TOKEN_REFRESH_MARGIN_MILLISECONDS);
  expect(revocations).toHaveLength(1);
  expect(revocations[0]).toBeInstanceOf(MachineRevokedError);
  // No hot loop: nothing is asked again, however long we wait.
  await vi.advanceTimersByTimeAsync(24 * ONE_HOUR_IN_SECONDS * 1000);
  expect(tokenEndpoint.recordedRequests).toHaveLength(2);
  const revokedLines = loggedLines.filter((line) => line.includes('machine revoked'));
  expect(revokedLines).toHaveLength(1);
  expect(revokedLines[0]).not.toContain('\n');
  expect(revokedLines[0]).not.toContain(SENTINEL_MACHINE_SECRET);
});

test('connectToBackend with a credential the backend answers 401 rejects with MachineRevokedError and logs machine revoked', async () => {
  const tokenEndpoint = fakeTokenEndpoint([unauthorizedAnswer]);
  const connecting = connectToBackend(credential, {
    fetchFunction: tokenEndpoint.fetchFunction,
    firebaseConfig: { apiKey: 'demo-key', projectId: 'demo-unit-test' },
    log,
    clock: Date.now,
  });
  await expect(connecting).rejects.toBeInstanceOf(MachineRevokedError);
  await expect(connecting).rejects.toThrow(/machine revoked/);
  expect(loggedLines.join('\n')).toMatch(/machine revoked/);
  expect(loggedLines.join('\n')).not.toContain(SENTINEL_MACHINE_SECRET);
});

test('a /daemon/token answer for another machine, or with no custom token, is refused without signing in', async () => {
  const otherMachineAnswer = () => new Response(JSON.stringify({ custom_token: customTokenIssuedNow(), machine_id: 'machine_other' }), { status: 200 });
  const emptyAnswer = () => new Response(JSON.stringify({ machine_id: 'machine_42' }), { status: 200 });
  for (const answer of [otherMachineAnswer, emptyAnswer]) {
    let signInCount = 0;
    const starting = startCustomTokenSession({
      credential,
      fetchFunction: fakeTokenEndpoint([answer]).fetchFunction,
      signInWithCustomToken: async () => { signInCount += 1; },
      log,
      onMachineRevoked: () => {},
    });
    await expect(starting).rejects.toThrow(/unexpected answer/);
    expect(signInCount).toBe(0);
  }
});

test('a published session never contains a slash in its project name', () => {
  const published = publishedSessionDocumentFor(
    { sessionName: 'billing-api', projectName: '/home/x/billing', state: 'idle', role: 'session' },
    1_800_000_000_000,
  );
  expect(published).toEqual({
    documentId: 'billing-api',
    document: { project_name: 'billing', state: 'idle', role: 'session', updated_at: 1_800_000_000_000 },
  });
  const fromWindowsPath = publishedSessionDocumentFor({ sessionName: 's', projectName: 'C:\\work\\billing\\', state: 'idle', role: 'session' }, 1);
  expect(fromWindowsPath?.document.project_name).toBe('billing');
});

test('a session the Firestore rules would refuse is left out rather than failing the whole publish', () => {
  const now = 1_800_000_000_000;
  const session = { sessionName: 'ok', projectName: 'p', state: 'idle', role: 'session' as const };
  expect(publishedSessionDocumentFor({ ...session, sessionName: 'a/b' }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, sessionName: 'x'.repeat(65) }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, sessionName: 'bell\u0007' }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, sessionName: '' }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, sessionName: '..' }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, sessionName: '__reserved__' }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, state: '' }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, state: 'x'.repeat(65) }, now)).toBeNull();
  expect(publishedSessionDocumentFor({ ...session, role: 'admin' as 'session' }, now)).toBeNull();
  // Control characters in the project folder name are dropped, not published.
  expect(publishedSessionDocumentFor({ ...session, projectName: '/home/x/bil\u001b[31mling' }, now)?.document.project_name).toBe('bil[31mling');
  expect(publishedSessionDocumentFor({ ...session, sessionName: 'séance-日本' }, now)?.documentId).toBe('séance-日本');
});

test('an inbox notice is read from exactly {kind, from_person_id, created_at, rung_at}, and a malformed one is skipped', () => {
  const notice = { kind: 'message', from_person_id: 'person_1', created_at: 1_800_000_000_000, rung_at: null };
  expect(inboxNoticeFrom('message_1', notice)).toEqual({ messageId: 'message_1', kind: 'message', createdAt: 1_800_000_000_000 });
  expect(inboxNoticeFrom('message_2', { ...notice, kind: 'reply' })?.kind).toBe('reply');
  expect(inboxNoticeFrom('message_3', { ...notice, kind: 'shout' })).toBeNull();
  expect(inboxNoticeFrom('message_4', { ...notice, created_at: '2026-10-24' })).toBeNull();
  expect(inboxNoticeFrom('not/an-id', notice)).toBeNull();
  expect(inboxNoticeFrom('message_5', undefined)).toBeNull();
});

// ---- Restarting a stalled listener ----

// A restarter whose listener never hears from the server, recording when each restart happened.
function stalledRestarterForTest(options: { stalled: () => boolean } = { stalled: () => true }) {
  const restartTimes: number[] = [];
  const startedAt = Date.now();
  const restarter = createStalledListenerRestarter({
    someListenerAnswersOnlyFromCache: options.stalled,
    mayRestartNow: () => true,
    restartConnection: async () => { restartTimes.push(Date.now() - startedAt); },
    log,
  });
  return { restarter, restartTimes };
}

test('a machine that stays offline restarts at 15, 30, 60, 120, 300, 300 s, not every 15 s', async () => {
  vi.useFakeTimers();
  expect(STALLED_LISTENER_RESTART_DELAY_MILLISECONDS).toBe(15_000);
  expect(LONGEST_STALLED_LISTENER_RESTART_DELAY_MILLISECONDS).toBe(300_000);
  const { restarter, restartTimes } = stalledRestarterForTest();
  restarter.noteSnapshot({ fromCache: true });
  await vi.advanceTimersByTimeAsync(825_000);
  const gapsInSeconds = restartTimes.map((restartTime, position) => (restartTime - (restartTimes[position - 1] ?? 0)) / 1000);
  expect(gapsInSeconds).toEqual([15, 30, 60, 120, 300, 300]);
  restarter.stop();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(restartTimes).toHaveLength(6);
  // One log line for the whole stall, not one per restart.
  expect(loggedLines.filter((line) => line.includes('restarting the connection'))).toHaveLength(1);
});

test('the backoff resets after the server answers again', async () => {
  vi.useFakeTimers();
  let stalled = true;
  const { restarter, restartTimes } = stalledRestarterForTest({ stalled: () => stalled });
  restarter.noteSnapshot({ fromCache: true });
  await vi.advanceTimersByTimeAsync(15_000 + 30_000 + 60_000);
  expect(restartTimes).toHaveLength(3);

  // The server answers: the next stall starts again from 15 s.
  stalled = false;
  restarter.noteSnapshot({ fromCache: false });
  expect(loggedLines.join('\n')).toMatch(/hears from the backend again/);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(restartTimes).toHaveLength(3);
  stalled = true;
  const stallStartedAt = restartTimes.length;
  restarter.noteSnapshot({ fromCache: true });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(restartTimes).toHaveLength(stallStartedAt);
  await vi.advanceTimersByTimeAsync(1);
  expect(restartTimes).toHaveLength(stallStartedAt + 1);
  restarter.stop();
});

// ---- Notices already handed over ----

test('an id rung on the server is pruned after the next complete check, and an id handed over during the check is not pruned', () => {
  const handedOver = new NoticesAlreadyHandedOver();
  handedOver.add('message_rung');
  handedOver.add('message_still_waiting');
  const presentAtStart = handedOver.startServerCheck();
  // Handed over by the listener while the server read was in flight.
  handedOver.add('message_arrived_during_the_check');
  handedOver.finishServerCheck(presentAtStart, ['message_still_waiting'], { theWholeUnrungListWasRead: true });
  expect(handedOver.has('message_rung')).toBe(false);
  expect(handedOver.has('message_still_waiting')).toBe(true);
  expect(handedOver.has('message_arrived_during_the_check')).toBe(true);
});

test('a check that read only part of the unrung list prunes nothing', () => {
  const handedOver = new NoticesAlreadyHandedOver();
  handedOver.add('message_beyond_the_first_50');
  const presentAtStart = handedOver.startServerCheck();
  handedOver.finishServerCheck(presentAtStart, ['message_other'], { theWholeUnrungListWasRead: false });
  expect(handedOver.has('message_beyond_the_first_50')).toBe(true);
});

test('notices not handed over yet are picked oldest first, once each, and a malformed one is reported once by id', () => {
  const handedOver = new NoticesAlreadyHandedOver();
  const documents = [
    { id: 'message_newer', data: { kind: 'message', from_person_id: 'p', created_at: 2, rung_at: null } },
    { id: 'message_broken', data: { kind: 'shout', from_person_id: 'p', created_at: 1, rung_at: null } },
    { id: 'message_older', data: { kind: 'reply', from_person_id: 'p', created_at: 1, rung_at: null } },
  ];
  expect(handedOver.takeTheOnesNotHandedOverYet(documents)).toEqual({
    newNotices: [
      { messageId: 'message_older', kind: 'reply', createdAt: 1 },
      { messageId: 'message_newer', kind: 'message', createdAt: 2 },
    ],
    malformedMessageIds: ['message_broken'],
  });
  expect(handedOver.takeTheOnesNotHandedOverYet(documents)).toEqual({ newNotices: [], malformedMessageIds: [] });
  // An id that is not an opaque id is never reported: it could not be marked rung anyway.
  expect(handedOver.takeTheOnesNotHandedOverYet([{ id: 'bad id', data: {} }]).malformedMessageIds).toEqual([]);
});
