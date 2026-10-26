// The daemon's backend connection against the Firebase emulators, exactly as
// it runs in production: the machine is paired through the backend's own
// pairing functions, the daemon trades its secret at /daemon/token behind the
// Hosting emulator, signs in to the Auth emulator with the custom token, and
// reads and writes Firestore through the client SDK under firestore.rules.
// Notices are created only through the backend's real sendMessage, so they
// carry exactly what production writes (including rung_at: null).
//
// Runs only through the root `npm run test:emu`: it needs this repository's
// firebase.json and backend code, which the public plugin repository has not.
// The backend modules are imported by a path built at run time, so the
// plugin's own tsc never follows them outside plugin/.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import {
  connectToBackend,
  MachineRevokedError,
  type BackendConnectionWithTestHooks,
  type InboxNotice,
  type PublishedSession,
} from './backendConnection.js';
import { EMULATOR_FIREBASE_WEB_CONFIG, fetchFirebaseWebConfig } from './firebaseWebConfig.js';
import type { MachineCredential } from './machineCredential.js';

// ---- The backend, as the emulator tests of backend/functions use it ----

const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const backendSourceDirectory = join(repositoryRoot, 'backend', 'functions', 'src');

interface CallerIdentity {
  personId: string;
  email: string;
  clientId: string;
}
// Only what these tests touch of the Admin SDK objects the backend helpers return.
interface AdminFirestore {
  collection(path: string): {
    doc(id: string): {
      set(data: Record<string, unknown>): Promise<unknown>;
      get(): Promise<{ data(): Record<string, unknown> | undefined }>;
      delete(): Promise<unknown>;
      collection(path: string): { get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }> };
    };
  };
}
interface BackendForTests {
  emulatorFirestore(): AdminFirestore;
  emulatorAdminAuth(): unknown;
  HOSTING_EMULATOR_ORIGIN: string;
  startPairing(data: AdminFirestore, clock: () => number): Promise<{ pairing_id: string; user_code: string }>;
  approveMachinePairing(caller: CallerIdentity, input: { user_code: string; machine_name: string }, data: AdminFirestore, clock: () => number): Promise<unknown>;
  pollPairing(input: { pairing_id: string }, data: AdminFirestore, clock: () => number): Promise<{ status: string; machine_id?: string; machine_secret?: string }>;
  sendMessage(caller: CallerIdentity, input: { to_machine: string; body: string }, data: AdminFirestore, clock: () => number): Promise<{ message_id: string }>;
  revokeMachine(caller: CallerIdentity, input: { machine_id: string }, data: AdminFirestore, auth: unknown): Promise<unknown>;
}

async function loadBackend(): Promise<BackendForTests> {
  const importBackendModule = (relativePath: string) => import(join(backendSourceDirectory, relativePath));
  const [firebaseAdmin, addresses, pairing, messageTools, machineTools] = await Promise.all([
    importBackendModule('testSupport/emulatorFirebaseAdmin.ts'),
    importBackendModule('testSupport/emulatorAddresses.ts'),
    importBackendModule('pairing.ts'),
    importBackendModule('mcp/tools/messageTools.ts'),
    importBackendModule('mcp/tools/machineTools.ts'),
  ]);
  return { ...firebaseAdmin, ...addresses, ...pairing, ...messageTools, ...machineTools } as BackendForTests;
}
const backend = await loadBackend();

// ---- Test setup ----

function uniqueId(prefix: string): string {
  // A UUID has only letters, digits and dashes, so the id stays opaque-id shaped.
  return `${prefix}_${randomUUID()}`;
}

function callerFor(personId: string): CallerIdentity {
  // The functions emulator allows the allowed-company.test domain (.env.demo-claudecommander).
  return { personId, email: `${personId.toLowerCase()}@allowed-company.test`, clientId: 'emulator-test-client' };
}

interface PairedTestMachine {
  credential: MachineCredential;
  owner: CallerIdentity;
}

// Pairs a new machine for a new, allowlisted person through the backend's
// own pairing functions, and answers the credential `daemon pair` would save.
async function pairNewMachine(): Promise<PairedTestMachine> {
  const owner = callerFor(uniqueId('person'));
  const data = backend.emulatorFirestore();
  await data.collection('people').doc(owner.personId).set({ email: owner.email, display_name: null, created_at: Date.now() });
  const started = await backend.startPairing(data, Date.now);
  await backend.approveMachinePairing(owner, { user_code: started.user_code, machine_name: 'emulator laptop' }, data, Date.now);
  const polled = await backend.pollPairing({ pairing_id: started.pairing_id }, data, Date.now);
  if (polled.status !== 'approved' || polled.machine_id === undefined || polled.machine_secret === undefined) {
    throw new Error(`expected an approved pairing, got ${polled.status}`);
  }
  return {
    credential: { backendUrl: backend.HOSTING_EMULATOR_ORIGIN, machineId: polled.machine_id, machineSecret: polled.machine_secret },
    owner,
  };
}

// A clock that only moves forward, at least a millisecond per call, so three
// messages sent in a row always have three different created_at values.
let lastSendTime = 0;
function strictlyIncreasingClock(): number {
  lastSendTime = Math.max(Date.now(), lastSendTime + 1);
  return lastSendTime;
}

// Sends one message to the machine through the real sendMessage, from a new sender.
async function sendMessageTo(machineId: string): Promise<string> {
  const sender = callerFor(uniqueId('sender'));
  const sent = await backend.sendMessage(sender, { to_machine: machineId, body: 'hello from the emulator test' }, backend.emulatorFirestore(), strictlyIncreasingClock);
  return sent.message_id;
}

async function sendThreeMessagesTo(machineId: string): Promise<string[]> {
  const sentIds: string[] = [];
  for (let count = 0; count < 3; count += 1) sentIds.push(await sendMessageTo(machineId));
  return sentIds;
}

function emulatorHosts(): { auth: string; firestore: string } {
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!authHost || !firestoreHost) throw new Error('the emulator hosts are not set: emulator tests run only through `npm run test:emu`');
  return { auth: `http://${authHost}`, firestore: firestoreHost };
}

let loggedLines: string[] = [];
const openConnections: BackendConnectionWithTestHooks[] = [];

function emulatorOptions() {
  return {
    fetchFunction: fetch,
    firebaseConfig: EMULATOR_FIREBASE_WEB_CONFIG,
    useEmulators: emulatorHosts(),
    log: (line: string) => { loggedLines.push(line); },
    clock: Date.now,
    // Production checks once a minute; a second keeps these tests quick.
    revocationCheckIntervalMilliseconds: 1000,
    // Production waits 15 s before restarting a listener stuck without answers.
    stalledListenerRestartDelayMilliseconds: 1000,
    enableTestHooks: true,
  };
}

async function connect(credential: MachineCredential): Promise<BackendConnectionWithTestHooks> {
  const connection = await connectToBackend(credential, emulatorOptions());
  openConnections.push(connection);
  return connection;
}

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
  loggedLines = [];
});

async function waitUntil(condition: () => boolean, timeoutMilliseconds = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Gives a listener time to deliver anything more it was going to.
async function settle(milliseconds = 1500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uniqueInFirstSeenOrder(ids: string[]): string[] {
  return [...new Set(ids)];
}

async function readMachineDocument(machineId: string): Promise<Record<string, unknown> | undefined> {
  return (await backend.emulatorFirestore().collection('machines').doc(machineId).get()).data();
}

async function readPublishedSessions(machineId: string): Promise<Record<string, Record<string, unknown>>> {
  const snapshot = await backend.emulatorFirestore().collection('machines').doc(machineId).collection('sessions').get();
  return Object.fromEntries(snapshot.docs.map((document) => [document.id, document.data()]));
}

async function readInboxNotice(machineId: string, messageId: string): Promise<Record<string, unknown> | undefined> {
  const snapshot = await backend.emulatorFirestore().collection('machines').doc(machineId).collection('inbox').get();
  return snapshot.docs.find((document) => document.id === messageId)?.data();
}

// ---- The web config ----

test('the Hosting emulator serves a web config for the demo-claudecommander project at /__/firebase/init.json', async () => {
  const webConfig = await fetchFirebaseWebConfig(backend.HOSTING_EMULATOR_ORIGIN, fetch);
  expect(webConfig.projectId).toBe('demo-claudecommander');
});

// ---- The inbox listener ----

test('notices written while disconnected are all delivered once, oldest first, after connecting', async () => {
  const { credential } = await pairNewMachine();
  const sentIds = await sendThreeMessagesTo(credential.machineId);
  const connection = await connect(credential);
  const deliveredNotices: InboxNotice[] = [];
  connection.listenForUnrungNotices((notices) => deliveredNotices.push(...notices));
  await waitUntil(() => deliveredNotices.length >= 3);
  await settle();
  expect(deliveredNotices.map((notice) => notice.messageId)).toEqual(sentIds);
  expect(deliveredNotices.every((notice) => notice.kind === 'message' && typeof notice.createdAt === 'number')).toBe(true);
});

test('notices written during a network cut are delivered once each, oldest first, after the network returns', async () => {
  const { credential } = await pairNewMachine();
  const connection = await connect(credential);
  const deliveredIds: string[] = [];
  connection.listenForUnrungNotices((notices) => deliveredIds.push(...notices.map((notice) => notice.messageId)));
  await settle(500);
  await connection.testHooks.disableNetwork();
  const sentIds = await sendThreeMessagesTo(credential.machineId);
  // Nothing can arrive while the network is cut.
  await settle(500);
  expect(deliveredIds).toEqual([]);
  await connection.testHooks.enableNetwork();
  await waitUntil(() => deliveredIds.length >= 3);
  expect(uniqueInFirstSeenOrder(deliveredIds)).toEqual(sentIds);
  await settle();
  expect(deliveredIds).toEqual(sentIds);
});

test('a notice still waiting to be rung is not handed over again when more arrive, before or after a network cut', async () => {
  const { credential } = await pairNewMachine();
  const connection = await connect(credential);
  const deliveredIds: string[] = [];
  connection.listenForUnrungNotices((notices) => deliveredIds.push(...notices.map((notice) => notice.messageId)));
  // Not marked rung, so it stays in the query's results through everything below.
  const waitingId = await sendMessageTo(credential.machineId);
  await waitUntil(() => deliveredIds.length >= 1);
  const secondId = await sendMessageTo(credential.machineId);
  await waitUntil(() => deliveredIds.length >= 2);
  await connection.testHooks.disableNetwork();
  const sentDuringCut = await sendThreeMessagesTo(credential.machineId);
  await connection.testHooks.enableNetwork();
  await waitUntil(() => deliveredIds.length >= 5);
  await settle();
  expect(deliveredIds).toEqual([waitingId, secondId, ...sentDuringCut]);
});

// The Firestore emulator sometimes never sends a document that was written
// while the listener's target was being added (firebase-tools#8654). The
// connection's once-a-minute server check hands such a notice over anyway.
test('a notice whose added change never reaches the listener is handed over by the next server check, exactly once', async () => {
  const { credential } = await pairNewMachine();
  const connection = await connect(credential);
  const deliveredIds: string[] = [];
  connection.listenForUnrungNotices((notices) => deliveredIds.push(...notices.map((notice) => notice.messageId)));
  await settle(500);
  connection.testHooks.ignoreAddedChangesFromTheListener(true);
  const missedByTheListenerId = await sendMessageTo(credential.machineId);
  await waitUntil(() => deliveredIds.length >= 1);
  connection.testHooks.ignoreAddedChangesFromTheListener(false);
  const seenByTheListenerId = await sendMessageTo(credential.machineId);
  await waitUntil(() => deliveredIds.length >= 2);
  // Several more server checks run meanwhile: neither notice comes again.
  await settle(3000);
  expect(deliveredIds).toEqual([missedByTheListenerId, seenByTheListenerId]);
});

// The emulator sometimes garbles its Listen stream (RESOURCE_EXHAUSTED,
// "Received message larger than max"), and the SDK then waits its longest
// backoff, up to a minute and a half, before trying again. A listener left
// answering only from the cache is restarted instead.
test('a listener stuck offline without being told is restarted, and the notice waiting for it arrives', async () => {
  const { credential } = await pairNewMachine();
  const connection = await connect(credential);
  const deliveredIds: string[] = [];
  connection.listenForUnrungNotices((notices) => deliveredIds.push(...notices.map((notice) => notice.messageId)));
  await settle(500);
  await connection.testHooks.cutNetworkWithoutTellingTheConnection();
  const messageId = await sendMessageTo(credential.machineId);
  await waitUntil(() => deliveredIds.length >= 1, 10_000);
  expect(deliveredIds).toEqual([messageId]);
  expect(loggedLines.join('\n')).toMatch(/restarting the connection/);
});

test('listening again on the same connection does not hand over a notice already handed over', async () => {
  const { credential } = await pairNewMachine();
  const connection = await connect(credential);
  const firstListenerIds: string[] = [];
  const stopFirstListener = connection.listenForUnrungNotices((notices) => firstListenerIds.push(...notices.map((notice) => notice.messageId)));
  const firstId = await sendMessageTo(credential.machineId);
  await waitUntil(() => firstListenerIds.length >= 1);
  stopFirstListener();

  // Still unrung, so the new listener's query returns it again: it must not be handed over a second time.
  const secondListenerIds: string[] = [];
  connection.listenForUnrungNotices((notices) => secondListenerIds.push(...notices.map((notice) => notice.messageId)));
  const secondId = await sendMessageTo(credential.machineId);
  await waitUntil(() => secondListenerIds.length >= 1);
  await settle(2500);
  expect(firstListenerIds).toEqual([firstId]);
  expect(secondListenerIds).toEqual([secondId]);
});

test('a notice with rung_at set is not delivered again after reconnect', async () => {
  const { credential } = await pairNewMachine();
  const firstMessageId = await sendMessageTo(credential.machineId);
  const connection = await connect(credential);
  const deliveredIds: string[] = [];
  connection.listenForUnrungNotices((notices) => deliveredIds.push(...notices.map((notice) => notice.messageId)));
  await waitUntil(() => deliveredIds.length >= 1);
  await connection.markNoticeRung(firstMessageId);
  expect(await readInboxNotice(credential.machineId, firstMessageId)).toEqual({
    kind: 'message',
    from_person_id: expect.any(String),
    created_at: expect.any(Number),
    rung_at: expect.any(Number),
  });

  // A network cut and a new message: only the new one comes after it.
  await connection.testHooks.disableNetwork();
  const secondMessageId = await sendMessageTo(credential.machineId);
  await connection.testHooks.enableNetwork();
  await waitUntil(() => deliveredIds.length >= 2);
  await settle();
  expect(deliveredIds).toEqual([firstMessageId, secondMessageId]);

  // A daemon restart (a new connection): only the notice still not rung.
  await connection.close();
  const restartedConnection = await connect(credential);
  const deliveredAfterRestart: string[] = [];
  restartedConnection.listenForUnrungNotices((notices) => deliveredAfterRestart.push(...notices.map((notice) => notice.messageId)));
  await waitUntil(() => deliveredAfterRestart.length >= 1);
  await settle();
  expect(deliveredAfterRestart).toEqual([secondMessageId]);
});

// ---- Heartbeat and sessions ----

test('sendHeartbeat sets last_seen_at on the machine to about now, and changes nothing else', async () => {
  const { credential } = await pairNewMachine();
  const before = await readMachineDocument(credential.machineId);
  const connection = await connect(credential);
  const sentAt = Date.now();
  await connection.sendHeartbeat();
  const after = await readMachineDocument(credential.machineId);
  expect(after?.last_seen_at).toBeGreaterThanOrEqual(sentAt);
  expect(after?.last_seen_at).toBeLessThanOrEqual(Date.now());
  expect({ ...after, last_seen_at: null }).toEqual({ ...before, last_seen_at: null });
});

test('publishSessions replaces the published set and removes a vanished session', async () => {
  const { credential } = await pairNewMachine();
  const connection = await connect(credential);
  const orchestrator: PublishedSession = { sessionName: 'orchestrator', projectName: '/home/dana/projects', state: 'idle', role: 'orchestrator' };
  const billing: PublishedSession = { sessionName: 'billing-api', projectName: '/home/dana/projects/billing', state: 'working', role: 'session' };
  const search: PublishedSession = { sessionName: 'search', projectName: '/home/dana/projects/search', state: 'idle', role: 'session' };

  await connection.publishSessions([orchestrator, billing]);
  const firstSet = await readPublishedSessions(credential.machineId);
  expect(Object.keys(firstSet).sort()).toEqual(['billing-api', 'orchestrator']);
  expect(firstSet['billing-api']).toEqual({ project_name: 'billing', state: 'working', role: 'session', updated_at: expect.any(Number) });

  await connection.publishSessions([orchestrator, { ...search, state: 'blocked' }]);
  const secondSet = await readPublishedSessions(credential.machineId);
  expect(Object.keys(secondSet).sort()).toEqual(['orchestrator', 'search']);
  expect(secondSet.search.state).toBe('blocked');

  // A restarted daemon publishing an empty list clears what an earlier run left behind.
  await connection.close();
  const restartedConnection = await connect(credential);
  await restartedConnection.publishSessions([]);
  expect(await readPublishedSessions(credential.machineId)).toEqual({});
});

test('publishSessions fails fast while offline instead of trusting the cached set, and works again once back', async () => {
  const { credential } = await pairNewMachine();
  const connection = await connect(credential);
  const billing: PublishedSession = { sessionName: 'billing-api', projectName: '/home/dana/billing', state: 'idle', role: 'session' };
  await connection.testHooks.disableNetwork();
  const publishedOffline = connection.publishSessions([billing]);
  const outcome = await Promise.race([
    publishedOffline.then(() => 'published', (error: { code?: string }) => `failed: ${error.code}`),
    new Promise((resolve) => setTimeout(() => resolve('still waiting after 5 s'), 5000)),
  ]);
  expect(outcome).toBe('failed: unavailable');
  await connection.testHooks.enableNetwork();
  await connection.publishSessions([billing]);
  expect(Object.keys(await readPublishedSessions(credential.machineId))).toEqual(['billing-api']);
});

// ---- Revocation ----

// Sets revoked_at back to null with the Admin SDK (emulator only), to check
// that the stopped listener stays stopped even once notices could flow again.
async function clearRevokedAtForTheTest(machineId: string): Promise<void> {
  const machineReference = backend.emulatorFirestore().collection('machines').doc(machineId);
  const machine = (await machineReference.get()).data();
  await machineReference.set({ ...machine, revoked_at: null });
}

test('revoking the machine stops the open listener within one revocation check, with MachineRevokedError, and logs machine revoked', async () => {
  const { credential, owner } = await pairNewMachine();
  const connection = await connect(credential);
  const deliveredIds: string[] = [];
  connection.listenForUnrungNotices((notices) => deliveredIds.push(...notices.map((notice) => notice.messageId)));
  const messageId = await sendMessageTo(credential.machineId);
  await waitUntil(() => deliveredIds.length >= 1);

  // No token refresh is waited for (that is an hour away): the connection's
  // next revocation check, a server read the rules evaluate afresh, is
  // refused, because an open listener alone is not re-checked by Firestore.
  await backend.revokeMachine(owner, { machine_id: credential.machineId }, backend.emulatorFirestore(), backend.emulatorAdminAuth());
  const revocation = await connection.whenMachineRevoked();
  expect(revocation).toBeInstanceOf(MachineRevokedError);
  expect(loggedLines.filter((line) => line.includes('machine revoked'))).toHaveLength(1);
  await expect(connection.markNoticeRung(messageId)).rejects.toBeInstanceOf(MachineRevokedError);
  await expect(connection.sendHeartbeat()).rejects.toBeInstanceOf(MachineRevokedError);
  await expect(connection.publishSessions([])).rejects.toBeInstanceOf(MachineRevokedError);
  expect(() => connection.listenForUnrungNotices(() => {})).toThrow(MachineRevokedError);
  expect(loggedLines.join('\n')).not.toContain(credential.machineSecret);

  // No notice is delivered after the revocation, even one sent once the
  // backend would accept messages for this machine again.
  const deliveredBeforeRevocation = [...deliveredIds];
  await clearRevokedAtForTheTest(credential.machineId);
  await sendMessageTo(credential.machineId);
  await settle();
  expect(deliveredIds).toEqual(deliveredBeforeRevocation);
});

test('revoking a machine whose inbox is empty is noticed too', async () => {
  const { credential, owner } = await pairNewMachine();
  const connection = await connect(credential);
  const deliveredIds: string[] = [];
  connection.listenForUnrungNotices((notices) => deliveredIds.push(...notices.map((notice) => notice.messageId)));
  await settle(500);
  await backend.revokeMachine(owner, { machine_id: credential.machineId }, backend.emulatorFirestore(), backend.emulatorAdminAuth());
  expect(await connection.whenMachineRevoked()).toBeInstanceOf(MachineRevokedError);
  expect(loggedLines.filter((line) => line.includes('machine revoked'))).toHaveLength(1);
  expect(deliveredIds).toEqual([]);
  await clearRevokedAtForTheTest(credential.machineId);
  await sendMessageTo(credential.machineId);
  await settle();
  expect(deliveredIds).toEqual([]);
});

test('/daemon/token answering 401 on refresh also gives MachineRevokedError', async () => {
  const { credential, owner } = await pairNewMachine();
  const connection = await connect(credential);
  // The owner leaves the allowlist (their people document is gone): the
  // rules still let the daemon in, but /daemon/token now answers 401.
  await backend.emulatorFirestore().collection('people').doc(owner.personId).delete();
  await connection.testHooks.refreshCustomTokenNow();
  expect(await connection.whenMachineRevoked()).toBeInstanceOf(MachineRevokedError);
  expect(loggedLines.filter((line) => line.includes('machine revoked'))).toHaveLength(1);
  await expect(connection.sendHeartbeat()).rejects.toBeInstanceOf(MachineRevokedError);
  expect(loggedLines.join('\n')).not.toContain(credential.machineSecret);
});

test('a revoked machine cannot connect at all: connectToBackend rejects with MachineRevokedError', async () => {
  const { credential, owner } = await pairNewMachine();
  await backend.revokeMachine(owner, { machine_id: credential.machineId }, backend.emulatorFirestore(), backend.emulatorAdminAuth());
  await expect(connectToBackend(credential, emulatorOptions())).rejects.toBeInstanceOf(MachineRevokedError);
});
