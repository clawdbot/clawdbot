import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError as createSupersededError,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../../agents/run-termination.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "./reply-dispatcher.types.js";
import * as replyRunSettle from "./reply-run-finalization-lease.js";
import {
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  ReplyRunAlreadyActiveError,
  ReplyRunFollowupAdmissionBlockedError,
  ReplyRunSuccessorAdmissionBlockedError,
  type ReplyOperation,
  type ReplyOperationPhase,
  type ReplyToolAuthoritySnapshot,
  type ReplyTurnKind,
} from "./reply-run-registry.contracts.js";
import {
  abortFrozenOperations,
  attachedBackendByOperation,
  clearReplyRunState,
  createUserAbortError,
  evictReplyOperationByOperation,
  expireReplyOperationByOperation,
  flushReplyOperationAfterClear,
  getAttachedBackend,
  hasCommittedReplyOperationOutcome,
  isReplyOperationAbortable,
  isReplyOperationPreBackendPhase,
  markReplyRunDiagnosticProgress,
  notifyReplyRunEnded,
  operationsByUpstreamAbortSignal,
  registerFollowupAdmissionBarrier,
  registerWaitSessionId,
  replyRunState,
  retainStateUntilCompleteOperations,
  type ReplyRunAdmissionBarrier,
  runAfterReplyOperationClear,
  startReplyOperationSuccessorBarriers,
  updateFollowupAdmissionSessionId,
  updateSuccessorAdmissionSessionId,
  waitForReplyBarrierSettlement,
} from "./reply-run-registry.state.js";

type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";
type ReplyOperationResult = NonNullable<ReplyOperation["result"]>;
type ReplyOperationAbortCode = Extract<ReplyOperationResult, { kind: "aborted" }>["code"];

export function createReplyOperation(params: {
  sessionKey: string;
  sessionId: string;
  turnKind?: ReplyTurnKind;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  originatingLeafEntryId?: string | null;
  upstreamAbortSignal?: AbortSignal;
  respectFollowupAdmissionBarrier?: boolean;
}): ReplyOperation {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  if (
    params.respectFollowupAdmissionBarrier &&
    replyRunState.followupAdmissionBarriersByKey.has(sessionKey)
  ) {
    throw new ReplyRunFollowupAdmissionBlockedError(sessionKey);
  }
  if (replyRunState.activeRunsByKey.has(sessionKey)) {
    throw new ReplyRunAlreadyActiveError(sessionKey);
  }
  if (replyRunState.successorAdmissionBarriersByKey.has(sessionKey)) {
    throw new ReplyRunSuccessorAdmissionBlockedError(sessionKey);
  }

  const controller = new AbortController();
  // Mutable so updateSessionKey can move the run slot (command-turn continuation
  // adoption); every closure below must read this, never params.sessionKey.
  let currentSessionKey = sessionKey;
  let currentSessionId = sessionId;
  let phase: ReplyOperationPhase = "queued";
  let phaseBeforeGlobalLaneWait: "queued" | "running" | undefined;
  let staleExpiryReason: replyRunSettle.ReplyOperationStaleReason | undefined;
  let result: ReplyOperationResult | null = null;
  let stateCleared = false;
  let clearBarrierSettlement: Promise<void> | undefined;
  let pendingClearBarrier: ReplyRunAdmissionBarrier | undefined;
  let retainFailureUntilComplete = false;
  let terminalRecovery = false;
  let acceptedSteeredInboundAudio = false;
  let toolAuthorityFingerprint: string | undefined;
  let toolAuthoritySnapshot: ReplyToolAuthoritySnapshot | undefined;
  let toolAuthorityRoute: { provider: string; model: string } | undefined;
  const ownerSettlement = createDeferredCore();
  const settleOwner = () => ownerSettlement.resolve(undefined);
  const startedAtMs = Date.now();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  let lastActivityAtMs = startedAtMs;
  const upstreamAbortSignal = params.upstreamAbortSignal;
  let upstreamAbortHandler: (() => void) | undefined;
  const detachUpstreamAbort = () => {
    if (!upstreamAbortHandler) {
      return;
    }
    upstreamAbortSignal?.removeEventListener("abort", upstreamAbortHandler);
    upstreamAbortHandler = undefined;
  };
  const ownedSessionIds = new Set([sessionId]);
  const recordActivity = () => {
    lastActivityAtMs = Date.now();
  };
  const setResult = (next: ReplyOperationResult) => {
    result = next;
    recordActivity();
  };

  const clearState = (
    afterClearBarrier?: PromiseLike<unknown>,
    followupAdmissionBarrierTimeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ) => {
    if (stateCleared) {
      return;
    }
    stateCleared = true;
    terminalSettleTimer.clear();
    finalizationLease.clear();
    expireReplyOperationByOperation.delete(operation);
    evictReplyOperationByOperation.delete(operation);
    detachUpstreamAbort();
    const registeredBarrier = afterClearBarrier
      ? registerFollowupAdmissionBarrier(
          currentSessionKey,
          currentSessionId,
          afterClearBarrier,
          followupAdmissionBarrierTimeout,
        )
      : pendingClearBarrier;
    pendingClearBarrier = undefined;
    updateFollowupAdmissionSessionId(currentSessionKey, currentSessionId);
    // Recovery-owner handoff must begin before the old slot wakes a successor;
    // otherwise that successor can snapshot durable state the handoff then mutates.
    startReplyOperationSuccessorBarriers(operation);
    markReplyRunDiagnosticProgress({
      sessionKey: currentSessionKey,
      sessionId: currentSessionId,
      reason: "reply_operation:ended",
    });
    clearReplyRunState({
      sessionKey: currentSessionKey,
      sessionId: currentSessionId,
      operation,
    });
    if (!registeredBarrier) {
      flushReplyOperationAfterClear(operation, currentSessionId);
      return;
    }
    void registeredBarrier.settled.then(() =>
      flushReplyOperationAfterClear(operation, registeredBarrier.sessionId),
    );
    clearBarrierSettlement = registeredBarrier.settled;
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const scheduleTerminalSettle = () => {
    if (stateCleared) {
      return;
    }
    terminalSettleTimer.scheduleOnce(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
  };

  const abortOperation = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    abortedCode: ReplyOperationAbortCode,
  ) => {
    const phaseBeforeAbort = phase;
    if (!result) {
      setResult({ kind: "aborted", code: abortedCode });
      detachUpstreamAbort();
    }
    phase = "aborted";
    abortInternally(abortReason);
    // Cancellation may throw, but lifecycle cleanup still must run. Pre-backend
    // non-retained owners release now; retained/running owners await terminal settle.
    try {
      getAttachedBackend(operation)?.cancel(reason);
    } finally {
      if (
        isReplyOperationPreBackendPhase(phaseBeforeAbort) &&
        !retainStateUntilCompleteOperations.has(operation)
      ) {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
    }
  };

  const operation: ReplyOperation = {
    get key() {
      return currentSessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    turnKind: params.turnKind ?? "visible",
    lifecycleGeneration,
    get routeThreadId() {
      return params.routeThreadId;
    },
    get originatingLeafEntryId() {
      return params.originatingLeafEntryId;
    },
    abortSignal: controller.signal,
    get resetTriggered() {
      return params.resetTriggered;
    },
    get terminalRecovery() {
      return terminalRecovery;
    },
    get acceptedSteeredInboundAudio() {
      return acceptedSteeredInboundAudio;
    },
    get toolAuthorityFingerprint() {
      return toolAuthorityFingerprint;
    },
    get toolAuthorityRoute() {
      return toolAuthorityRoute;
    },
    get phase() {
      return phase;
    },
    get result() {
      return result;
    },
    get staleExpiryReason() {
      return staleExpiryReason;
    },
    get startedAtMs() {
      return startedAtMs;
    },
    get lastActivityAtMs() {
      return lastActivityAtMs;
    },
    hasOwnedSessionId(candidateSessionId) {
      const normalizedSessionId = normalizeOptionalString(candidateSessionId);
      return normalizedSessionId ? ownedSessionIds.has(normalizedSessionId) : false;
    },
    recordActivity() {
      finalizationLease.recordActivity();
    },
    setPhase(next) {
      if (result) {
        return;
      }
      recordActivity();
      phase = next;
    },
    markWaitingForDeferredMaintenance() {
      if (result || phase !== "queued") {
        return;
      }
      phase = "waiting_for_deferred_maintenance";
      markReplyRunDiagnosticProgress({
        sessionKey: currentSessionKey,
        sessionId: currentSessionId,
        reason: "deferred_maintenance:waiting",
      });
    },
    markDeferredMaintenanceWaitEnded() {
      if (result || phase !== "waiting_for_deferred_maintenance") {
        return;
      }
      phase = "queued";
      markReplyRunDiagnosticProgress({
        sessionKey: currentSessionKey,
        sessionId: currentSessionId,
        reason: "deferred_maintenance:wait_ended",
      });
    },
    markWaitingForGlobalLane() {
      if (result || (phase !== "queued" && phase !== "running")) {
        return;
      }
      // Queued-on-lane is healthy waiting, not a wedged run. Removing this phase
      // lets stale recovery silently drop replies while global capacity is busy.
      phaseBeforeGlobalLaneWait = phase;
      phase = "waiting_for_global_lane";
      markReplyRunDiagnosticProgress({
        sessionKey: currentSessionKey,
        sessionId: currentSessionId,
        reason: "global_lane:waiting",
      });
    },
    markGlobalLaneWaitEnded() {
      if (result || phase !== "waiting_for_global_lane") {
        return;
      }
      phase = phaseBeforeGlobalLaneWait ?? "queued";
      phaseBeforeGlobalLaneWait = undefined;
      markReplyRunDiagnosticProgress({
        sessionKey: currentSessionKey,
        sessionId: currentSessionId,
        reason: "global_lane:wait_ended",
      });
    },
    markTerminalRecovery() {
      terminalRecovery = true;
    },
    markAcceptedSteeredInboundAudio() {
      acceptedSteeredInboundAudio = true;
    },
    bindToolAuthoritySnapshot(snapshot) {
      if (result || (toolAuthoritySnapshot && toolAuthoritySnapshot !== snapshot)) {
        throw new Error("Reply operation cannot change tool authority after admission");
      }
      if (toolAuthoritySnapshot) {
        return;
      }
      const fingerprint = normalizeOptionalString(snapshot.fingerprint());
      if (!fingerprint) {
        throw new Error("Reply operation tool authority fingerprint is required");
      }
      toolAuthoritySnapshot = snapshot;
      toolAuthorityFingerprint = fingerprint;
    },
    projectToolAuthorityFingerprint(overlay) {
      if (result || !toolAuthoritySnapshot || !toolAuthorityRoute) {
        return undefined;
      }
      try {
        return normalizeOptionalString(toolAuthoritySnapshot.project(overlay, toolAuthorityRoute));
      } catch {
        return undefined;
      }
    },
    bindToolAuthorityRoute(route) {
      if (
        result ||
        !toolAuthoritySnapshot ||
        replyRunState.activeRunsByKey.get(currentSessionKey) !== operation
      ) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      const provider = normalizeOptionalString(route.provider);
      const model = normalizeOptionalString(route.model);
      if (!provider || !model) {
        throw new Error("Reply operation tool authority route is required");
      }
      const preparedRoute = { provider, model };
      const fingerprint = toolAuthoritySnapshot.fingerprint(preparedRoute);
      toolAuthorityRoute = preparedRoute;
      toolAuthorityFingerprint = fingerprint;
      return fingerprint;
    },
    updateSessionId(nextSessionId) {
      if (result) {
        return;
      }
      const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
      if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
        return;
      }
      recordActivity();
      if (
        replyRunState.activeKeysBySessionId.has(normalizedNextSessionId) &&
        replyRunState.activeKeysBySessionId.get(normalizedNextSessionId) !== currentSessionKey
      ) {
        throw new Error(
          `Cannot rebind reply operation ${currentSessionKey} to active session ${normalizedNextSessionId}`,
        );
      }
      replyRunState.activeKeysBySessionId.delete(currentSessionId);
      registerWaitSessionId(currentSessionKey, currentSessionId);
      currentSessionId = normalizedNextSessionId;
      ownedSessionIds.add(currentSessionId);
      updateFollowupAdmissionSessionId(currentSessionKey, currentSessionId);
      updateSuccessorAdmissionSessionId(operation, currentSessionId);
      replyRunState.activeSessionIdsByKey.set(currentSessionKey, currentSessionId);
      replyRunState.activeKeysBySessionId.set(currentSessionId, currentSessionKey);
      registerWaitSessionId(currentSessionKey, currentSessionId);
      markReplyRunDiagnosticProgress({
        sessionKey: currentSessionKey,
        sessionId: currentSessionId,
        reason: "reply_operation:session_updated",
      });
    },
    updateSessionKey(nextSessionKey) {
      const normalizedNextKey = normalizeOptionalString(nextSessionKey);
      if (!normalizedNextKey) {
        throw new Error("Reply operations require a canonical sessionKey");
      }
      if (normalizedNextKey === currentSessionKey) {
        return;
      }
      // Only a queued reservation may move slots: once the run started (or the
      // operation settled), abort/steer/wait paths already resolved this key.
      if (result || stateCleared || phase !== "queued") {
        throw new Error(`Cannot rekey reply operation ${currentSessionKey} in phase ${phase}`);
      }
      if (replyRunState.activeRunsByKey.has(normalizedNextKey)) {
        throw new ReplyRunAlreadyActiveError(normalizedNextKey);
      }
      if (replyRunState.successorAdmissionBarriersByKey.has(normalizedNextKey)) {
        throw new ReplyRunSuccessorAdmissionBlockedError(normalizedNextKey);
      }
      recordActivity();
      const previousKey = currentSessionKey;
      replyRunState.activeRunsByKey.delete(previousKey);
      replyRunState.activeSessionIdsByKey.delete(previousKey);
      currentSessionKey = normalizedNextKey;
      replyRunState.activeRunsByKey.set(currentSessionKey, operation);
      replyRunState.activeSessionIdsByKey.set(currentSessionKey, currentSessionId);
      replyRunState.activeKeysBySessionId.set(currentSessionId, currentSessionKey);
      // Wait/abort lookups resolve keys via owned session IDs; move them so
      // waitForReplyRunEndBySessionId keeps finding this operation.
      for (const ownedSessionId of ownedSessionIds) {
        if (replyRunState.waitKeysBySessionId.get(ownedSessionId) === previousKey) {
          replyRunState.waitKeysBySessionId.set(ownedSessionId, currentSessionKey);
        }
      }
      // The previous key's slot is idle now; wake turns waiting on it.
      notifyReplyRunEnded(previousKey);
      markReplyRunDiagnosticProgress({
        sessionKey: currentSessionKey,
        sessionId: currentSessionId,
        reason: "reply_operation:session_key_adopted",
      });
    },
    attachBackend(handle) {
      if (result) {
        handle.cancel(
          result.kind === "aborted"
            ? result.code === "aborted_for_restart"
              ? "restart"
              : result.code === "aborted_for_supersession"
                ? "superseded"
                : "user_abort"
            : "superseded",
        );
        return;
      }
      recordActivity();
      const backendToolAuthorityFingerprint = normalizeOptionalString(
        handle.toolAuthorityFingerprint,
      );
      if (backendToolAuthorityFingerprint) {
        toolAuthorityFingerprint = backendToolAuthorityFingerprint;
      }
      attachedBackendByOperation.set(operation, handle);
      if (controller.signal.aborted) {
        handle.cancel("superseded");
      }
    },
    detachBackend(handle) {
      if (getAttachedBackend(operation) === handle) {
        attachedBackendByOperation.delete(operation);
      }
    },
    freezeAbort() {
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
      finalizationLease.begin();
    },
    retainFailureUntilComplete() {
      retainFailureUntilComplete = true;
    },
    ownerSettlement: ownerSettlement.promise,
    complete() {
      if (!result) {
        setResult({ kind: "completed" });
        phase = "completed";
      }
      clearState();
      settleOwner();
    },
    completeThen(afterClear) {
      runAfterReplyOperationClear(operation, afterClear);
      operation.complete();
    },
    completeWithAfterClearBarrier(barrier, timeoutMs) {
      if (!result) {
        setResult({ kind: "completed" });
        phase = "completed";
      }
      const wasAlreadyCleared = stateCleared;
      const ownerCompletionSettlement = pendingClearBarrier
        ? waitForReplyBarrierSettlement(barrier, timeoutMs)
        : undefined;
      clearState(barrier, timeoutMs);
      // This barrier owns dispatch delivery and terminal persistence. Stale
      // expiry may have already cleared the slot, but recovery must still wait
      // for that old owner's durable work before admitting a queued turn.
      const completionSettlement = wasAlreadyCleared
        ? waitForReplyBarrierSettlement(barrier, timeoutMs)
        : (ownerCompletionSettlement ?? clearBarrierSettlement);
      if (completionSettlement) {
        void completionSettlement.then(settleOwner);
      } else {
        settleOwner();
      }
    },
    fail(code, cause) {
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
      finalizationLease.clear();
      if (!result) {
        setResult({ kind: "failed", code, cause });
        phase = "failed";
      }
      if (!retainFailureUntilComplete && !retainStateUntilCompleteOperations.has(operation)) {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
    },
    abortByUser() {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      abortOperation("user_abort", createUserAbortError(), "aborted_by_user");
      return true;
    },
    abortForRestart() {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      abortOperation("restart", createAgentRunRestartAbortError(), "aborted_for_restart");
      return true;
    },
    supersede(beforeSupersede) {
      const abortFrozen = abortFrozenOperations.has(operation);
      if (result || stateCleared || (!abortFrozen && !isReplyOperationAbortable(operation))) {
        return false;
      }
      beforeSupersede?.();
      if (abortFrozen) {
        setResult({ kind: "aborted", code: "aborted_for_supersession" });
        phase = "aborted";
        scheduleTerminalSettle();
        return true;
      }
      abortOperation("superseded", createSupersededError(), "aborted_for_supersession");
      return true;
    },
  };

  expireReplyOperationByOperation.set(operation, (reason, options) => {
    if (
      replyRunState.activeRunsByKey.get(currentSessionKey) !== operation ||
      (reason !== "finalization_stalled" && hasCommittedReplyOperationOutcome(operation))
    ) {
      return false;
    }
    // Set the terminal result BEFORE cancelling the backend: cancel can
    // synchronously re-enter abortByUser() from the run loop's abort handler,
    // which would stamp aborted_by_user and misattribute a watchdog expiry.
    if (!result) {
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
      // The reason distinguishes pre-run drops (user got nothing; feedback owed)
      // from post-output stalls (finalization/terminal cleanup; feedback is noise).
      staleExpiryReason = reason;
      setResult({ kind: "failed", code: "run_stalled" });
      phase = "failed";
    }
    const logStaleTakeoverRelease = () => {
      diag.warn(
        `reply run stale takeover: forced release sessionKey=${currentSessionKey} reason=${reason} phase=${phase} result=${replyRunSettle.formatReplyOperationResult(
          result,
        )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
      );
    };
    if (options?.afterClearBarrier) {
      // Prepare the recovery fence before cancellation, but retain exact lane
      // ownership until cancel returns or the backend re-enters completion.
      pendingClearBarrier = registerFollowupAdmissionBarrier(
        currentSessionKey,
        currentSessionId,
        options.afterClearBarrier,
        options.followupAdmissionBarrierTimeout,
      );
    }
    const backend = getAttachedBackend(operation);
    let cancelFailed = false;
    try {
      backend?.cancel("superseded");
    } catch (error) {
      cancelFailed = true;
      diag.warn(
        `reply run stale takeover cancel failed: sessionKey=${currentSessionKey} reason=${reason} owner=${stateCleared ? "completed" : "retained"} error=${String(error)}`,
      );
    }
    abortInternally(createAbortError("Reply operation expired as stale"));
    if (stateCleared) {
      logStaleTakeoverRelease();
      return true;
    }
    // cancel() only requests shutdown. A missing backend can also be a live
    // pre-attachment owner, so only complete() may release the exact lane token.
    if (!cancelFailed) {
      diag.warn(
        `reply run stale takeover retained: sessionKey=${currentSessionKey} reason=${reason} owner=awaiting_terminal_completion backend=${backend ? "attached" : "pending"}`,
      );
    }
    scheduleTerminalSettle();
    return false;
  });
  const finalizationLease = replyRunSettle.createReplyRunFinalizationLease({
    owner: operation,
    canExpire: () =>
      !stateCleared &&
      !result &&
      replyRunState.activeRunsByKey.get(currentSessionKey) === operation,
    onActivity: recordActivity,
    onFinalizationProgress: () =>
      markReplyRunDiagnosticProgress({
        sessionKey: currentSessionKey,
        sessionId: currentSessionId,
        reason: "reply_operation:finalizing_progress",
      }),
    onExpire: () => {
      diag.warn(
        `reply run finalization settle: forced release sessionKey=${currentSessionKey} phase=${phase} result=${replyRunSettle.formatReplyOperationResult(
          result,
        )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
      );
      const expired = expireReplyOperationByOperation.get(operation)?.("finalization_stalled");
      if (expired === false && replyRunState.activeRunsByKey.get(currentSessionKey) === operation) {
        // This lease is the finalization owner's bounded shutdown deadline.
        // Do not grant a second terminal-settle lifetime after it expires.
        forceClearReplyOperation(operation);
      }
    },
  });
  const terminalSettleTimer = replyRunSettle.createReplyRunSettleTimer({
    canExpire: () => replyRunState.activeRunsByKey.get(currentSessionKey) === operation,
    onExpire: () => {
      // Retained terminal results get one delivery grace window, not a second lifetime.
      diag.warn(
        `reply run terminal settle: forced release sessionKey=${currentSessionKey} phase=${phase} result=${replyRunSettle.formatReplyOperationResult(
          result,
        )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
      );
      clearState();
    },
  });

  evictReplyOperationByOperation.set(operation, () => {
    if (stateCleared) {
      return;
    }
    if (!result) {
      setResult({ kind: "aborted", code: "aborted_for_restart" });
      phase = "aborted";
    }
    abortInternally(createAgentRunRestartAbortError());
    let cancelError: unknown;
    let cancelFailed = false;
    try {
      getAttachedBackend(operation)?.cancel("restart");
    } catch (error) {
      cancelFailed = true;
      cancelError = error;
      diag.warn(
        `reply run lifecycle eviction cancel failed: sessionKey=${currentSessionKey} error=${String(error)}`,
      );
    } finally {
      clearState();
    }
    if (cancelFailed) {
      throw cancelError;
    }
  });

  replyRunState.activeRunsByKey.set(sessionKey, operation);
  replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
  replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
  registerWaitSessionId(sessionKey, currentSessionId);
  markReplyRunDiagnosticProgress({
    sessionKey,
    sessionId: currentSessionId,
    reason: "reply_operation:queued",
  });
  if (upstreamAbortSignal) {
    operationsByUpstreamAbortSignal.set(upstreamAbortSignal, operation);
    const abortFromUpstream = () => {
      if (result) {
        return;
      }
      const restart = isAgentRunRestartAbortReason(upstreamAbortSignal.reason);
      const superseded = isAgentRunSupersededAbortReason(upstreamAbortSignal.reason);
      abortOperation(
        restart ? "restart" : superseded ? "superseded" : "user_abort",
        upstreamAbortSignal.reason,
        restart
          ? "aborted_for_restart"
          : superseded
            ? "aborted_for_supersession"
            : "aborted_by_user",
      );
    };
    if (upstreamAbortSignal.aborted) {
      abortFromUpstream();
    } else {
      upstreamAbortHandler = abortFromUpstream;
      upstreamAbortSignal.addEventListener("abort", upstreamAbortHandler, { once: true });
    }
  }

  return operation;
}

export function forceClearReplyOperation(operation: ReplyOperation, cause?: unknown): boolean {
  if (replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    return false;
  }
  operation.fail("run_failed", cause);
  operation.complete();
  return true;
}
