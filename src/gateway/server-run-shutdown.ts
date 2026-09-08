import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { captureGatewayReplyRunRestartAbort } from "../auto-reply/reply/reply-run-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  isChatAbortControllerEntryAbortable,
  removeChatAbortControllerEntry,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import { abortQueuedChatTurns, type QueuedChatTurnMap } from "./chat-queued-turns.js";
import {
  createChatAbortMarker,
  type ChatRunEntry,
  type ChatRunState,
} from "./server-chat-state.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayShutdownTimeout, recordGatewayShutdownWarning } from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const RESTART_REPLY_DRAIN_POLL_MS = 100;
const RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS = 1_000;
const RESTART_MARKER_SLOW_WARNING_MS = 1_000;

function getRestartReplyDrainCounts(params: {
  getPendingReplyCount: () => number;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
}) {
  const pendingReplyCount = params.getPendingReplyCount();
  const activeRuns = listRestartDrainRuns(params.chatAbortControllers).length;
  const queuedTurns = Array.from(
    params.chatQueuedTurns.values(),
    (entry) => entry.controller.signal.aborted,
  ).filter((aborted) => !aborted).length;
  return {
    pendingReplies:
      Number.isFinite(pendingReplyCount) && pendingReplyCount > 0
        ? Math.floor(pendingReplyCount)
        : 0,
    activeRuns,
    queuedTurns,
  };
}

function listUnabortedRuns(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Array<[string, ChatAbortControllerEntry]> {
  return Array.from(chatAbortControllers.entries()).filter(
    ([, entry]) => !entry.controller.signal.aborted,
  );
}

function listRestartDrainRuns(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Array<[string, ChatAbortControllerEntry]> {
  return listUnabortedRuns(chatAbortControllers).filter(
    ([, entry]) => entry.registrationCleanupRequested !== true,
  );
}

function listRestartRecoveryRuns(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Array<[string, ChatAbortControllerEntry]> {
  return listUnabortedRuns(chatAbortControllers).filter(
    ([, entry]) =>
      entry.controlUiVisible !== false &&
      (entry.registrationCleanupRequested !== true ||
        entry.projectSessionTerminalPersisted !== true),
  );
}

function formatRestartReplyDrainDetails(counts: {
  pendingReplies: number;
  activeRuns: number;
  queuedTurns: number;
}): string {
  const details: string[] = [];
  if (counts.pendingReplies > 0) {
    details.push(`${counts.pendingReplies} pending reply(ies)`);
  }
  if (counts.activeRuns > 0) {
    details.push(`${counts.activeRuns} active run(s)`);
  }
  if (counts.queuedTurns > 0) {
    details.push(`${counts.queuedTurns} queued turn(s)`);
  }
  return details.length > 0 ? details.join(", ") : "no pending reply work";
}

async function sleepForRestartReplyDrain(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export type GatewayRunShutdownParams = {
  resolveGatewayContext: GatewayContextResolver;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
  restartRecoveryCandidates?: Map<string, RestartRecoveryCandidate>;
  chatRunState: ChatRunState;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  markMainSessionsAbortedForRestart?: (params: {
    resolveGatewayContext: GatewayContextResolver;
    activeRuns: RestartRecoveryCandidate[];
    reason: string;
    isActiveRun: (run: RestartRecoveryCandidate) => boolean;
  }) => Promise<void> | void;
  resolveActiveSessionIdForKey?: (sessionKey: string) => string | undefined;
};

async function waitForRestartReplyDrain(params: {
  getPendingReplyCount: () => number;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
  timeoutMs: number;
}): Promise<{
  drained: boolean;
  elapsedMs: number;
  counts: { pendingReplies: number; activeRuns: number; queuedTurns: number };
}> {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  let counts = getRestartReplyDrainCounts(params);
  if (counts.pendingReplies <= 0 && counts.activeRuns <= 0 && counts.queuedTurns <= 0) {
    return { drained: true, elapsedMs: 0, counts };
  }
  if (timeoutMs <= 0) {
    return { drained: false, elapsedMs: 0, counts };
  }

  const startedAt = Date.now();
  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { drained: false, elapsedMs, counts };
    }
    await sleepForRestartReplyDrain(Math.min(RESTART_REPLY_DRAIN_POLL_MS, timeoutMs - elapsedMs));
    counts = getRestartReplyDrainCounts(params);
    if (counts.pendingReplies <= 0 && counts.activeRuns <= 0 && counts.queuedTurns <= 0) {
      return { drained: true, elapsedMs: Date.now() - startedAt, counts };
    }
  }
}

function collectActiveRestartSessionRefs(
  params: Pick<
    GatewayRunShutdownParams,
    "chatAbortControllers" | "resolveActiveSessionIdForKey" | "restartRecoveryCandidates"
  >,
): RestartRecoveryCandidate[] {
  const activeRuns = new Map<string, RestartRecoveryCandidate>();
  const observedAt = Date.now();
  const addRun = (run: RestartRecoveryCandidate) => {
    activeRuns.set(`${run.runId}\u0000${run.lifecycleGeneration}`, {
      ...run,
      observedAt: run.observedAt ?? observedAt,
    });
  };
  for (const [runId, entry] of listRestartRecoveryRuns(params.chatAbortControllers)) {
    const sessionKey = entry.sessionKey.trim();
    // Registration metadata can predate a reset or compaction session-id rotation.
    const resolvedSessionId =
      entry.kind === "agent" || !sessionKey
        ? undefined
        : params.resolveActiveSessionIdForKey?.(sessionKey);
    const sessionId = resolvedSessionId || entry.sessionId.trim();
    if (runId && entry.lifecycleGeneration && sessionKey && sessionId) {
      addRun({
        runId,
        lifecycleGeneration: entry.lifecycleGeneration,
        sessionKey,
        sessionId,
        observedAt: entry.projectSessionTerminalObservedAt,
      });
    }
  }
  for (const candidate of params.restartRecoveryCandidates?.values() ?? []) {
    const resolvedSessionId = params.resolveActiveSessionIdForKey?.(candidate.sessionKey);
    addRun({
      ...candidate,
      sessionId: resolvedSessionId || candidate.sessionId,
    });
  }
  return [...activeRuns.values()];
}

async function settleTerminalSessionPersistenceForRestart(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
): Promise<void> {
  const pending = listUnabortedRuns(chatAbortControllers).flatMap(([, entry]) => {
    const persistence = entry.projectSessionTerminalPersistence;
    if (entry.projectSessionActive !== false || !persistence) {
      return [];
    }
    return [{ entry, persistence }];
  });
  if (pending.length === 0) {
    return;
  }
  const timeout = createGatewayShutdownTimeout(
    RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS,
    () => null,
  );
  const results = await Promise.race([
    Promise.allSettled(pending.map(({ persistence }) => persistence)),
    timeout.promise,
  ]);
  timeout.clear();
  if (!results) {
    shutdownLog.warn(
      `terminal session persistence did not settle within ${RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS}ms; preserving restart recovery`,
    );
    return;
  }
  for (const [index, result] of results.entries()) {
    const tracked = pending[index];
    if (!tracked || tracked.entry.projectSessionTerminalPersistence !== tracked.persistence) {
      continue;
    }
    tracked.entry.projectSessionTerminalPending = false;
    tracked.entry.projectSessionTerminalPersistence = undefined;
    if (result.status === "fulfilled") {
      tracked.entry.projectSessionTerminalPersisted = true;
    }
  }
}

async function markActiveRunsForRestartRecovery(
  params: GatewayRunShutdownParams & {
    reason: string;
    warnings: string[];
  },
): Promise<number> {
  if (!params.markMainSessionsAbortedForRestart) {
    return 0;
  }
  await settleTerminalSessionPersistenceForRestart(params.chatAbortControllers);
  const activeRuns = collectActiveRestartSessionRefs(params);
  const activeEntries = new Map(params.chatAbortControllers);
  const recoveryCandidates = new Map(params.restartRecoveryCandidates);
  const abortReplyRuns = captureGatewayReplyRunRestartAbort(params.resolveGatewayContext);
  try {
    const markerTimeout = createGatewayShutdownTimeout(
      RESTART_MARKER_SLOW_WARNING_MS,
      () => "timeout" as const,
    );
    const markerOutcome = Promise.resolve(
      params.markMainSessionsAbortedForRestart({
        resolveGatewayContext: params.resolveGatewayContext,
        activeRuns,
        reason: params.reason,
        isActiveRun: (run) => {
          const entry = params.chatAbortControllers.get(run.runId);
          const candidate = params.restartRecoveryCandidates?.get(run.runId);
          return (
            (entry &&
              entry === activeEntries.get(run.runId) &&
              !entry.controller.signal.aborted &&
              (entry.registrationCleanupRequested !== true ||
                entry.projectSessionTerminalPersisted !== true) &&
              entry.lifecycleGeneration === run.lifecycleGeneration) ||
            (candidate !== undefined &&
              candidate === recoveryCandidates.get(run.runId) &&
              candidate.lifecycleGeneration === run.lifecycleGeneration)
          );
        },
      }),
    ).then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    const firstOutcome = await Promise.race([markerOutcome, markerTimeout.promise]);
    markerTimeout.clear();
    if (firstOutcome === "timeout") {
      shutdownLog.warn(
        `restart session marker did not settle within ${RESTART_MARKER_SLOW_WARNING_MS}ms; waiting before shutdown`,
      );
      recordGatewayShutdownWarning(params.warnings, "restart-main-session-marker");
      const delayedOutcome = await markerOutcome;
      if (delayedOutcome.status === "failed") {
        throw delayedOutcome.error;
      }
    } else if (firstOutcome.status === "failed") {
      throw firstOutcome.error;
    }
    for (const run of activeRuns) {
      if (params.restartRecoveryCandidates?.get(run.runId) === recoveryCandidates.get(run.runId)) {
        params.restartRecoveryCandidates?.delete(run.runId);
      }
    }
  } catch (err) {
    shutdownLog.warn(`failed to mark active main session(s) for restart recovery: ${String(err)}`);
    recordGatewayShutdownWarning(params.warnings, "restart-main-session-marker");
  }
  // Disposing a tool cell can settle its result and start a finalizer. Cancel its
  // parent after the marker settles, including failures, before resource teardown.
  return abortReplyRuns((sessionId, error) => {
    shutdownLog.warn(
      `failed to cancel reply for restart: sessionId=${sessionId} error=${String(error)}`,
    );
    recordGatewayShutdownWarning(params.warnings, "restart-reply-abort");
  });
}

/** Cancels only this Gateway's exact controller registrations. */
function abortActiveRuns(params: GatewayRunShutdownParams, restart: boolean): number {
  let aborted = 0;
  for (const [runId, entry] of listUnabortedRuns(params.chatAbortControllers)) {
    if (!isChatAbortControllerEntryAbortable(entry)) {
      continue;
    }
    if (entry.projectSessionActive === false) {
      entry.abortStopReason = restart ? "restart" : "rpc";
      entry.controller.abort(restart ? createAgentRunRestartAbortError() : undefined);
      removeChatAbortControllerEntry(params.chatAbortControllers, runId, entry);
      params.chatRunState.getOrCreate(runId).abortMarker = createChatAbortMarker();
      params.chatRunState.clearRun(runId);
      const removed = params.removeChatRun(runId, runId, entry.sessionKey);
      params.agentRunSeq.delete(runId);
      if (removed?.clientRunId) {
        params.agentRunSeq.delete(removed.clientRunId);
      }
      aborted += 1;
      continue;
    }
    const result = abortChatRunById(params, {
      runId,
      sessionKey: entry.sessionKey,
      stopReason: restart ? "restart" : "rpc",
    });
    if (result.aborted) {
      aborted += 1;
    }
  }
  return aborted;
}

/** Abort queued owners before active teardown can promote them into the closing runtime. */
function abortQueuedTurns(params: GatewayRunShutdownParams, restart: boolean): number {
  const matches = Array.from(params.chatQueuedTurns, ([runId, entry]) => ({ runId, entry }));
  return abortQueuedChatTurns(params.chatQueuedTurns, matches, restart ? "restart" : undefined)
    .length;
}

/** Completes grace and requests cancellation before execution joining begins. */
export async function prepareGatewayRunShutdown(
  params: {
    restart: boolean;
    getPendingReplyCount: () => number;
    timeoutMs: number;
    warnings: string[];
  } & GatewayRunShutdownParams,
): Promise<void> {
  // Ordinary CLI stop already spent its grace period. Cancel only this Gateway's
  // remaining owners before joining them, without scheduling restart recovery.
  if (!params.restart) {
    abortQueuedTurns(params, false);
    abortActiveRuns(params, false);
    return;
  }
  const initialCounts = getRestartReplyDrainCounts(params);
  let drainResult: Awaited<ReturnType<typeof waitForRestartReplyDrain>> | undefined;
  if (
    initialCounts.pendingReplies > 0 ||
    initialCounts.activeRuns > 0 ||
    initialCounts.queuedTurns > 0
  ) {
    const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
    if (timeoutMs > 0) {
      shutdownLog.info(
        `waiting for ${formatRestartReplyDrainDetails(initialCounts)} before restart shutdown (timeout ${timeoutMs}ms)`,
      );
    }
    drainResult = await waitForRestartReplyDrain({
      getPendingReplyCount: params.getPendingReplyCount,
      chatAbortControllers: params.chatAbortControllers,
      chatQueuedTurns: params.chatQueuedTurns,
      timeoutMs,
    });
    if (!drainResult.drained) {
      shutdownLog.warn(
        `restart reply drain timed out after ${drainResult.elapsedMs}ms with ${formatRestartReplyDrainDetails(drainResult.counts)} still active; continuing shutdown`,
      );
      recordGatewayShutdownWarning(params.warnings, "restart-reply-drain");
    }
  }

  const abortedQueuedTurns = abortQueuedTurns(params, true);
  if (drainResult?.drained === false && abortedQueuedTurns > 0) {
    shutdownLog.warn(`aborted ${abortedQueuedTurns} queued turn(s) during restart shutdown`);
  }
  const abortedReplies = await markActiveRunsForRestartRecovery({
    ...params,
    reason: "gateway restart shutdown",
  });
  const abortedRuns = abortActiveRuns(params, true) + abortedReplies;
  if (drainResult?.drained) {
    shutdownLog.info(`restart reply drain completed after ${drainResult.elapsedMs}ms`);
  } else if (drainResult && abortedRuns > 0) {
    shutdownLog.warn(`aborted ${abortedRuns} active run(s) during restart shutdown`);
  }
}
