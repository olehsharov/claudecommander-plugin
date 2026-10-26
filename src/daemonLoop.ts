// The daemon's main loop (spec 6.2): it wires the inbox listener, the
// orchestrator keeper, the doorbell, the at-most-once rung ledger and session
// publishing together into one long-running process.
//
// What happens to a notice, from the moment the listener hands it over:
//   1. its id joins the pending set (the listener hands each notice over only
//      once per connection, so the loop must remember it until it is retired);
//   2. a ring pass looks at every pending id:
//        - an id that is not a valid opaque id is logged and marked rung;
//        - an id already in the ledger was rung before (by this daemon or an
//          earlier one): it is only marked rung on the backend;
//        - the rest need a ring. The keeper makes sure the orchestrator runs;
//          a duplicated or conflicting orchestrator gets nothing rung, and an
//          orchestrator still in its MCP warm-up gets nothing rung yet;
//        - the ids are recorded in the ledger BEFORE the ring, then rung once
//          for the whole batch, then marked rung on the backend;
//   3. an id leaves the pending set when its mark succeeds, or when the mark
//      fails with not-found or permission-denied (retention may have deleted
//      the notice). Any other mark failure keeps it pending, so the next pass
//      marks it again (the ledger stops it being rung again).
//
// Recording before ringing is the at-most-once rule: a daemon that dies after
// recording but before (or during) the ring never rings those ids again. A
// lost ring is recoverable, because the orchestrator calls check_inbox when it
// wakes and on every doorbell; a double ring is not, because it would make the
// orchestrator answer the same message twice.
//
// Every 60 s: a keeper check, a retry of the pending ids, a publish of the
// session list if it changed, and a write of the status file. Every 5 min: a
// heartbeat.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { HEARTBEAT_INTERVAL_MILLISECONDS, type BackendConnection, type InboxNotice, type PublishedSession } from './backendConnection.js';
import type { DoorbellOutcome, OrchestratorDoorbell, RungMessageLedger } from './doorbell.js';
import { messageOf } from './commandOutputText.js';
import { isValidOpaqueId } from './ids.js';
import type { OrchestratorState } from './orchestratorKeeper.js';

export const ORCHESTRATOR_CHECK_INTERVAL_MILLISECONDS = 60 * 1000;
// A launched or woken orchestrator gets its MCP tools only after the server connects (about 25 s on the emulator,
// after the first turn: Task 2 Q3). A ring before that would be answered without get_message and, being at-most-once,
// strand the ids until the next message. Start value; Task 26 measures production latency and raises it if needed.
export const ORCHESTRATOR_WARMUP_MILLISECONDS = 30 * 1000;

export interface DaemonLoopDependencies {
  connection: BackendConnection;
  keepOrchestratorRunning: () => Promise<OrchestratorState>;
  doorbell: OrchestratorDoorbell;
  ledger: RungMessageLedger;
  // Every local session, stopped ones included (`claude agents --json --all`),
  // with the orchestrator's row carrying role "orchestrator".
  listLocalSessions: () => Promise<PublishedSession[]>;
  log: (line: string) => void;
  clock: () => number;
  scheduleEvery: (intervalMilliseconds: number, task: () => Promise<void>) => () => void;
  // Runs task once after delayMilliseconds; the returned function cancels it.
  // Used to send a ring the moment an orchestrator's warm-up ends. Defaults to setTimeout.
  scheduleOnce?: (delayMilliseconds: number, task: () => void) => () => void;
  // What the status file needs to say which machine and backend it is about.
  daemonStatusFile: string;
  machineId: string;
  backendUrl: string;
}

export interface RunningDaemonLoop {
  // Stops listening and every schedule, waits for a ring pass in progress, and
  // writes the status file one last time with loop_running false. Every call
  // returns the same promise, so a second stop (SIGTERM after a revocation)
  // also waits for the work in flight instead of returning at once.
  stop: () => Promise<void>;
  // Resolves once the backend refused this machine and the loop stopped itself.
  whenMachineRevoked: Promise<void>;
}

// The status file (DaemonPaths.daemonStatusFile). `daemon status` prints it,
// doctor (Task 21) reads it. Times are epoch milliseconds.
export interface DaemonStatus {
  updated_at: number;
  machine_id: string;
  backend_url: string;
  // True while the loop runs (listening, ticking). It does not prove the
  // Firestore listener is healthy; doctor judges freshness from updated_at.
  loop_running: boolean;
  // The keeper's last answer (running, waiting_for_owner, duplicated,
  // conflict), "error" when the last check failed, null before the first one.
  orchestrator_state: string | null;
  orchestrator_error: string | null;
  last_ring_outcome: { at: number; kind: DoorbellOutcome['kind']; reason?: string } | null;
  // Set while rung.json cannot be read or written; the ids then wait.
  ledger_error: string | null;
  machine_revoked: boolean;
  pending_notice_count: number;
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

// A mark that fails like this will never succeed: the notice is gone, or this
// machine may no longer touch it. Keeping the id would retry it forever.
function markCanNeverSucceed(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'not-found' || code === 'permission-denied';
}

// Written to a temporary file and renamed, so doctor never reads half a file.
export async function writeDaemonStatusFile(statusFile: string, status: DaemonStatus): Promise<void> {
  await mkdir(dirname(statusFile), { recursive: true });
  const temporaryFile = join(dirname(statusFile), `.status-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporaryFile, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    await rename(temporaryFile, statusFile);
  } catch (error) {
    // A failed write must not leave a .status-*.tmp behind on every tick.
    await rm(temporaryFile, { force: true });
    throw error;
  }
}

function scheduleOnceWithSetTimeout(delayMilliseconds: number, task: () => void): () => void {
  const timer = setTimeout(task, delayMilliseconds);
  // A pending warm-up timer alone must not keep a stopping process alive.
  timer.unref();
  return () => clearTimeout(timer);
}

// The session list as it is published: live work sessions, plus exactly one
// orchestrator entry whose state is the keeper's answer when there is one. A
// stopped work session is left out (no one can be talking to it); the
// orchestrator is always published, so a sender sees "stopped", "duplicated"
// or "conflict" instead of nothing. Sorted by name so two equal lists compare
// equal however `claude agents` ordered them.
function buildSessionsToPublish(localSessions: PublishedSession[], orchestratorState: OrchestratorState | null): PublishedSession[] {
  const orchestratorRowFromListing = localSessions.find((session) => session.role === 'orchestrator');
  const nameFromKeeper = orchestratorState === null ? undefined : 'entry' in orchestratorState ? orchestratorState.entry.name : orchestratorState.entries[0]?.name;
  const orchestratorName = nameFromKeeper ?? orchestratorRowFromListing?.sessionName;

  const sessionsToPublish = localSessions.filter(
    (session) => session.role === 'session' && session.state !== 'stopped' && session.sessionName !== orchestratorName,
  );

  if (orchestratorName !== undefined) {
    const projectFromKeeper = orchestratorState === null ? undefined : 'entry' in orchestratorState ? orchestratorState.entry.workingDirectory : orchestratorState.entries[0]?.workingDirectory;
    sessionsToPublish.push({
      sessionName: orchestratorName,
      projectName: orchestratorRowFromListing?.projectName ?? projectFromKeeper ?? '',
      state: orchestratorState?.kind ?? orchestratorRowFromListing?.state ?? 'stopped',
      role: 'orchestrator',
    });
  }
  return sessionsToPublish.sort((first, second) => (first.sessionName < second.sessionName ? -1 : first.sessionName > second.sessionName ? 1 : 0));
}

export function startDaemonLoop(dependencies: DaemonLoopDependencies): RunningDaemonLoop {
  const { connection, ledger, doorbell, log, clock } = dependencies;

  // ---- state ----

  // Notice ids not retired yet, with their created_at so rings list them oldest first.
  const pendingNoticeCreatedAtById = new Map<string, number>();
  // Ids whose markNoticeRung has not answered yet; a pass does not mark them twice.
  const idsWithMarkInFlight = new Set<string>();
  // Malformed notices the connection reported once; retried until retired.
  const malformedNoticeIdsToRetire = new Set<string>();

  let stopped = false;
  let machineRevoked = false;
  let latestOrchestratorState: OrchestratorState | null = null;
  let orchestratorError: string | null = null;
  let ledgerError: string | null = null;
  let lastRingOutcome: DaemonStatus['last_ring_outcome'] = null;

  // Warm-up: the pid last seen running, and when it was first seen.
  let lastSeenOrchestratorPid: number | null = null;
  let lastSeenOrchestratorPidFirstSeenAt = 0;
  let warmUpAlreadyLoggedForPid: number | null = null;

  // The session list last published successfully, as JSON, to skip a republish of the same list.
  let lastPublishedSessionsJson: string | null = null;

  // ---- status file ----

  // Writes go one after another, so an older status never lands after a newer one.
  let previousStatusWrite: Promise<void> = Promise.resolve();
  function writeStatus(): Promise<void> {
    const status: DaemonStatus = {
      updated_at: clock(),
      machine_id: dependencies.machineId,
      backend_url: dependencies.backendUrl,
      loop_running: !stopped,
      orchestrator_state: orchestratorError !== null ? 'error' : latestOrchestratorState?.kind ?? null,
      orchestrator_error: orchestratorError,
      last_ring_outcome: lastRingOutcome,
      ledger_error: ledgerError,
      machine_revoked: machineRevoked,
      pending_notice_count: pendingNoticeCreatedAtById.size,
    };
    previousStatusWrite = previousStatusWrite.then(() =>
      writeDaemonStatusFile(dependencies.daemonStatusFile, status).catch((error: unknown) => {
        log(`could not write the status file ${dependencies.daemonStatusFile}: ${messageOf(error)}`);
      }),
    );
    return previousStatusWrite;
  }

  // ---- the keeper, single-flight ----

  // One keeper run at a time per process. A tick or a notice batch that comes
  // while a check (with its wake or launch and their confirmation listings) is
  // in flight waits for that same check, so two checks can never launch twice.
  let keeperRunInFlight: Promise<OrchestratorState | null> | null = null;

  function checkOrchestrator(): Promise<OrchestratorState | null> {
    if (keeperRunInFlight !== null) return keeperRunInFlight;
    keeperRunInFlight = (async () => {
      try {
        const state = await dependencies.keepOrchestratorRunning();
        noteOrchestratorState(state);
        return state;
      } catch (error) {
        orchestratorError = messageOf(error);
        log(`the orchestrator check failed: ${orchestratorError}; pending notices wait for the next check`);
        return null;
      } finally {
        keeperRunInFlight = null;
      }
    })();
    return keeperRunInFlight;
  }

  function noteOrchestratorState(state: OrchestratorState): void {
    latestOrchestratorState = state;
    orchestratorError = null;
    // Only a live, single orchestrator has a pid that matters for warm-up. A
    // pid other than the last one seen means a launch, a wake, or a daemon
    // that just started next to a session it has never seen: its MCP tools
    // may not be connected yet.
    if ((state.kind === 'running' || state.kind === 'waiting_for_owner') && state.entry.pid !== lastSeenOrchestratorPid) {
      lastSeenOrchestratorPid = state.entry.pid;
      lastSeenOrchestratorPidFirstSeenAt = clock();
    }
  }

  function warmUpMillisecondsLeft(): number {
    return Math.max(0, ORCHESTRATOR_WARMUP_MILLISECONDS - (clock() - lastSeenOrchestratorPidFirstSeenAt));
  }

  // One timer at most: when the warm-up ends it asks for a ring pass, so a
  // held ring goes out then rather than at the next 60 s tick.
  const scheduleOnce = dependencies.scheduleOnce ?? scheduleOnceWithSetTimeout;
  let cancelWarmUpTimer: (() => void) | null = null;
  function ringWhenTheWarmUpEnds(): void {
    if (cancelWarmUpTimer !== null || stopped) return;
    cancelWarmUpTimer = scheduleOnce(warmUpMillisecondsLeft(), () => {
      cancelWarmUpTimer = null;
      if (!stopped) void requestRingPass();
    });
  }

  // ---- marks ----

  // Started without waiting: writes made while offline resolve only when the
  // server acknowledges them, so waiting on each in turn would stall the loop.
  function markRungInTheBackground(messageId: string): void {
    if (idsWithMarkInFlight.has(messageId)) return;
    idsWithMarkInFlight.add(messageId);
    connection
      .markNoticeRung(messageId)
      .then(() => {
        pendingNoticeCreatedAtById.delete(messageId);
      })
      .catch((error: unknown) => {
        if (markCanNeverSucceed(error)) {
          pendingNoticeCreatedAtById.delete(messageId);
          log(`dropped notice ${messageId}: marking it rung failed with ${errorCodeOf(error)} (it may have been deleted)`);
        }
        // Any other failure keeps the id pending; the next pass marks it again.
      })
      .finally(() => {
        idsWithMarkInFlight.delete(messageId);
      });
  }

  async function retireMalformedNotices(): Promise<void> {
    for (const messageId of [...malformedNoticeIdsToRetire]) {
      try {
        await connection.markNoticeRung(messageId);
        malformedNoticeIdsToRetire.delete(messageId);
      } catch (error) {
        if (markCanNeverSucceed(error)) malformedNoticeIdsToRetire.delete(messageId);
      }
    }
  }

  // ---- the ledger ----

  function reportLedgerError(error: unknown): void {
    ledgerError = messageOf(error);
    // Loud on every batch it blocks: messages wait until someone fixes it.
    log(`ERROR: the rung ledger failed, so nothing is rung until it is fixed (doctor reports it): ${ledgerError}`);
  }

  // ---- ringing ----

  function pendingIdsOldestFirst(): string[] {
    return [...pendingNoticeCreatedAtById.entries()]
      .filter(([messageId]) => !idsWithMarkInFlight.has(messageId))
      .sort(([, firstCreatedAt], [, secondCreatedAt]) => firstCreatedAt - secondCreatedAt)
      .map(([messageId]) => messageId);
  }

  // One pass over the pending ids. stateFromThisTick is the keeper answer the
  // tick just got, so a tick does not list the sessions twice.
  async function ringPendingNotices(stateFromThisTick: OrchestratorState | null): Promise<void> {
    const candidateIds = pendingIdsOldestFirst();
    if (candidateIds.length === 0) return;

    const idsNeedingARing: string[] = [];
    const idsAlreadyRung: string[] = [];
    try {
      for (const messageId of candidateIds) {
        if (!isValidOpaqueId(messageId)) {
          // The connection never hands one over; this guards the doorbell text all the same.
          log('a notice id is not a valid message id; marking it rung without ringing');
          idsAlreadyRung.push(messageId);
        } else if (await ledger.hasBeenRung(messageId)) {
          idsAlreadyRung.push(messageId);
        } else {
          idsNeedingARing.push(messageId);
        }
      }
    } catch (error) {
      reportLedgerError(error);
      await writeStatus();
      return;
    }
    if (ledgerError !== null) {
      ledgerError = null;
      log('the rung ledger is readable again');
    }

    for (const messageId of idsAlreadyRung) markRungInTheBackground(messageId);
    if (idsNeedingARing.length === 0) return;

    // After a stop nothing may launch an orchestrator or ring.
    if (stopped) return;
    const orchestratorState = stateFromThisTick ?? (await checkOrchestrator());
    if (orchestratorState === null || stopped) return;
    if (orchestratorState.kind === 'duplicated' || orchestratorState.kind === 'conflict') {
      // Ringing would wake the wrong session, or two of them. Senders learn of
      // it from the published orchestrator state (send_message warns on it).
      const sessionName = orchestratorState.entries[0]?.name ?? '(unknown)';
      log(
        orchestratorState.kind === 'duplicated'
          ? `more than one background session is named ${sessionName}; ringing nothing until only one is left (claudecommander daemon doctor)`
          : `the orchestrator name ${sessionName} belongs only to an interactive session; ringing nothing until it is renamed (claudecommander daemon doctor)`,
      );
      await publishSessionsIfChanged(orchestratorState);
      return;
    }

    if (warmUpMillisecondsLeft() > 0) {
      ringWhenTheWarmUpEnds();
      if (warmUpAlreadyLoggedForPid !== lastSeenOrchestratorPid) {
        warmUpAlreadyLoggedForPid = lastSeenOrchestratorPid;
        log(`the orchestrator (pid ${lastSeenOrchestratorPid}) only just started; holding rings for ${Math.ceil(warmUpMillisecondsLeft() / 1000)} s while its MCP tools connect`);
      }
      return;
    }

    if (stopped) return;
    try {
      await ledger.recordRung(idsNeedingARing);
    } catch (error) {
      reportLedgerError(error);
      await writeStatus();
      return;
    }

    let outcome: DoorbellOutcome;
    try {
      outcome = await doorbell.ringOrchestratorDoorbell(idsNeedingARing);
    } catch (error) {
      outcome = { kind: 'failed', reason: messageOf(error) };
    }
    lastRingOutcome = outcome.kind === 'rung' ? { at: clock(), kind: 'rung' } : { at: clock(), kind: outcome.kind, reason: outcome.reason };
    const idList = idsNeedingARing.join(', ');
    if (outcome.kind === 'rung') {
      log(`rang the orchestrator for ${idList}`);
    } else if (outcome.kind === 'refused') {
      log(
        `WARNING: the orchestrator held or refused the doorbell for ${idList}: ${outcome.reason}. ` +
          'Its crossSessionInbound setting, or a permission mode different from the doorbell sender\'s, makes it hold cross-session messages; ' +
          'the ids stay recorded and the orchestrator finds them with check_inbox. Run claudecommander daemon doctor.',
      );
    } else {
      log(`ringing the orchestrator for ${idList} failed: ${outcome.reason}; the ids stay recorded and the orchestrator finds them with check_inbox`);
    }
    await writeStatus();
    // Marked whatever the outcome: the ids are recorded, so they are never rung again anyway.
    for (const messageId of idsNeedingARing) markRungInTheBackground(messageId);
  }

  // Ring passes run one at a time. Notices that arrive while one is running
  // (a ring takes seconds) are picked up by one more pass right after it, so
  // they share the next ring instead of each getting their own.
  let ringPassInFlight: Promise<void> | null = null;
  let anotherRingPassRequested = false;
  let stateForTheNextRingPass: OrchestratorState | null = null;

  function requestRingPass(stateFromThisTick: OrchestratorState | null = null): Promise<void> {
    if (stateFromThisTick !== null) stateForTheNextRingPass = stateFromThisTick;
    if (ringPassInFlight !== null) {
      anotherRingPassRequested = true;
      return ringPassInFlight;
    }
    ringPassInFlight = (async () => {
      try {
        do {
          anotherRingPassRequested = false;
          const state = stateForTheNextRingPass;
          stateForTheNextRingPass = null;
          await ringPendingNotices(state);
        } while (anotherRingPassRequested && !stopped);
      } catch (error) {
        log(`a ring pass failed unexpectedly: ${messageOf(error)}`);
      } finally {
        ringPassInFlight = null;
      }
    })();
    return ringPassInFlight;
  }

  // ---- publishing sessions ----

  async function publishSessionsIfChanged(orchestratorState: OrchestratorState | null): Promise<void> {
    let localSessions: PublishedSession[];
    try {
      localSessions = await dependencies.listLocalSessions();
    } catch (error) {
      log(`could not list the local sessions: ${messageOf(error)}`);
      return;
    }
    const sessionsToPublish = buildSessionsToPublish(localSessions, orchestratorState);
    const sessionsJson = JSON.stringify(sessionsToPublish);
    if (sessionsJson === lastPublishedSessionsJson) return;
    try {
      await connection.publishSessions(sessionsToPublish);
      lastPublishedSessionsJson = sessionsJson;
    } catch {
      // The connection logged it; the next tick tries again because nothing was remembered.
    }
  }

  // ---- the schedules ----

  // The tick in progress, so stop can wait for it (its session listing runs claude).
  let tickInFlight: Promise<void> | null = null;
  function runOneTick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (tickInFlight !== null) return tickInFlight;
    tickInFlight = runOneTickNow().finally(() => { tickInFlight = null; });
    return tickInFlight;
  }

  async function runOneTickNow(): Promise<void> {
    const orchestratorState = await checkOrchestrator();
    if (stopped) return;
    // After a failed check (null) the orchestrator is published as the listing shows it.
    await publishSessionsIfChanged(orchestratorState);
    await retireMalformedNotices();
    await requestRingPass(orchestratorState);
    await writeStatus();
  }

  async function sendHeartbeat(): Promise<void> {
    if (stopped) return;
    try {
      // The connection writes the daemon's own clock as last_seen_at.
      await connection.sendHeartbeat();
    } catch (error) {
      if (errorCodeOf(error) === 'permission-denied') {
        log(
          'the heartbeat was refused by the backend: the rules accept last_seen_at only within 60 s ahead of and 5 minutes behind server time, ' +
            "so check this machine's clock (or whether the machine was revoked)",
        );
      }
      // Other failures were logged by the connection; the next heartbeat tries again.
    }
  }

  const cancelTicks = dependencies.scheduleEvery(ORCHESTRATOR_CHECK_INTERVAL_MILLISECONDS, runOneTick);
  const cancelHeartbeats = dependencies.scheduleEvery(HEARTBEAT_INTERVAL_MILLISECONDS, sendHeartbeat);

  function rememberNotices(notices: InboxNotice[]): void {
    if (stopped) return;
    for (const notice of notices) {
      if (!pendingNoticeCreatedAtById.has(notice.messageId)) pendingNoticeCreatedAtById.set(notice.messageId, notice.createdAt);
    }
    void requestRingPass();
  }

  // A notice the connection could not read is never handed over. Marking it
  // rung takes it out of the unrung list, so it cannot sit among the 50 oldest
  // unrung notices the connection's reconcile reads and push newer ones out.
  function retireMalformedNotice(messageId: string): void {
    if (stopped) return;
    log(`notice ${messageId} could not be read; marking it rung so it does not block newer notices`);
    malformedNoticeIdsToRetire.add(messageId);
    void retireMalformedNotices();
  }

  const unsubscribeFromInbox = connection.listenForUnrungNotices(rememberNotices, retireMalformedNotice);

  let stopping: Promise<void> | null = null;
  function stopEverything(): Promise<void> {
    stopping ??= stopAndWaitForWorkInFlight();
    return stopping;
  }

  async function stopAndWaitForWorkInFlight(): Promise<void> {
    stopped = true;
    cancelTicks();
    cancelHeartbeats();
    cancelWarmUpTimer?.();
    cancelWarmUpTimer = null;
    unsubscribeFromInbox();
    // Wait for work already started, so no claude child (a listing, a wake,
    // a launch or a doorbell) is still running when the caller closes up.
    await tickInFlight;
    await keeperRunInFlight;
    await ringPassInFlight;
    await writeStatus();
  }

  let markLoopRevoked: () => void = () => undefined;
  const whenMachineRevoked = new Promise<void>((resolve) => { markLoopRevoked = resolve; });
  void connection.whenMachineRevoked().then(async (revocation) => {
    if (stopped) return;
    machineRevoked = true;
    // The message already says what to do (pair again with --force).
    log(`${revocation.message}; the daemon loop stopped`);
    await stopEverything();
    markLoopRevoked();
  });

  // The first tick and heartbeat run at once rather than a full interval later.
  void sendHeartbeat();
  void runOneTick();

  return { stop: stopEverything, whenMachineRevoked };
}
