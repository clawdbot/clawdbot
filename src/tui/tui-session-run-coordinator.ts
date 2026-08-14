// Owns bounded TUI run state, transcript persistence, and serialized history reloads.
import { TuiStreamAssembler } from "./tui-stream-assembler.js";
import { getPendingSubmitAcceptedRunId, hasPendingSubmit } from "./tui-submit-state.js";
import type { ChatEvent, TuiHistoryLoadResult, TuiStateAccess } from "./tui-types.js";

const MAX_TRACKED_RUNS = 200;
const RETAINED_TRACKED_RUNS = 150;
const TRACKED_RUN_RETENTION_MS = 10 * 60 * 1000;
const HISTORY_RELOAD_QUEUED = 1;
const HISTORY_RELOAD_OWNED = 1 << 1;
const HISTORY_RELOAD_DISPLAYED = 1 << 2;
const HISTORY_RELOAD_GAP_RECOVERY = 1 << 3;

/** A small FIFO membership tracker for run IDs that need no lifecycle metadata. */
export function createTuiRunIdTracker() {
  const runIds = new Set<string>();
  return {
    note: (runId: string) => {
      if (runId) {
        runIds.add(runId);
      }
      if (runIds.size > MAX_TRACKED_RUNS) {
        runIds.delete(runIds.values().next().value as string);
      }
    },
    forget: (runId: string) => void runIds.delete(runId),
    has: (runId: string) => runIds.has(runId),
    clear: () => runIds.clear(),
  };
}

type HistoryOwnedRun = {
  runId: string;
  result: TuiHistoryLoadResult;
  previouslyDisplayed: boolean;
};

type TuiHistoryReloadRun = {
  flags: number;
  deferredEvent?: ChatEvent;
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

  private readonly historyReloadRuns = new Map<string, TuiHistoryReloadRun>();
  private readonly confirmedStreamRunIds = new Set<string>();
  private readonly retiredOrphanRunIds = new Map<string, number>();
  private rejectUnconfirmedRuns = false;
  private historyReloadInFlight = false;
  private historyReloadQueued = false;
  private historyReloadGeneration = 0;

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
    }
    this.dropSessionRun(runId);
    this.pruneRunMap(this.finalizedRuns);
    this.pruneRunMap(this.finalizedRunsWithDisplay);

    for (const retainedRunId of this.liveTerminalErrorMessages.keys()) {
      if (!this.finalizedRunsWithDisplay.has(retainedRunId)) {
        this.liveTerminalErrorMessages.delete(retainedRunId);
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
  }

  routeSessionMessageRefresh(projected: boolean): boolean {
    if (projected) {
      return true;
    }
    if (this.context.state.activeChatRunId || hasPendingSubmit(this.context.state)) {
      this.pendingHistoryRefresh = true;
      return true;
    }
    this.queueHistoryReload();
    return false;
  }

  isHistoryReloadingRun(runId: string): boolean {
    return this.historyReloadRuns.has(runId);
  }

  deferHistoryRunEvent(event: ChatEvent): void {
    const reload = this.historyReloadRuns.get(event.runId);
    if (!reload) {
      return;
    }
    const previous = reload.deferredEvent;
    // A terminal event remains authoritative over a delayed streaming delta.
    if (!previous || previous.state === "delta" || event.state !== "delta") {
      reload.deferredEvent = event;
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
    // Snapshot each run's flags before awaiting; an overlapping gap owns the
    // next drain and must not inherit or erase this drain's finalization.
    const reloads: Array<{ runId: string; flags: number }> = [];
    for (const [runId, reload] of this.historyReloadRuns) {
      if (reload.flags & HISTORY_RELOAD_QUEUED) {
        reloads.push({ runId, flags: reload.flags });
        reload.flags = 0;
      }
    }
    this.historyReloadQueued = false;
    this.historyReloadInFlight = true;

    const finishReload = (result: TuiHistoryLoadResult) => {
      if (generation !== this.historyReloadGeneration) {
        return;
      }
      for (const { runId, flags } of reloads) {
        const current = this.historyReloadRuns.get(runId);
        if (!current || current.flags & HISTORY_RELOAD_QUEUED) {
          continue;
        }
        this.historyReloadRuns.delete(runId);
        const deferred = current.deferredEvent;
        const historyOwned = Boolean(flags & HISTORY_RELOAD_OWNED);
        const previouslyDisplayed = Boolean(flags & HISTORY_RELOAD_DISPLAYED);
        const gapRecovery = Boolean(flags & HISTORY_RELOAD_GAP_RECOVERY);
        const restoredInFlight = result.loaded && result.inFlightRunId === runId;

        if (historyOwned && !restoredInFlight && (result.loaded || !gapRecovery)) {
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
      const reload = this.historyReloadRuns.get(runId) ?? { flags: 0 };
      reload.flags |= HISTORY_RELOAD_QUEUED;
      if (historyOwned.has(runId)) {
        reload.flags |= HISTORY_RELOAD_OWNED;
      }
      if (displayed.has(runId)) {
        reload.flags |= HISTORY_RELOAD_DISPLAYED;
      }
      this.historyReloadRuns.set(runId, reload);
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
      const reload = this.historyReloadRuns.get(runId) ?? { flags: 0 };
      reload.flags |= HISTORY_RELOAD_GAP_RECOVERY;
      this.historyReloadRuns.set(runId, reload);
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
    this.historyReloadRuns.clear();
    this.confirmedStreamRunIds.clear();
    this.retiredOrphanRunIds.clear();
    this.rejectUnconfirmedRuns = false;
    this.historyReloadQueued = false;
    this.pendingHistoryRefresh = false;
    this.streamAssembler.clear();
  }
}
