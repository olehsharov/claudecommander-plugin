// The daemon's connection to the backend (spec 6.2, "Backend connection").
// Adapted from feat/firebase:packages/daemon/src/cloud/auth.ts and login.ts.
//
// How the daemon signs in, and stays signed in:
//   1. POST <backend_url>/daemon/token with "Authorization: Bearer <machine
//      secret>". The backend answers a Firebase custom token for the uid
//      machine:<machine_id>, carrying the claims {machine_id, person_id} the
//      Firestore rules read (backend/functions/src/pairing.ts);
//   2. signInWithCustomToken with the Firebase client SDK;
//   3. five minutes before the custom token expires, do both again. Each
//      round trip makes the backend recheck the machine (revoked?) and its
//      owner (still on the allowlist?), so this is also how a removed owner's
//      daemon is stopped.
//
// What it then does with Firestore, all within firestore.rules:
//   - listens to machines/{id}/inbox where rung_at == null, ordered by
//     created_at. After any reconnect the same query returns every notice
//     not yet rung, so nothing is lost and no cursor is kept. A listener left
//     answering only from the cache (a broken stream in backoff) gets the
//     connection restarted after STALLED_LISTENER_RESTART_DELAY;
//   - sets rung_at (a number) on a notice once the orchestrator was rung;
//   - sets last_seen_at on its machine document (the heartbeat);
//   - publishes the local session list under machines/{id}/sessions.
//
// A revoked machine: a 401 from /daemon/token, or permission-denied from the
// inbox (the rules deny a machine whose revoked_at is set). Firestore checks
// an open listener's rules only when it starts, reconnects or changes token,
// not when a document the rules read with get() changes, so revoked_at alone
// does not cut an open listener off. The connection therefore also reads its
// oldest unrung notices from the server every REVOCATION_CHECK_INTERVAL,
// which the rules evaluate afresh: a revoked machine stops within that minute,
// without waiting for the hourly token refresh. The same read hands over any
// notice the listener missed. Either way the connection logs
// "machine revoked" once, stops listening and refreshing, and every later
// call rejects with MachineRevokedError, so the daemon stops cleanly instead
// of retrying in a loop.
//
// The machine secret is sent only in that Authorization header. It is never
// put in a log line or an error message, and no answer body from the backend
// is ever repeated (a misbehaving proxy could echo the header back).
import { deleteApp, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithCustomToken, type Auth } from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  enableNetwork,
  getDocsFromServer,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { randomBytes } from 'node:crypto';
import { isValidOpaqueId } from './ids.js';
import type { MachineCredential } from './machineCredential.js';

// ---- What the rest of the daemon sees ----

export interface InboxNotice {
  messageId: string;
  kind: 'message' | 'reply';
  createdAt: number;
}

export interface PublishedSession {
  sessionName: string;
  projectName: string;
  state: string;
  role: 'orchestrator' | 'session';
}

export interface BackendConnection {
  // Calls onNotices with every unrung notice this connection has not handed
  // over yet, oldest first. Each notice is handed over at most once per
  // connection, whichever listener sees it first: listening again on the same
  // connection does not hand over notices an earlier listener already did.
  // onMalformedNotice gets the id of a notice that could not be read (never
  // handed over), once, so the run loop can retire it by marking it rung.
  // Returns the unsubscribe function.
  listenForUnrungNotices(onNotices: (notices: InboxNotice[]) => void, onMalformedNotice?: (messageId: string) => void): () => void;
  markNoticeRung(messageId: string): Promise<void>;
  // Replaces the whole published set: sessions not in the list are deleted.
  publishSessions(sessions: PublishedSession[]): Promise<void>;
  // The caller sends one every HEARTBEAT_INTERVAL_MILLISECONDS.
  sendHeartbeat(): Promise<void>;
  // Resolves (never rejects) once the backend has refused this machine.
  whenMachineRevoked(): Promise<MachineRevokedError>;
  close(): Promise<void>;
}

// Only for tests. They throw unless connectToBackend was given enableTestHooks: true.
export interface BackendConnectionTestHooks {
  // A real network cut that the connection knows about (it does not try to undo it).
  disableNetwork(): Promise<void>;
  enableNetwork(): Promise<void>;
  // A network cut the connection is not told about: stands in for an SDK
  // stuck in backoff after a broken stream.
  cutNetworkWithoutTellingTheConnection(): Promise<void>;
  // Makes listeners drop their "added" changes, as if Firestore never sent them.
  ignoreAddedChangesFromTheListener(ignore: boolean): void;
  refreshCustomTokenNow(): Promise<void>;
}

export interface BackendConnectionWithTestHooks extends BackendConnection {
  readonly testHooks: BackendConnectionTestHooks;
}

export interface ConnectToBackendOptions {
  fetchFunction: typeof fetch;
  firebaseConfig: FirebaseOptions;
  // The Auth emulator's URL ("http://127.0.0.1:9199") and the Firestore
  // emulator's "host:port", for tests only.
  useEmulators?: { auth: string; firestore: string };
  log: (line: string) => void;
  // Epoch milliseconds: what rung_at, last_seen_at and updated_at are set to.
  clock: () => number;
  // How often to check with the server that this machine is still allowed
  // in (REVOCATION_CHECK_INTERVAL_MILLISECONDS unless a test shortens it).
  revocationCheckIntervalMilliseconds?: number;
  // How long a listener may answer only from the cache, while the network is
  // meant to be on, before the connection is restarted
  // (STALLED_LISTENER_RESTART_DELAY_MILLISECONDS unless a test shortens it).
  stalledListenerRestartDelayMilliseconds?: number;
  enableTestHooks?: boolean;
}

export const HEARTBEAT_INTERVAL_MILLISECONDS = 5 * 60 * 1000;
export const CUSTOM_TOKEN_REFRESH_MARGIN_MILLISECONDS = 5 * 60 * 1000;
// After a refresh fails for a passing reason (network, 5xx), try again this
// much later. The current sign-in keeps working meanwhile: the SDK renews its
// own ID token from its refresh token, so there is no hurry.
export const RETRY_AFTER_FAILED_TOKEN_REFRESH_MILLISECONDS = 60 * 1000;
// A listener that fails for a reason other than permission-denied is opened
// again after this long.
export const RETRY_AFTER_FAILED_LISTENER_MILLISECONDS = 30 * 1000;
// One small server read a minute (about 1,440 reads a day, plus one per
// unrung notice it returns) bounds how long a revoked machine keeps receiving
// to a minute, and hands over any notice the listener missed (see
// handOverNoticesTheListenerMissed).
export const REVOCATION_CHECK_INTERVAL_MILLISECONDS = 60 * 1000;
// How many unrung notices one server check reads, oldest first.
const MOST_NOTICES_READ_BY_ONE_SERVER_CHECK = 50;
// A listener answering only from the cache this long, while the network is
// meant to be on, gets the connection restarted (createStalledListenerRestarter).
// Further restarts in the same stall wait longer: these multiples of the
// first delay, the last repeated (15, 30, 60, 120 s, then every 300 s).
export const STALLED_LISTENER_RESTART_DELAY_MILLISECONDS = 15 * 1000;
const STALLED_LISTENER_RESTART_DELAY_MULTIPLES = [1, 2, 4, 8, 20];
export const LONGEST_STALLED_LISTENER_RESTART_DELAY_MILLISECONDS =
  STALLED_LISTENER_RESTART_DELAY_MILLISECONDS * STALLED_LISTENER_RESTART_DELAY_MULTIPLES[STALLED_LISTENER_RESTART_DELAY_MULTIPLES.length - 1];

// Firebase custom tokens last an hour. Used when the token cannot be read.
const DEFAULT_CUSTOM_TOKEN_LIFETIME_MILLISECONDS = 60 * 60 * 1000;
// Never refresh more often than this, whatever the token says.
const SHORTEST_REFRESH_DELAY_MILLISECONDS = 60 * 1000;
// A token claiming to last longer than a day is not believed.
const LONGEST_BELIEVABLE_TOKEN_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1000;

// What firestore.rules accepts for a published session.
const LONGEST_SESSION_NAME = 64;
const LONGEST_STATE = 64;
const LONGEST_PROJECT_NAME = 256;
// One write batch takes at most 500 writes: up to this many sets plus the
// deletes of an earlier, equally capped set stay well under that.
const MOST_SESSIONS_PUBLISHED = 200;

const MACHINE_REVOKED_MESSAGE =
  'machine revoked: the backend no longer accepts this machine (revoked, or its owner is no longer allowed); ' +
  'pair it again with claudecommander daemon pair --force';

export class MachineRevokedError extends Error {
  constructor() {
    super(MACHINE_REVOKED_MESSAGE);
    this.name = 'MachineRevokedError';
  }
}

// /daemon/token could not give a token this time, for a reason that may pass.
export class DaemonTokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonTokenUnavailableError';
  }
}

// ---- /daemon/token ----

interface IssuedCustomToken {
  customToken: string;
  lifetimeMilliseconds: number;
}

// The lifetime written in a custom token (a JWT: exp minus iat, both from the
// backend's clock, so our own clock's skew does not matter), or the default
// hour when it cannot be read.
function customTokenLifetimeMilliseconds(customToken: string): number {
  try {
    const payloadPart = customToken.split('.')[1] ?? '';
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { iat?: unknown; exp?: unknown };
    if (typeof payload.iat === 'number' && typeof payload.exp === 'number') {
      const lifetimeMilliseconds = (payload.exp - payload.iat) * 1000;
      if (lifetimeMilliseconds > 0 && lifetimeMilliseconds <= LONGEST_BELIEVABLE_TOKEN_LIFETIME_MILLISECONDS) return lifetimeMilliseconds;
    }
  } catch {
    // Not a readable JWT: fall through to the default.
  }
  return DEFAULT_CUSTOM_TOKEN_LIFETIME_MILLISECONDS;
}

// Trades the machine secret for a custom token. Throws MachineRevokedError on
// a 401 (any 401: the backend never says more to someone without the secret),
// DaemonTokenUnavailableError on anything else that went wrong.
async function requestDaemonCustomToken(credential: MachineCredential, fetchFunction: typeof fetch): Promise<IssuedCustomToken> {
  const tokenUrl = `${credential.backendUrl.replace(/\/+$/, '')}/daemon/token`;
  let response: Response;
  let responseText: string;
  try {
    response = await fetchFunction(tokenUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.machineSecret}` },
    });
    responseText = await response.text();
  } catch {
    // The fetch error is not repeated: it adds nothing the owner can act on.
    throw new DaemonTokenUnavailableError(`could not reach ${tokenUrl}`);
  }
  if (response.status === 401) throw new MachineRevokedError();
  if (response.status !== 200) throw new DaemonTokenUnavailableError(`${tokenUrl} answered HTTP ${response.status}`);

  let answer: { custom_token?: unknown; machine_id?: unknown } | null = null;
  try {
    answer = JSON.parse(responseText);
  } catch {
    answer = null;
  }
  // A token for some other machine would sign us in as that machine.
  if (typeof answer?.custom_token !== 'string' || answer.custom_token === '' || answer.machine_id !== credential.machineId) {
    throw new DaemonTokenUnavailableError(`${tokenUrl} gave an unexpected answer`);
  }
  return { customToken: answer.custom_token, lifetimeMilliseconds: customTokenLifetimeMilliseconds(answer.custom_token) };
}

export interface CustomTokenSession {
  // Fetches a new custom token and signs in with it now. Resolves when done,
  // whatever the outcome; a failure is handled as a scheduled refresh's would be.
  refreshNow(): Promise<void>;
  stop(): void;
}

export interface CustomTokenSessionOptions {
  credential: MachineCredential;
  fetchFunction: typeof fetch;
  signInWithCustomToken: (customToken: string) => Promise<void>;
  log: (line: string) => void;
  onMachineRevoked: (error: MachineRevokedError) => void;
}

// Signs in once (rejecting when that fails) and then keeps the sign-in fresh:
//   - after each sign-in, the next one is due CUSTOM_TOKEN_REFRESH_MARGIN
//     before that token expires;
//   - a refresh that fails for a passing reason is logged and tried again
//     RETRY_AFTER_FAILED_TOKEN_REFRESH later;
//   - a 401 calls onMachineRevoked once and schedules nothing more.
export async function startCustomTokenSession(options: CustomTokenSessionOptions): Promise<CustomTokenSession> {
  let nextRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let refreshInProgress: Promise<void> | null = null;

  function scheduleRefresh(delayMilliseconds: number): void {
    if (stopped) return;
    if (nextRefreshTimer !== null) clearTimeout(nextRefreshTimer);
    nextRefreshTimer = setTimeout(() => {
      nextRefreshTimer = null;
      void refreshNow();
    }, delayMilliseconds);
  }

  async function signInWithANewCustomToken(): Promise<void> {
    const issued = await requestDaemonCustomToken(options.credential, options.fetchFunction);
    await options.signInWithCustomToken(issued.customToken);
    scheduleRefresh(Math.max(SHORTEST_REFRESH_DELAY_MILLISECONDS, issued.lifetimeMilliseconds - CUSTOM_TOKEN_REFRESH_MARGIN_MILLISECONDS));
  }

  async function refreshOnce(): Promise<void> {
    try {
      await signInWithANewCustomToken();
    } catch (error) {
      if (stopped) return;
      if (error instanceof MachineRevokedError) {
        stopped = true;
        options.log(error.message);
        options.onMachineRevoked(error);
        return;
      }
      options.log(`refreshing the backend sign-in failed, trying again in a minute: ${(error as Error).message}`);
      scheduleRefresh(RETRY_AFTER_FAILED_TOKEN_REFRESH_MILLISECONDS);
    }
  }

  // Two refreshes asked for at once (the timer and a test hook) share one round trip.
  function refreshNow(): Promise<void> {
    if (stopped) return Promise.resolve();
    refreshInProgress ??= refreshOnce().finally(() => {
      refreshInProgress = null;
    });
    return refreshInProgress;
  }

  try {
    await signInWithANewCustomToken();
  } catch (error) {
    stopped = true;
    if (nextRefreshTimer !== null) clearTimeout(nextRefreshTimer);
    if (error instanceof MachineRevokedError) options.log(error.message);
    throw error;
  }

  return {
    refreshNow,
    stop() {
      stopped = true;
      if (nextRefreshTimer !== null) clearTimeout(nextRefreshTimer);
      nextRefreshTimer = null;
    },
  };
}

// ---- Reading notices and shaping sessions ----

// A notice document holds exactly {kind, from_person_id, created_at, rung_at}
// (messageTools.ts in the backend). Only the id, the kind and the time are
// needed here; anything malformed is skipped (and logged by the caller).
export function inboxNoticeFrom(documentId: string, data: unknown): InboxNotice | null {
  if (!isValidOpaqueId(documentId) || data === null || typeof data !== 'object') return null;
  const notice = data as { kind?: unknown; created_at?: unknown };
  if (notice.kind !== 'message' && notice.kind !== 'reply') return null;
  if (typeof notice.created_at !== 'number' || !Number.isFinite(notice.created_at)) return null;
  return { messageId: documentId, kind: notice.kind, createdAt: notice.created_at };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function hasNoControlCharacters(text: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(text);
}

// Only the last folder of a project path is ever published: the full path
// would tell other people the owner's user name and folder layout.
function projectFolderName(projectPath: string): string {
  const pathParts = projectPath.split(/[\\/]+/).filter((pathPart) => pathPart !== '');
  const folderName = (pathParts.at(-1) ?? '').replace(CONTROL_CHARACTERS, '');
  return [...folderName].slice(0, LONGEST_PROJECT_NAME).join('');
}

// Firestore refuses these as document ids; the session name is the id.
function isUsableAsDocumentId(name: string): boolean {
  return name !== '.' && name !== '..' && !name.includes('/') && !/^__.*__$/.test(name);
}

export interface PublishedSessionDocument {
  documentId: string;
  document: { project_name: string; state: string; role: 'orchestrator' | 'session'; updated_at: number };
}

// The document firestore.rules accepts for this session, or null when the
// rules would refuse it (so one odd session never fails the whole publish).
export function publishedSessionDocumentFor(session: PublishedSession, updatedAt: number): PublishedSessionDocument | null {
  const { sessionName, state, role } = session;
  if (sessionName.length < 1 || sessionName.length > LONGEST_SESSION_NAME) return null;
  if (!hasNoControlCharacters(sessionName) || !isUsableAsDocumentId(sessionName)) return null;
  if (state.length < 1 || state.length > LONGEST_STATE || !hasNoControlCharacters(state)) return null;
  if (role !== 'orchestrator' && role !== 'session') return null;
  return {
    documentId: sessionName,
    document: { project_name: projectFolderName(session.projectName), state, role, updated_at: updatedAt },
  };
}

// ---- Restarting a stalled listener ----
// When the watch stream breaks, the SDK may wait up to a minute and a half
// before trying again (its longest backoff, after RESOURCE_EXHAUSTED, which
// the Firestore emulator sometimes causes by garbling the stream,
// firebase-tools#8654). Meanwhile every listener answers only from the cache.
// A connection left like that is restarted: disableNetwork stops the stream,
// which resets the SDK's backoff, and enableNetwork reconnects at once.
//
// When the machine is really offline, restarting every 15 s forever would be
// pointless churn (and would override the SDK's own backoff), so the restarts
// back off: 15 s, then 30, 60, 120, and 300 s from then on. Any snapshot that
// came from the server resets that to 15 s.

export interface StalledListenerRestarterOptions {
  someListenerAnswersOnlyFromCache: () => boolean;
  // False while the network was cut on purpose (a test): left cut, checked again later.
  mayRestartNow: () => boolean;
  restartConnection: () => Promise<void>;
  log: (line: string) => void;
  firstRestartDelayMilliseconds?: number;
}

export interface StalledListenerRestarter {
  // After every listener snapshot.
  noteSnapshot(metadata: { fromCache: boolean }): void;
  // After a listener stopped or failed.
  noteListenersChanged(): void;
  stop(): void;
}

export function createStalledListenerRestarter(options: StalledListenerRestarterOptions): StalledListenerRestarter {
  const firstRestartDelayMilliseconds = options.firstRestartDelayMilliseconds ?? STALLED_LISTENER_RESTART_DELAY_MILLISECONDS;
  // Restarts so far in this stall; picks the next delay from the multiples.
  let restartsDuringThisStall = 0;
  function nextRestartDelayMilliseconds(): number {
    const multipleIndex = Math.min(restartsDuringThisStall, STALLED_LISTENER_RESTART_DELAY_MULTIPLES.length - 1);
    return firstRestartDelayMilliseconds * STALLED_LISTENER_RESTART_DELAY_MULTIPLES[multipleIndex];
  }
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartedDuringThisStall = false;
  let stopped = false;

  function cancelTheRestartTimer(): void {
    if (restartTimer !== null) clearTimeout(restartTimer);
    restartTimer = null;
  }

  // Arms the timer while some listener answers only from the cache; disarms it otherwise.
  function reconsider(): void {
    if (stopped) return;
    if (!options.someListenerAnswersOnlyFromCache()) {
      cancelTheRestartTimer();
      return;
    }
    restartTimer ??= setTimeout(() => {
      restartTimer = null;
      void restartBecauseStillStalled();
    }, nextRestartDelayMilliseconds());
  }

  async function restartBecauseStillStalled(): Promise<void> {
    if (stopped || !options.someListenerAnswersOnlyFromCache()) return;
    if (options.mayRestartNow()) {
      // One line per stall, however many restarts it takes.
      if (!restartedDuringThisStall) {
        options.log(`the inbox listener has had no answer from the backend for ${Math.round(nextRestartDelayMilliseconds() / 1000)} s; restarting the connection`);
      }
      restartedDuringThisStall = true;
      try {
        await options.restartConnection();
      } catch (error) {
        options.log(`restarting the connection failed: ${describeError(error)}`);
      }
      restartsDuringThisStall += 1;
    }
    reconsider();
  }

  return {
    noteSnapshot(metadata) {
      if (!metadata.fromCache) {
        // The server answered: the next stall starts again from the first delay.
        restartsDuringThisStall = 0;
        cancelTheRestartTimer();
        if (restartedDuringThisStall && !options.someListenerAnswersOnlyFromCache()) {
          restartedDuringThisStall = false;
          options.log('the inbox listener hears from the backend again');
        }
      }
      reconsider();
    },
    noteListenersChanged: reconsider,
    stop() {
      stopped = true;
      cancelTheRestartTimer();
    },
  };
}

// ---- Notices already handed over ----
// The ids a connection has handed over (or skipped as malformed), from any of
// its listeners' snapshots or from the server check, so none is handed over
// twice. An id is forgotten only when it is certainly gone from the unrung
// list on the server: a server check that read the whole list (fewer than
// its limit came back) and did not return it. Only ids already known when
// that check started are forgotten, never one handed over while it ran. So a
// notice the daemon marked rung stays known until the server has the mark,
// and a failed mark (the notice still unrung there) never lets it come again.
export class NoticesAlreadyHandedOver {
  private readonly messageIds = new Set<string>();

  has(messageId: string): boolean {
    return this.messageIds.has(messageId);
  }

  add(messageId: string): void {
    this.messageIds.add(messageId);
  }

  // From these documents, the notices not handed over yet, oldest first, and
  // the ids of malformed ones (reported once, so the caller can retire them:
  // a malformed notice left unrung would sit among the oldest unrung ones
  // the server check reads). Every id taken here is then known. An id that is
  // not an opaque id is never reported: it could not be marked rung anyway.
  takeTheOnesNotHandedOverYet(documents: ReadonlyArray<{ id: string; data: unknown }>): { newNotices: InboxNotice[]; malformedMessageIds: string[] } {
    const newNotices: InboxNotice[] = [];
    const malformedMessageIds: string[] = [];
    for (const document of documents) {
      if (this.messageIds.has(document.id)) continue;
      this.messageIds.add(document.id);
      const notice = inboxNoticeFrom(document.id, document.data);
      if (notice !== null) newNotices.push(notice);
      else if (isValidOpaqueId(document.id)) malformedMessageIds.push(document.id);
    }
    newNotices.sort((first, second) => first.createdAt - second.createdAt);
    return { newNotices, malformedMessageIds };
  }

  // A copy of the ids known now, to pass to finishServerCheck.
  startServerCheck(): ReadonlySet<string> {
    return new Set(this.messageIds);
  }

  finishServerCheck(knownWhenTheCheckStarted: ReadonlySet<string>, idsTheServerReturned: readonly string[], result: { theWholeUnrungListWasRead: boolean }): void {
    if (!result.theWholeUnrungListWasRead) return;
    const stillUnrungOnTheServer = new Set(idsTheServerReturned);
    for (const messageId of knownWhenTheCheckStarted) {
      if (!stillUnrungOnTheServer.has(messageId)) this.messageIds.delete(messageId);
    }
  }
}

// ---- Firestore ----

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function describeError(error: unknown): string {
  const code = errorCodeOf(error);
  const message = (error as Error | null)?.message ?? String(error);
  return code === undefined ? message : `${code}: ${message}`;
}

export async function connectToBackend(credential: MachineCredential, options: ConnectToBackendOptions): Promise<BackendConnectionWithTestHooks> {
  const { log, clock } = options;
  if (!isValidOpaqueId(credential.machineId)) throw new Error('the machine id in machine.json is not a valid id; pair this machine again');

  // Each connection gets its own named app, so a closed one never shares state with the next.
  const firebaseApp: FirebaseApp = initializeApp(options.firebaseConfig, `claudecommander-daemon-${randomBytes(6).toString('hex')}`);
  const auth: Auth = getAuth(firebaseApp);
  const firestore: Firestore = getFirestore(firebaseApp);
  if (options.useEmulators !== undefined) {
    connectAuthEmulator(auth, options.useEmulators.auth, { disableWarnings: true });
    const [firestoreHost, firestorePort] = options.useEmulators.firestore.split(':');
    connectFirestoreEmulator(firestore, firestoreHost ?? '127.0.0.1', Number(firestorePort));
  }

  let machineRevokedError: MachineRevokedError | null = null;
  let closed = false;
  let announceRevocation: (error: MachineRevokedError) => void = () => {};
  const revocation = new Promise<MachineRevokedError>((resolve) => {
    announceRevocation = resolve;
  });
  // Test hooks only: listeners drop their "added" changes while this is true.
  let ignoreAddedChangesForTests = false;
  // True while a test has cut the network on purpose, so the connection does not undo it.
  let networkDeliberatelyDisabled = false;
  // Every open listener, so the server check can hand each one the notices it
  // missed, and revocation and close can stop them all.
  interface OpenListener {
    stopListening(): void;
    handOverTheOnesNotHandedOverYet(documents: Array<{ id: string; data: unknown }>): void;
    // True while its latest snapshot came from the cache, not the server.
    answeringOnlyFromCache: boolean;
  }
  const openListeners = new Set<OpenListener>();

  function stopAllListeners(): void {
    for (const openListener of [...openListeners]) openListener.stopListening();
    openListeners.clear();
    stalledListenerRestarter.stop();
  }

  // See createStalledListenerRestarter.
  const stalledListenerRestarter = createStalledListenerRestarter({
    someListenerAnswersOnlyFromCache: () => [...openListeners].some((openListener) => openListener.answeringOnlyFromCache),
    mayRestartNow: () => !networkDeliberatelyDisabled && !closed && machineRevokedError === null,
    restartConnection: async () => {
      await disableNetwork(firestore);
      if (!networkDeliberatelyDisabled && !closed) await enableNetwork(firestore);
    },
    log,
    firstRestartDelayMilliseconds: options.stalledListenerRestartDelayMilliseconds,
  });

  // One record for the connection's lifetime, shared by every listener it opens.
  const noticesAlreadyHandedOver = new NoticesAlreadyHandedOver();

  let tokenSession: CustomTokenSession | null = null;

  let revocationCheckTimer: ReturnType<typeof setInterval> | null = null;

  function stopRevocationChecks(): void {
    if (revocationCheckTimer !== null) clearInterval(revocationCheckTimer);
    revocationCheckTimer = null;
  }

  // Called once, from whichever place first learns of a revocation.
  function stopBecauseMachineRevoked(error: MachineRevokedError, alreadyLogged: boolean): void {
    if (machineRevokedError !== null || closed) return;
    machineRevokedError = error;
    if (!alreadyLogged) log(error.message);
    stopAllListeners();
    stopRevocationChecks();
    tokenSession?.stop();
    announceRevocation(error);
  }

  function refuseIfStopped(): void {
    if (machineRevokedError !== null) throw machineRevokedError;
    if (closed) throw new Error('the backend connection is closed');
  }

  try {
    tokenSession = await startCustomTokenSession({
      credential,
      fetchFunction: options.fetchFunction,
      signInWithCustomToken: async (customToken) => {
        await signInWithCustomToken(auth, customToken);
      },
      log,
      // The session has logged it already.
      onMachineRevoked: (error) => stopBecauseMachineRevoked(error, true),
    });
  } catch (error) {
    await deleteApp(firebaseApp);
    throw error;
  }

  const machineDocument = doc(firestore, 'machines', credential.machineId);
  const inboxCollection = collection(firestore, 'machines', credential.machineId, 'inbox');
  const sessionsCollection = collection(firestore, 'machines', credential.machineId, 'sessions');

  // Logs a failed write and passes the error on: nothing is swallowed.
  async function writeOrLog<Result>(whatWasBeingDone: string, write: () => Promise<Result>): Promise<Result> {
    refuseIfStopped();
    try {
      return await write();
    } catch (error) {
      // A write refused after the listener saw the revocation reports that, not the raw error.
      if (machineRevokedError !== null) throw machineRevokedError;
      log(`${whatWasBeingDone} failed: ${describeError(error)}`);
      throw error;
    }
  }

  // The server check, every REVOCATION_CHECK_INTERVAL. It reads the oldest
  // unrung notices from the server (never the cache), so:
  //   - the rules are evaluated now: permission-denied means revoked;
  //   - any notice a listener has not handed over yet is handed over now.
  //     Firestore should never skip one, but the emulator has been seen to
  //     drop a document written while the listener's target was being added,
  //     and a notice no listener hands over would wait until the daemon
  //     restarts. Each listener still hands each notice over at most once.
  // Any other failure (offline, mostly) is logged once when it starts and
  // once when it ends, not every minute.
  let revocationCheckInProgress = false;
  let lastRevocationCheckFailed = false;
  async function checkThatTheMachineIsStillAllowed(): Promise<void> {
    if (revocationCheckInProgress || machineRevokedError !== null || closed) return;
    revocationCheckInProgress = true;
    const knownWhenTheCheckStarted = noticesAlreadyHandedOver.startServerCheck();
    try {
      const oldestUnrungNotices = await getDocsFromServer(
        query(inboxCollection, where('rung_at', '==', null), orderBy('created_at'), limit(MOST_NOTICES_READ_BY_ONE_SERVER_CHECK)),
      );
      if (lastRevocationCheckFailed) log('the revocation check reaches the backend again');
      lastRevocationCheckFailed = false;
      if (machineRevokedError === null && !closed) {
        const documents = oldestUnrungNotices.docs.map((document) => ({ id: document.id, data: document.data() }));
        for (const openListener of [...openListeners]) openListener.handOverTheOnesNotHandedOverYet(documents);
        // Fewer than the limit means this was the whole unrung list.
        noticesAlreadyHandedOver.finishServerCheck(
          knownWhenTheCheckStarted,
          documents.map((document) => document.id),
          { theWholeUnrungListWasRead: documents.length < MOST_NOTICES_READ_BY_ONE_SERVER_CHECK },
        );
      }
    } catch (error) {
      if (machineRevokedError !== null || closed) return;
      if (errorCodeOf(error) === 'permission-denied') {
        stopBecauseMachineRevoked(new MachineRevokedError(), false);
      } else if (!lastRevocationCheckFailed) {
        lastRevocationCheckFailed = true;
        log(`the revocation check could not reach the backend, will keep trying: ${describeError(error)}`);
      }
    } finally {
      revocationCheckInProgress = false;
    }
  }
  revocationCheckTimer = setInterval(() => {
    void checkThatTheMachineIsStillAllowed();
  }, options.revocationCheckIntervalMilliseconds ?? REVOCATION_CHECK_INTERVAL_MILLISECONDS);

  function listenForUnrungNotices(onNotices: (notices: InboxNotice[]) => void, onMalformedNotice?: (messageId: string) => void): () => void {
    refuseIfStopped();
    const unrungNoticesOldestFirst = query(inboxCollection, where('rung_at', '==', null), orderBy('created_at'));
    let stopSnapshotListener: (() => void) | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    // Hands over, oldest first, the documents among these not handed over yet.
    function handOverTheOnesNotHandedOverYet(documents: Array<{ id: string; data: unknown }>): void {
      const { newNotices, malformedMessageIds } = noticesAlreadyHandedOver.takeTheOnesNotHandedOverYet(documents);
      for (const malformedMessageId of malformedMessageIds) {
        log(`skipped a malformed inbox notice ${malformedMessageId}`);
        onMalformedNotice?.(malformedMessageId);
      }
      if (newNotices.length > 0) onNotices(newNotices);
    }

    const openListener: OpenListener = { stopListening, handOverTheOnesNotHandedOverYet, answeringOnlyFromCache: false };

    function stopListening(): void {
      stopSnapshotListener?.();
      stopSnapshotListener = null;
      if (reopenTimer !== null) clearTimeout(reopenTimer);
      reopenTimer = null;
      openListeners.delete(openListener);
      stalledListenerRestarter.noteListenersChanged();
    }

    function openSnapshotListener(): void {
      stopSnapshotListener = onSnapshot(
        unrungNoticesOldestFirst,
        // Metadata changes too, so a listener that falls back to the cache is noticed.
        { includeMetadataChanges: true },
        (snapshot) => {
          // "added" is each document's first appearance in the query's
          // results. One the daemon marks rung leaves the results, so it
          // never comes back.
          const addedDocuments = snapshot
            .docChanges()
            .filter((change) => change.type === 'added' && !ignoreAddedChangesForTests)
            .map((change) => ({ id: change.doc.id, data: change.doc.data() }));
          handOverTheOnesNotHandedOverYet(addedDocuments);
          openListener.answeringOnlyFromCache = snapshot.metadata.fromCache;
          stalledListenerRestarter.noteSnapshot(snapshot.metadata);
        },
        (error) => {
          // Firestore ends a listener that errors. permission-denied is the
          // rules refusing this machine; anything else may pass, so the
          // listener is opened again later (it hands over only notices this
          // connection has not handed over before).
          stopSnapshotListener = null;
          openListener.answeringOnlyFromCache = false;
          stalledListenerRestarter.noteListenersChanged();
          if (errorCodeOf(error) === 'permission-denied') {
            stopBecauseMachineRevoked(new MachineRevokedError(), false);
            return;
          }
          log(`the inbox listener failed, opening it again in 30 seconds: ${describeError(error)}`);
          reopenTimer = setTimeout(() => {
            reopenTimer = null;
            if (machineRevokedError === null && !closed) openSnapshotListener();
          }, RETRY_AFTER_FAILED_LISTENER_MILLISECONDS);
        },
      );
    }

    openListeners.add(openListener);
    openSnapshotListener();
    return stopListening;
  }

  async function markNoticeRung(messageId: string): Promise<void> {
    refuseIfStopped();
    if (!isValidOpaqueId(messageId)) throw new Error('markNoticeRung needs a valid message id');
    await writeOrLog(`marking notice ${messageId} rung`, () => updateDoc(doc(inboxCollection, messageId), { rung_at: clock() }));
  }

  async function sendHeartbeat(): Promise<void> {
    await writeOrLog('the heartbeat', () => updateDoc(machineDocument, { last_seen_at: clock() }));
  }

  async function publishSessions(sessions: PublishedSession[]): Promise<void> {
    refuseIfStopped();
    const updatedAt = clock();
    const documentsByName = new Map<string, PublishedSessionDocument['document']>();
    for (const session of sessions) {
      const published = publishedSessionDocumentFor(session, updatedAt);
      if (published === null) {
        log(`left out a session whose name or state cannot be published (${JSON.stringify(session.sessionName.slice(0, LONGEST_SESSION_NAME))})`);
        continue;
      }
      if (documentsByName.size >= MOST_SESSIONS_PUBLISHED && !documentsByName.has(published.documentId)) {
        log(`published only the first ${MOST_SESSIONS_PUBLISHED} sessions`);
        break;
      }
      documentsByName.set(published.documentId, published.document);
    }

    await writeOrLog('publishing the session list', async () => {
      // The published set as it is now, so sessions that are gone (also ones
      // a previous run left behind) are deleted in the same batch. Read from
      // the server, never the cache: offline this fails at once ("unavailable")
      // instead of building a batch from a stale set that waits for the network.
      const publishedBefore = await getDocsFromServer(sessionsCollection);
      const batch = writeBatch(firestore);
      for (const [sessionName, document] of documentsByName) batch.set(doc(sessionsCollection, sessionName), document);
      for (const existing of publishedBefore.docs) {
        if (!documentsByName.has(existing.id)) batch.delete(existing.ref);
      }
      await batch.commit();
    });
  }

  function requireTestHooks(): void {
    if (options.enableTestHooks !== true) throw new Error('backend connection test hooks are only for tests');
  }

  return {
    listenForUnrungNotices,
    markNoticeRung,
    publishSessions,
    sendHeartbeat,
    whenMachineRevoked: () => revocation,
    async close() {
      if (closed) return;
      closed = true;
      stopAllListeners();
      stopRevocationChecks();
      tokenSession?.stop();
      await deleteApp(firebaseApp);
    },
    testHooks: {
      async disableNetwork() {
        requireTestHooks();
        networkDeliberatelyDisabled = true;
        await disableNetwork(firestore);
      },
      async enableNetwork() {
        requireTestHooks();
        networkDeliberatelyDisabled = false;
        await enableNetwork(firestore);
      },
      async cutNetworkWithoutTellingTheConnection() {
        requireTestHooks();
        await disableNetwork(firestore);
      },
      ignoreAddedChangesFromTheListener(ignore) {
        requireTestHooks();
        ignoreAddedChangesForTests = ignore;
      },
      async refreshCustomTokenNow() {
        requireTestHooks();
        await tokenSession?.refreshNow();
      },
    },
  };
}
