// Owns bounded TUI run state, transcript persistence, and serialized history reloads.
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import { getPendingSubmitAcceptedRunId, hasPendingSubmit } from "./tui-submit-state.js";
import type { ChatEvent, TuiHistoryLoadResult, TuiStateAccess } from "./tui-types.js";

const MAX_TRACKED_RUNS = 200;
const RETAINED_TRACKED_RUNS = 150;
const TRACKED_RUN_RETENTION_MS = 10 * 60 * 1000;

type HistoryOwnedRun = {
  runId: string;
  result: TuiHistoryLoadResult;
  previouslyDisplayed: boolean;
};

type TuiSessionRunCoordinatorContext = {
  state: TuiStateAccess;
  loadHistory?: () => Promise<TuiHistoryLoadResult>;
  refreshSessionInfo?: () => Promise<void>;
  restoreTerminalError: (message: string) => void;
  requestRender: (force?: boolean) => void;
  finalizeHistoryOwnedRun: (run: HistoryOwnedRun) => void;
  replayHistoryRunEvent: (event: ChatEvent) => void;
};

/** Keeps one session's run, persistence, and transcript ownership together. */
export class TuiSessionRunCoordinator {
  readonly sessionRuns = new Map<string, number>();
  readonly finalizedRuns = new Map<string, number>();
  readonly finalizedRunsWithDisplay = new Map<string, number>();
  readonly pendingNewSessionRunIds = new Set<string>();
  readonly persistedTerminalRunIds = new Map<string, number>();
  readonly liveTerminalErrorMessages = new Map<string, string>();
  readonly completedRuns = new Map<string, number>();
  readonly postFinalizingRuns = new Map<string, number>();
  readonly streamAssembler: TuiStreamAssembler;

  pendingHistoryRefresh = false;

  private readonly historyReloadRunIds = new Set<string>();
  private readonly historyOwnedReloadRunIds = new Set<string>();
  private readonly historyDisplayedReloadRunIds = new Set<string>();
  private readonly gapRecoveryReloadRunIds = new Set<string>();
  private readonly queuedHistoryReloadRunIds = new Set<string>();
  private readonly deferredHistoryRunEvents = new Map<string, ChatEvent>();
  private readonly sessionMessagePersistenceRunIds = new Set<string>();
  private readonly confirmedStreamRunIds = new Set<string>();
  private readonly retiredOrphanRunIds = new Map<string, number>();
  private rejectUnconfirmedRuns = false;
  private historyReloadInFlight = false;
  private historyReloadQueued = false;
  private historyReloadGeneration = 0;
  private sessionMessageRefreshPending = false;

  constructor(private readonly context: TuiSessionRunCoordinatorContext) {
    this.streamAssembler = new TuiStreamAssembler((runId) => {
      return (
        runId === this.context.state.activeChatRunId ||
        runId === getPendingSubmitAcceptedRunId(this.context.state) ||
        this.confirmedStreamRunIds.has(runId)
      );
    });
  }

  private pruneRunMap(runs: Map<string, number>, protectActiveRun = false): void {
    if (runs.size <= MAX_TRACKED_RUNS) {
      return;
    }
    const keepUntil = Date.now() - TRACKED_RUN_RETENTION_MS;
    const canRemove = (runId: string) =>
      !protectActiveRun ||
      (runId !== this.context.state.activeChatRunId &&
        runId !== getPendingSubmitAcceptedRunId(this.context.state) &&
        !this.confirmedStreamRunIds.has(runId));

    for (const [runId, seenAt] of runs) {
      if (runs.size <= RETAINED_TRACKED_RUNS) {
        break;
      }
      if (seenAt < keepUntil && canRemove(runId)) {
        runs.delete(runId);
      }
    }
    if (runs.size <= MAX_TRACKED_RUNS) {
      return;
    }
    for (const runId of runs.keys()) {
      if (canRemove(runId)) {
        runs.delete(runId);
      }
      if (runs.size <= RETAINED_TRACKED_RUNS) {
        break;
      }
    }
  }

  noteSessionRun(runId: string, options?: { protectStream?: boolean }): void {
    const confirmedRun =
      options?.protectStream === true ||
      runId === getPendingSubmitAcceptedRunId(this.context.state);
    if (!confirmedRun && this.isRetiredOrphanRun(runId)) {
      return;
    }
    if (confirmedRun) {
      this.retiredOrphanRunIds.delete(runId);
      this.confirmedStreamRunIds.add(runId);
      if (this.confirmedStreamRunIds.size > MAX_TRACKED_RUNS) {
        for (const protectedRunId of this.confirmedStreamRunIds) {
          if (
            protectedRunId !== this.context.state.activeChatRunId &&
            protectedRunId !== getPendingSubmitAcceptedRunId(this.context.state)
          ) {
            this.confirmedStreamRunIds.delete(protectedRunId);
            break;
          }
        }
      }
    }
    this.sessionRuns.set(runId, Date.now());
    this.pruneRunMap(this.sessionRuns, true);
  }

  isRetiredOrphanRun(runId: string): boolean {
    return (
      this.retiredOrphanRunIds.has(runId) ||
      (this.rejectUnconfirmedRuns && !this.sessionRuns.has(runId))
    );
  }

  resolveMostRecentPromotableRun(): string | undefined {
    const pendingRunId = getPendingSubmitAcceptedRunId(this.context.state);
    let nextRunId: string | undefined;
    let nextSeenAt = -1;
    let unconfirmedRunId: string | undefined;
    let unconfirmedSeenAt = -1;
    for (const [runId, seenAt] of this.sessionRuns) {
      if (runId !== pendingRunId && !this.confirmedStreamRunIds.has(runId)) {
        if (seenAt > unconfirmedSeenAt) {
          unconfirmedRunId = runId;
          unconfirmedSeenAt = seenAt;
        }
        continue;
      }
      if (seenAt > nextSeenAt) {
        nextRunId = runId;
        nextSeenAt = seenAt;
      }
    }
    // Peers that omit lifecycle starts can still own a visible concurrent turn,
    // but a confirmed run must always outrank later unconfirmed delta traffic.
    return nextRunId ?? unconfirmedRunId;
  }

  dropSessionRun(runId: string): void {
    this.sessionRuns.delete(runId);
    const completedConfirmedRun = this.confirmedStreamRunIds.delete(runId);
    this.streamAssembler.drop(runId);
    if (completedConfirmedRun && this.confirmedStreamRunIds.size === 0) {
      this.rejectUnconfirmedRuns = true;
      const activeRunId = this.context.state.activeChatRunId;
      const pendingRunId = getPendingSubmitAcceptedRunId(this.context.state);
      // Sequenced Gateway deltas, lifecycle starts, and accepted submits are
      // confirmed separately; leftover orphan deltas cannot reopen completed work.
      for (const candidateRunId of this.sessionRuns.keys()) {
        if (candidateRunId === activeRunId || candidateRunId === pendingRunId) {
          continue;
        }
        this.sessionRuns.delete(candidateRunId);
        this.streamAssembler.drop(candidateRunId);
        this.retiredOrphanRunIds.set(candidateRunId, Date.now());
      }
      this.pruneRunMap(this.retiredOrphanRunIds);
    }
  }

  noteCompletedRun(runId: string): void {
    this.completedRuns.set(runId, Date.now());
    this.pruneRunMap(this.completedRuns);
  }

  noteFinalizedRun(runId: string, options?: { displayedFinal?: boolean }): void {
    this.finalizedRuns.set(runId, Date.now());
    this.noteCompletedRun(runId);
    if (options?.displayedFinal) {
      this.finalizedRunsWithDisplay.set(runId, Date.now());
      if (this.sessionMessageRefreshPending && !this.persistedTerminalRunIds.has(runId)) {
        this.sessionMessagePersistenceRunIds.add(runId);
      }
    }
    this.dropSessionRun(runId);
    this.pruneRunMap(this.finalizedRuns);
    this.pruneRunMap(this.finalizedRunsWithDisplay);

    for (const retainedRunId of this.liveTerminalErrorMessages.keys()) {
      if (!this.finalizedRunsWithDisplay.has(retainedRunId)) {
        this.liveTerminalErrorMessages.delete(retainedRunId);
      }
    }
    for (const retainedRunId of this.sessionMessagePersistenceRunIds) {
      if (!this.finalizedRunsWithDisplay.has(retainedRunId) && retainedRunId !== runId) {
        this.sessionMessagePersistenceRunIds.delete(retainedRunId);
      }
    }
  }

  notePostFinalizingRun(runId: string): void {
    this.postFinalizingRuns.set(runId, Date.now());
    this.pruneRunMap(this.postFinalizingRuns);
  }

  notePersistedRun(runId: string): void {
    this.persistedTerminalRunIds.set(runId, Date.now());
    this.pruneRunMap(this.persistedTerminalRunIds);
    this.sessionMessagePersistenceRunIds.delete(runId);
  }

  bindRegisteredPendingRun(runId: string): void {
    if (
      this.sessionMessageRefreshPending &&
      this.context.state.pendingSubmit?.runId === runId &&
      !this.persistedTerminalRunIds.has(runId)
    ) {
      // A transcript event may precede submit acceptance and its visible final.
      this.sessionMessagePersistenceRunIds.add(runId);
    }
  }

  deferSessionMessageRefresh(): boolean {
    this.sessionMessageRefreshPending = true;
    const activeRunId = this.context.state.activeChatRunId;
    if (activeRunId && !this.persistedTerminalRunIds.has(activeRunId)) {
      this.sessionMessagePersistenceRunIds.add(activeRunId);
    }
    // All already-visible finals must be durable before a destructive rebuild.
    for (const runId of this.finalizedRunsWithDisplay.keys()) {
      if (!this.persistedTerminalRunIds.has(runId)) {
        this.sessionMessagePersistenceRunIds.add(runId);
      }
    }
    return Boolean(
      activeRunId ||
      hasPendingSubmit(this.context.state) ||
      this.sessionMessagePersistenceRunIds.size,
    );
  }

  get hasPendingSessionMessageRefresh(): boolean {
    return this.sessionMessageRefreshPending;
  }

  get isSessionMessagePersistencePending(): boolean {
    return this.sessionMessagePersistenceRunIds.size > 0;
  }

  consumeSessionMessageRefresh(): void {
    this.sessionMessageRefreshPending = false;
    this.sessionMessagePersistenceRunIds.clear();
  }

  isHistoryReloadingRun(runId: string): boolean {
    return this.historyReloadRunIds.has(runId);
  }

  deferHistoryRunEvent(event: ChatEvent): void {
    const previous = this.deferredHistoryRunEvents.get(event.runId);
    // A terminal event remains authoritative over a delayed streaming delta.
    if (!previous || previous.state === "delta" || event.state !== "delta") {
      this.deferredHistoryRunEvents.set(event.runId, event);
    }
  }

  private async loadHistoryPreservingTerminalErrors(): Promise<TuiHistoryLoadResult> {
    if (!this.context.loadHistory) {
      return { loaded: false };
    }
    const generation = this.historyReloadGeneration;
    const result = (await this.context.loadHistory()) ?? { loaded: false };
    if (!result.loaded || generation !== this.historyReloadGeneration) {
      return result;
    }

    let restored = false;
    for (const [runId, message] of this.liveTerminalErrorMessages) {
      if (this.finalizedRunsWithDisplay.has(runId)) {
        this.context.restoreTerminalError(message);
        restored = true;
      }
    }
    if (restored) {
      this.context.requestRender(true);
    }
    return result;
  }

  private drainHistoryReloadQueue(): void {
    if (this.historyReloadInFlight || !this.historyReloadQueued || !this.context.loadHistory) {
      return;
    }

    const generation = this.historyReloadGeneration;
    const runIds = Array.from(this.queuedHistoryReloadRunIds);
    // A second gap may arrive before this reload finishes; keep each drain's
    // ownership separate so the next reload cannot lose its finalization.
    const historyOwnedRunIds = new Set(
      runIds.filter((runId) => this.historyOwnedReloadRunIds.delete(runId)),
    );
    const historyDisplayedRunIds = new Set(
      runIds.filter((runId) => this.historyDisplayedReloadRunIds.delete(runId)),
    );
    const gapRecoveryRunIds = new Set(
      runIds.filter((runId) => this.gapRecoveryReloadRunIds.delete(runId)),
    );
    this.queuedHistoryReloadRunIds.clear();
    this.historyReloadQueued = false;
    this.historyReloadInFlight = true;

    const finishReload = (result: TuiHistoryLoadResult) => {
      if (generation !== this.historyReloadGeneration) {
        return;
      }
      for (const runId of runIds) {
        if (this.queuedHistoryReloadRunIds.has(runId)) {
          continue;
        }
        this.historyReloadRunIds.delete(runId);
        const deferred = this.deferredHistoryRunEvents.get(runId);
        this.deferredHistoryRunEvents.delete(runId);
        const historyOwned = historyOwnedRunIds.has(runId);
        const previouslyDisplayed = historyDisplayedRunIds.has(runId);
        const restoredInFlight = result.loaded && result.inFlightRunId === runId;

        if (historyOwned && !restoredInFlight && (result.loaded || !gapRecoveryRunIds.has(runId))) {
          this.context.finalizeHistoryOwnedRun({ runId, result, previouslyDisplayed });
        }
        if (deferred && (!result.loaded || historyOwned || restoredInFlight)) {
          this.context.replayHistoryRunEvent(deferred);
        }
      }
    };

    void this.loadHistoryPreservingTerminalErrors()
      .then(finishReload, () => finishReload({ loaded: false }))
      .finally(() => {
        this.historyReloadInFlight = false;
        this.drainHistoryReloadQueue();
      });
  }

  queueHistoryReload(
    runIds?: Iterable<string>,
    historyOwnedRunIds: Iterable<string> = [],
    displayedRunIds: Iterable<string> = [],
  ): void {
    const historyOwned = new Set(historyOwnedRunIds);
    const displayed = new Set(displayedRunIds);
    const queuedRunIds = runIds ?? [];

    if (!this.context.loadHistory) {
      for (const runId of queuedRunIds) {
        if (historyOwned.has(runId)) {
          this.noteFinalizedRun(runId, { displayedFinal: true });
        }
      }
      void this.context.refreshSessionInfo?.();
      return;
    }

    if (runIds === undefined) {
      this.historyReloadQueued = true;
    }
    for (const runId of queuedRunIds) {
      this.historyReloadQueued = true;
      this.historyReloadRunIds.add(runId);
      this.queuedHistoryReloadRunIds.add(runId);
      if (historyOwned.has(runId)) {
        this.historyOwnedReloadRunIds.add(runId);
      }
      if (displayed.has(runId)) {
        this.historyDisplayedReloadRunIds.add(runId);
      }
    }
    this.drainHistoryReloadQueue();
  }

  queueGapHistoryReload(runIds: Iterable<string>, displayedRunIds: Iterable<string> = []): void {
    if (!this.context.loadHistory) {
      void this.context.refreshSessionInfo?.();
      return;
    }
    const trackedRunIds = Array.from(runIds);
    if (trackedRunIds.length === 0) {
      this.queueHistoryReload();
      return;
    }
    for (const runId of trackedRunIds) {
      this.gapRecoveryReloadRunIds.add(runId);
    }
    this.queueHistoryReload(trackedRunIds, trackedRunIds, displayedRunIds);
  }

  clear(): void {
    this.historyReloadGeneration += 1;
    this.sessionRuns.clear();
    this.finalizedRuns.clear();
    this.finalizedRunsWithDisplay.clear();
    this.pendingNewSessionRunIds.clear();
    this.persistedTerminalRunIds.clear();
    this.liveTerminalErrorMessages.clear();
    this.completedRuns.clear();
    this.postFinalizingRuns.clear();
    this.historyReloadRunIds.clear();
    this.historyOwnedReloadRunIds.clear();
    this.historyDisplayedReloadRunIds.clear();
    this.gapRecoveryReloadRunIds.clear();
    this.queuedHistoryReloadRunIds.clear();
    this.deferredHistoryRunEvents.clear();
    this.confirmedStreamRunIds.clear();
    this.retiredOrphanRunIds.clear();
    this.rejectUnconfirmedRuns = false;
    this.historyReloadQueued = false;
    this.pendingHistoryRefresh = false;
    this.consumeSessionMessageRefresh();
    this.streamAssembler.clear();
  }
}
