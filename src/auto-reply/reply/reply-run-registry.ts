// Tracks active reply runs so stop, queue, and status commands can coordinate.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { createAbortError } from "../../infra/abort-signal.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../get-reply-options.types.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "./reply-dispatcher.types.js";

export type ReplyRunKey = string;

export type ReplyBackendKind = "embedded" | "cli";

export type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";

export type ReplyBackendQueueMessageOptions = {
  steeringMode?: "all";
  debounceMs?: number;
  deliveryTimeoutMs?: number;
  waitForTranscriptCommit?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  /** Prepared channel turn to merge only at transcript persistence. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
};

export type ReplyBackendHandle = {
  readonly kind: ReplyBackendKind;
  readonly sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  readonly taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  cancel(reason?: ReplyBackendCancelReason): void;
  isStreaming(): boolean;
  isStopped?: () => boolean;
  isAbortable?: () => boolean;
  queueMessage?: (text: string, options?: ReplyBackendQueueMessageOptions) => Promise<void>;
  /**
   * Compatibility-only hook so legacy "abort compacting runs" paths can still
   * find embedded runs that are compacting during the main run phase.
   */
  isCompacting?: () => boolean;
};

export type ReplyBackendQueueMessageMismatch =
  | "source_reply_delivery_mode_mismatch"
  | "task_suggestion_delivery_mode_mismatch";

/** Prevents steering a turn into a run whose model-facing tool surface differs. */
export function resolveReplyBackendQueueMessageMismatch(
  backend: Pick<ReplyBackendHandle, "sourceReplyDeliveryMode" | "taskSuggestionDeliveryMode">,
  options?: ReplyBackendQueueMessageOptions,
): ReplyBackendQueueMessageMismatch | undefined {
  if (
    options?.sourceReplyDeliveryMode === "message_tool_only" &&
    backend.sourceReplyDeliveryMode !== "message_tool_only"
  ) {
    return "source_reply_delivery_mode_mismatch";
  }
  // User turns carry this own property even when disabled; internal wakeups
  // omit it so they inherit the active run's already-negotiated tool surface.
  if (
    options !== undefined &&
    Object.hasOwn(options, "taskSuggestionDeliveryMode") &&
    options?.taskSuggestionDeliveryMode !== backend.taskSuggestionDeliveryMode
  ) {
    return "task_suggestion_delivery_mode_mismatch";
  }
  return undefined;
}

export type ReplyOperationPhase =
  | "queued"
  | "waiting_for_deferred_maintenance"
  | "preflight_compacting"
  | "memory_flushing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type ReplyOperationFailureCode =
  | "gateway_draining"
  | "command_lane_cleared"
  | "aborted_by_user"
  | "session_corruption_reset"
  | "run_stalled"
  | "run_failed";

export type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";

export type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: ReplyOperationAbortCode };

export type ReplyOperation = {
  readonly key: ReplyRunKey;
  readonly sessionId: string;
  readonly routeThreadId?: string | number;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  /**
   * True when this operation was admitted to recover a terminal session (a
   * leftover failed/timeout/killed run). Concurrent visible turns reading the
   * same terminal store snapshot must NOT force-clear such an operation: it is a
   * sibling recovery already in flight, not the proven stale leftover.
   */
  readonly terminalRecovery: boolean;
  /**
   * Sticky fact for audio accepted into this operation after its originating turn.
   * Final delivery reads it because the original dispatch context cannot change.
   */
  readonly acceptedSteeredInboundAudio: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number;
  /** True when this operation has owned the supplied session ID. */
  hasOwnedSessionId(sessionId: string): boolean;
  recordActivity(): void;
  setPhase(
    next:
      | "queued"
      | "waiting_for_deferred_maintenance"
      | "preflight_compacting"
      | "memory_flushing"
      | "running",
  ): void;
  /** Mark this operation as waiting on prior same-session maintenance. */
  markWaitingForDeferredMaintenance(): void;
  /** Return a maintenance-waiting operation to queued if the run has not started. */
  markDeferredMaintenanceWaitEnded(): void;
  /** Mark this operation as an in-flight terminal-session recovery. */
  markTerminalRecovery(): void;
  markAcceptedSteeredInboundAudio(): void;
  updateSessionId(nextSessionId: string): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  /** Reject later aborts after the backend has committed its terminal outcome. */
  freezeAbort(): void;
  /**
   * Keep a failed operation active until complete() releases the session lane.
   * Dispatch uses this while a user-visible failure payload still needs delivery.
   */
  retainFailureUntilComplete(): void;
  complete(): void;
  /**
   * Complete the operation, clear active-run state, then run follow-up work.
   * Use when the follow-up can create another ReplyOperation for this session.
   */
  completeThen(afterClear: () => void): void;
  /**
   * Clear active-run state immediately, but delay registered after-clear work
   * until delivery or another external barrier settles.
   */
  completeWithAfterClearBarrier(
    barrier: PromiseLike<unknown>,
    timeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): boolean;
  abortForRestart(): boolean;
};

export type ReplyRunRegistry = {
  begin(params: {
    sessionKey: string;
    sessionId: string;
    resetTriggered: boolean;
    routeThreadId?: string | number;
    upstreamAbortSignal?: AbortSignal;
  }): ReplyOperation;
  get(sessionKey: string): ReplyOperation | undefined;
  isActive(sessionKey: string): boolean;
  isStreaming(sessionKey: string): boolean;
  abort(sessionKey: string): boolean;
  waitForIdle(
    sessionKey: string,
    timeoutMs?: number,
    opts?: { signal?: AbortSignal },
  ): Promise<boolean>;
  resolveSessionId(sessionKey: string): string | undefined;
};

type ReplyRunWaiter = {
  finish: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

type ReplyRunFollowupAdmissionBarrier = {
  settled: Promise<void>;
  sessionId: string;
};

type ReplyRunState = {
  activeRunsByKey: Map<string, ReplyOperation>;
  activeSessionIdsByKey: Map<string, string>;
  activeKeysBySessionId: Map<string, string>;
  waitKeysBySessionId: Map<string, string>;
  waitersByKey: Map<string, Set<ReplyRunWaiter>>;
  followupAdmissionBarriersByKey: Map<string, ReplyRunFollowupAdmissionBarrier>;
};

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

const replyRunState = resolveGlobalSingleton<ReplyRunState>(REPLY_RUN_STATE_KEY, () => ({
  activeRunsByKey: new Map<string, ReplyOperation>(),
  activeSessionIdsByKey: new Map<string, string>(),
  activeKeysBySessionId: new Map<string, string>(),
  waitKeysBySessionId: new Map<string, string>(),
  waitersByKey: new Map<string, Set<ReplyRunWaiter>>(),
  followupAdmissionBarriersByKey: new Map<string, ReplyRunFollowupAdmissionBarrier>(),
}));
replyRunState.followupAdmissionBarriersByKey ??= new Map();

export const REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS = 15_000;
// Terminal results must release the lane even if the owner never resumes.
// Without this, abort/failure can leave the session wedged until process restart.
export const REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS = 60_000;

export type ReplyOperationStaleReason = "terminal_unreleased" | "no_activity" | "stuck_recovery";

export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
  }
}

export class ReplyRunFollowupAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply follow-up admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunFollowupAdmissionBlockedError";
  }
}

function createUserAbortError(): Error {
  return createAbortError("Reply operation aborted by user");
}

function registerWaitSessionId(sessionKey: string, sessionId: string): void {
  replyRunState.waitKeysBySessionId.set(sessionId, sessionKey);
}

function clearWaitSessionIds(sessionKey: string): void {
  for (const [sessionId, mappedKey] of replyRunState.waitKeysBySessionId) {
    if (mappedKey === sessionKey) {
      replyRunState.waitKeysBySessionId.delete(sessionId);
    }
  }
}

function notifyReplyRunEnded(sessionKey: string): void {
  const waiters = replyRunState.waitersByKey.get(sessionKey);
  if (!waiters || waiters.size === 0) {
    return;
  }
  replyRunState.waitersByKey.delete(sessionKey);
  for (const waiter of waiters) {
    waiter.finish(true);
  }
}

function resolveReplyRunForCurrentSessionId(sessionId: string): ReplyOperation | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  const sessionKey = replyRunState.activeKeysBySessionId.get(normalizedSessionId);
  if (!sessionKey) {
    return undefined;
  }
  return replyRunState.activeRunsByKey.get(sessionKey);
}

function resolveReplyRunWaitKey(sessionId: string): string | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  return (
    replyRunState.activeKeysBySessionId.get(normalizedSessionId) ??
    replyRunState.waitKeysBySessionId.get(normalizedSessionId)
  );
}

function isReplyRunCompacting(operation: ReplyOperation): boolean {
  if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") {
    return true;
  }
  if (operation.phase !== "running") {
    return false;
  }
  const backend = getAttachedBackend(operation);
  return backend?.isCompacting?.() ?? false;
}

function isReplyOperationPreBackendPhase(phase: ReplyOperationPhase): boolean {
  return phase === "queued" || phase === "waiting_for_deferred_maintenance";
}

const attachedBackendByOperation = new WeakMap<ReplyOperation, ReplyBackendHandle>();
const abortFrozenOperations = new WeakSet<ReplyOperation>();
const operationsByUpstreamAbortSignal = new WeakMap<AbortSignal, ReplyOperation>();
const retainStateUntilCompleteOperations = new WeakSet<ReplyOperation>();
const afterClearCallbacksByOperation = new WeakMap<
  ReplyOperation,
  Set<(sessionId: string) => void>
>();
const terminalSettleTimersByOperation = new WeakMap<ReplyOperation, NodeJS.Timeout>();
const terminalSettleTimers = new Set<NodeJS.Timeout>();
const expireReplyOperationByOperation = new WeakMap<
  ReplyOperation,
  (reason: ReplyOperationStaleReason) => boolean
>();

function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  return attachedBackendByOperation.get(operation);
}

function isReplyOperationAbortable(operation: ReplyOperation): boolean {
  if (operation.result || abortFrozenOperations.has(operation)) {
    return false;
  }
  const backend = getAttachedBackend(operation);
  if (!backend?.isAbortable) {
    return true;
  }
  try {
    return backend.isAbortable();
  } catch {
    return false;
  }
}

export function isReplyRunAbortableForSignal(signal: AbortSignal): boolean {
  const operation = operationsByUpstreamAbortSignal.get(signal);
  return operation ? isReplyOperationAbortable(operation) : true;
}

/** Keep terminal state registered until the operation owner exits via complete(). */
export function retainReplyOperationUntilComplete(operation: ReplyOperation): void {
  retainStateUntilCompleteOperations.add(operation);
}

function isReplyBackendMessageInjectable(backend: ReplyBackendHandle): boolean {
  try {
    return backend.isStopped === undefined ? backend.isStreaming() : !backend.isStopped();
  } catch {
    return false;
  }
}

/** Run work after an operation no longer owns its session lane. */
export function runAfterReplyOperationClear(
  operation: ReplyOperation,
  afterClear: (sessionId: string) => void,
): void {
  if (replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    afterClear(operation.sessionId);
    return;
  }
  const callbacks =
    afterClearCallbacksByOperation.get(operation) ?? new Set<(sessionId: string) => void>();
  callbacks.add(afterClear);
  afterClearCallbacksByOperation.set(operation, callbacks);
}

function flushReplyOperationAfterClear(operation: ReplyOperation, sessionId: string): void {
  const callbacks = afterClearCallbacksByOperation.get(operation);
  if (!callbacks) {
    return;
  }
  afterClearCallbacksByOperation.delete(operation);
  for (const callback of callbacks) {
    callback(sessionId);
  }
}

function formatReplyOperationResult(result: ReplyOperationResult | null): string {
  if (!result) {
    return "none";
  }
  return result.kind === "completed" ? result.kind : `${result.kind}:${result.code}`;
}

function clearTerminalSettleTimer(operation: ReplyOperation): void {
  const timer = terminalSettleTimersByOperation.get(operation);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  terminalSettleTimers.delete(timer);
  terminalSettleTimersByOperation.delete(operation);
}

export function waitForReplyBarrierSettlement(
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): Promise<void> {
  // Owners may extend this for bounded retry envelopes; all barriers retain a failsafe.
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const schedule = (delayMs: number, callback: () => void) => {
      timer = setTimeout(callback, delayMs);
      timer.unref?.();
    };
    if (typeof timeout === "number") {
      schedule(resolveTimerTimeoutMs(timeout, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS), finish);
    } else {
      const startedAt = Date.now();
      const maxTimeoutMs = resolveTimerTimeoutMs(
        timeout.maxTimeoutMs,
        REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
      );
      const checkOwnerActivity = () => {
        const remainingMs = maxTimeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          finish();
          return;
        }
        let shouldExtend: boolean;
        try {
          shouldExtend = timeout.shouldExtend();
        } catch {
          finish();
          return;
        }
        if (!shouldExtend) {
          finish();
          return;
        }
        schedule(Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, remainingMs), checkOwnerActivity);
      };
      schedule(Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, maxTimeoutMs), checkOwnerActivity);
    }
    void Promise.resolve(barrier).then(finish, finish);
  });
}

function registerFollowupAdmissionBarrier(
  sessionKey: string,
  sessionId: string,
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): ReplyRunFollowupAdmissionBarrier {
  const barriersByKey = replyRunState.followupAdmissionBarriersByKey;
  const previous = barriersByKey.get(sessionKey)?.settled;
  const current = waitForReplyBarrierSettlement(barrier, timeout);
  const settled = previous ? Promise.all([previous, current]).then(() => undefined) : current;
  const entry = { settled, sessionId };
  barriersByKey.set(sessionKey, entry);
  void settled.then(() => {
    if (barriersByKey.get(sessionKey) === entry) {
      barriersByKey.delete(sessionKey);
    }
  });
  return entry;
}

function updateFollowupAdmissionSessionId(sessionKey: string, sessionId: string): void {
  const barrier = replyRunState.followupAdmissionBarriersByKey.get(sessionKey);
  if (barrier) {
    barrier.sessionId = sessionId;
  }
}

function clearReplyRunState(params: { sessionKey: string; sessionId: string }): void {
  replyRunState.activeRunsByKey.delete(params.sessionKey);
  replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
  if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) {
    replyRunState.activeKeysBySessionId.delete(params.sessionId);
  }
  clearWaitSessionIds(params.sessionKey);
  notifyReplyRunEnded(params.sessionKey);
}

function markReplyRunDiagnosticProgress(params: {
  sessionKey: string;
  sessionId: string;
  reason: string;
}): void {
  markDiagnosticRunProgress({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    reason: params.reason,
  });
}

export function createReplyOperation(params: {
  sessionKey: string;
  sessionId: string;
  resetTriggered: boolean;
  routeThreadId?: string | number;
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

  const controller = new AbortController();
  let currentSessionId = sessionId;
  let phase: ReplyOperationPhase = "queued";
  let result: ReplyOperationResult | null = null;
  let stateCleared = false;
  let retainFailureUntilComplete = false;
  let terminalRecovery = false;
  let acceptedSteeredInboundAudio = false;
  const startedAtMs = Date.now();
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
    clearTerminalSettleTimer(operation);
    expireReplyOperationByOperation.delete(operation);
    detachUpstreamAbort();
    const registeredBarrier = afterClearBarrier
      ? registerFollowupAdmissionBarrier(
          sessionKey,
          currentSessionId,
          afterClearBarrier,
          followupAdmissionBarrierTimeout,
        )
      : undefined;
    updateFollowupAdmissionSessionId(sessionKey, currentSessionId);
    markReplyRunDiagnosticProgress({
      sessionKey,
      sessionId: currentSessionId,
      reason: "reply_operation:ended",
    });
    clearReplyRunState({
      sessionKey,
      sessionId: currentSessionId,
    });
    if (!registeredBarrier) {
      flushReplyOperationAfterClear(operation, currentSessionId);
      return;
    }
    void registeredBarrier.settled.then(() =>
      flushReplyOperationAfterClear(operation, registeredBarrier.sessionId),
    );
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const scheduleTerminalSettle = () => {
    if (stateCleared || terminalSettleTimersByOperation.has(operation)) {
      return;
    }
    // Retained terminal results get one delivery grace window, not a second
    // lifetime. Expiry frees the lane and flushes lifecycle after-clear work —
    // including skipping any delivery barrier the owner never got to register;
    // followups may then interleave with a still-draining terminal delivery.
    const timer = setTimeout(() => {
      if (replyRunState.activeRunsByKey.get(sessionKey) !== operation) {
        clearTerminalSettleTimer(operation);
        return;
      }
      diag.warn(
        `reply run terminal settle: forced release sessionKey=${sessionKey} phase=${phase} result=${formatReplyOperationResult(
          result,
        )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
      );
      clearState();
    }, REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
    timer.unref?.();
    terminalSettleTimersByOperation.set(operation, timer);
    terminalSettleTimers.add(timer);
  };

  const abortWithReason = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    opts?: { abortedCode?: ReplyOperationAbortCode },
  ) => {
    if (opts?.abortedCode && !result) {
      setResult({ kind: "aborted", code: opts.abortedCode });
      detachUpstreamAbort();
    }
    phase = "aborted";
    abortInternally(abortReason);
    getAttachedBackend(operation)?.cancel(reason);
  };

  const operation: ReplyOperation = {
    get key() {
      return sessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    get routeThreadId() {
      return params.routeThreadId;
    },
    get abortSignal() {
      return controller.signal;
    },
    get resetTriggered() {
      return params.resetTriggered;
    },
    get terminalRecovery() {
      return terminalRecovery;
    },
    get acceptedSteeredInboundAudio() {
      return acceptedSteeredInboundAudio;
    },
    get phase() {
      return phase;
    },
    get result() {
      return result;
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
      recordActivity();
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
        sessionKey,
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
        sessionKey,
        sessionId: currentSessionId,
        reason: "deferred_maintenance:wait_ended",
      });
    },
    markTerminalRecovery() {
      terminalRecovery = true;
    },
    markAcceptedSteeredInboundAudio() {
      acceptedSteeredInboundAudio = true;
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
        replyRunState.activeKeysBySessionId.get(normalizedNextSessionId) !== sessionKey
      ) {
        throw new Error(
          `Cannot rebind reply operation ${sessionKey} to active session ${normalizedNextSessionId}`,
        );
      }
      replyRunState.activeKeysBySessionId.delete(currentSessionId);
      registerWaitSessionId(sessionKey, currentSessionId);
      currentSessionId = normalizedNextSessionId;
      ownedSessionIds.add(currentSessionId);
      updateFollowupAdmissionSessionId(sessionKey, currentSessionId);
      replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
      replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
      registerWaitSessionId(sessionKey, currentSessionId);
      markReplyRunDiagnosticProgress({
        sessionKey,
        sessionId: currentSessionId,
        reason: "reply_operation:session_updated",
      });
    },
    attachBackend(handle) {
      if (result) {
        handle.cancel(
          result.kind === "aborted"
            ? result.code === "aborted_for_restart"
              ? "restart"
              : "user_abort"
            : "superseded",
        );
        return;
      }
      recordActivity();
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
    },
    retainFailureUntilComplete() {
      retainFailureUntilComplete = true;
    },
    complete() {
      if (!result) {
        setResult({ kind: "completed" });
        phase = "completed";
      }
      clearState();
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
      clearState(barrier, timeoutMs);
    },
    fail(code, cause) {
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
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
      const phaseBeforeAbort = phase;
      abortWithReason("user_abort", createUserAbortError(), {
        abortedCode: "aborted_by_user",
      });
      if (
        isReplyOperationPreBackendPhase(phaseBeforeAbort) &&
        !retainStateUntilCompleteOperations.has(operation)
      ) {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
      return true;
    },
    abortForRestart() {
      if (!isReplyOperationAbortable(operation)) {
        return false;
      }
      const phaseBeforeAbort = phase;
      abortWithReason("restart", createAgentRunRestartAbortError(), {
        abortedCode: "aborted_for_restart",
      });
      if (
        isReplyOperationPreBackendPhase(phaseBeforeAbort) &&
        !retainStateUntilCompleteOperations.has(operation)
      ) {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
      return true;
    },
  };

  expireReplyOperationByOperation.set(operation, (reason) => {
    if (replyRunState.activeRunsByKey.get(sessionKey) !== operation) {
      return false;
    }
    // Set the terminal result BEFORE cancelling the backend: cancel can
    // synchronously re-enter abortByUser() from the run loop's abort handler,
    // which would stamp aborted_by_user and misattribute a watchdog expiry.
    if (!result) {
      abortFrozenOperations.add(operation);
      detachUpstreamAbort();
      setResult({ kind: "failed", code: "run_stalled" });
      phase = "failed";
    }
    getAttachedBackend(operation)?.cancel("superseded");
    abortInternally(createAbortError("Reply operation expired as stale"));
    diag.warn(
      `reply run stale takeover: forced release sessionKey=${sessionKey} reason=${reason} phase=${phase} result=${formatReplyOperationResult(
        result,
      )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
    );
    clearState();
    return true;
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
      const phaseBeforeAbort = phase;
      abortWithReason(restart ? "restart" : "user_abort", upstreamAbortSignal.reason, {
        abortedCode: restart ? "aborted_for_restart" : "aborted_by_user",
      });
      if (
        isReplyOperationPreBackendPhase(phaseBeforeAbort) &&
        !retainStateUntilCompleteOperations.has(operation)
      ) {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
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

export function expireStaleReplyOperation(
  operation: ReplyOperation,
  reason: ReplyOperationStaleReason,
): boolean {
  return expireReplyOperationByOperation.get(operation)?.(reason) ?? false;
}

export function expireStaleReplyRunBySessionId(
  sessionId: string,
  reason: ReplyOperationStaleReason,
): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? expireStaleReplyOperation(operation, reason) : false;
}

// lastActivityAtMs is refreshed by agent events only; timers and user-message
// injection never refresh it, so quiet runs age toward reclaim.
export function isReplyRunEvidenceStale(operation: ReplyOperation): boolean {
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: operation.sessionId,
    sessionKey: operation.key,
  });
  return (
    !operation.result &&
    Date.now() - operation.lastActivityAtMs > resolveRunStaleThresholdMs(activity)
  );
}

export function isReplyRunEvidenceStaleBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? isReplyRunEvidenceStale(operation) : false;
}

export const replyRunRegistry: ReplyRunRegistry = {
  begin(params) {
    return createReplyOperation(params);
  },
  get(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeRunsByKey.get(normalizedSessionKey);
  },
  isActive(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return false;
    }
    return replyRunState.activeRunsByKey.has(normalizedSessionKey);
  },
  isStreaming(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation || operation.phase !== "running") {
      return false;
    }
    return getAttachedBackend(operation)?.isStreaming() ?? false;
  },
  abort(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation) {
      return false;
    }
    return operation.abortByUser();
  },
  waitForIdle(sessionKey, timeoutMs, opts) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
      return Promise.resolve(true);
    }
    if (opts?.signal?.aborted) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiters = replyRunState.waitersByKey.get(normalizedSessionKey) ?? new Set();
      let abortHandler: (() => void) | undefined;
      let settled = false;
      const waiter: ReplyRunWaiter = {
        finish: (ended) => {
          if (settled) {
            return;
          }
          settled = true;
          waiters.delete(waiter);
          if (waiters.size === 0) {
            replyRunState.waitersByKey.delete(normalizedSessionKey);
          }
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          if (abortHandler) {
            opts?.signal?.removeEventListener("abort", abortHandler);
          }
          resolve(ended);
        },
      };
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(
          () => waiter.finish(false),
          resolveTimerTimeoutMs(timeoutMs, 100, 100),
        );
      }
      if (opts?.signal) {
        abortHandler = () => waiter.finish(false);
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
      waiters.add(waiter);
      replyRunState.waitersByKey.set(normalizedSessionKey, waiters);
      if (!replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
        waiter.finish(true);
      }
    });
  },
  resolveSessionId(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeSessionIdsByKey.get(normalizedSessionKey);
  },
};

export function resolveActiveReplyRunSessionId(sessionKey: string): string | undefined {
  return replyRunRegistry.resolveSessionId(sessionKey);
}

export function resolveActiveReplyRunThreadId(sessionKey: string): string | number | undefined {
  return replyRunRegistry.get(sessionKey)?.routeThreadId;
}

export function isReplyRunActiveForSessionId(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}

export function resolveReplyRunPhaseForSessionId(
  sessionId: string,
): ReplyOperationPhase | undefined {
  return resolveReplyRunForCurrentSessionId(sessionId)?.phase;
}

export function isReplyRunAbortableForCompaction(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  // Manual compaction uses this as a coordination gate: a finalizing run still
  // needs to drain even when its frozen outcome rejects the abort itself.
  return Boolean(operation && !isReplyOperationPreBackendPhase(operation.phase));
}

export function isReplyRunStreamingForSessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || operation.phase !== "running") {
    return false;
  }
  return getAttachedBackend(operation)?.isStreaming() ?? false;
}

export function queueReplyRunMessage(
  sessionId: string,
  text: string,
  options?: ReplyBackendQueueMessageOptions,
): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const backend = operation ? getAttachedBackend(operation) : undefined;
  if (!operation || operation.phase !== "running" || !backend?.queueMessage) {
    return false;
  }
  // Steering into an evidence-dead run swallows the human message that would
  // otherwise trigger stale takeover through normal reply admission.
  if (isReplyRunEvidenceStale(operation)) {
    return false;
  }
  if (!isReplyBackendMessageInjectable(backend)) {
    return false;
  }
  if (resolveReplyBackendQueueMessageMismatch(backend, options)) {
    return false;
  }
  // Injection is user input, not run evidence: stamping activity here would let
  // sub-10-minute user messages re-arm a wedged run's staleness window forever.
  const queued = options ? backend.queueMessage(text, options) : backend.queueMessage(text);
  queued.catch((error: unknown) => {
    diag.debug(`queued reply run message rejected: sessionId=${sessionId} error=${String(error)}`);
  });
  return true;
}

export function abortReplyRunBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  return operation.abortByUser();
}

export function forceClearReplyRunBySessionId(sessionId: string, cause?: unknown): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  operation.fail("run_failed", cause);
  operation.complete();
  return true;
}

export function clearReplyRunForResetBySessionId(sessionId: string): void {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || isReplyOperationPreBackendPhase(operation.phase)) {
    return;
  }
  operation.abortForRestart();
  // Backend cancellation may synchronously retire this operation and admit a
  // replacement. Only clear the exact archived operation resolved above.
  if (replyRunState.activeRunsByKey.get(operation.key) === operation) {
    operation.complete();
  }
}

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  if (!waitKey) {
    return Promise.resolve(true);
  }
  return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}

export async function waitForReplyRunFollowupAdmission(
  sessionKey: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<{ settled: boolean; sessionId?: string }> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return { settled: true };
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 100, 100);
  const deadline = Date.now() + resolvedTimeoutMs;
  let sessionId: string | undefined;
  while (true) {
    if (opts?.signal?.aborted) {
      return { settled: false };
    }
    const barrier = replyRunState.followupAdmissionBarriersByKey.get(normalizedSessionKey);
    if (!barrier) {
      return { settled: true, sessionId };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { settled: false };
    }
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const outcome = await Promise.race([
      barrier.settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
        timer.unref?.();
      }),
      ...(opts?.signal
        ? [
            new Promise<boolean>((resolve) => {
              abortHandler = () => resolve(false);
              opts.signal?.addEventListener("abort", abortHandler, { once: true });
            }),
          ]
        : []),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler) {
      opts?.signal?.removeEventListener("abort", abortHandler);
    }
    if (!outcome) {
      return { settled: false };
    }
    sessionId = barrier.sessionId;
  }
}

export function abortActiveReplyRuns(opts: {
  mode: "all" | "compacting";
  onAbortError?: (sessionId: string, error: unknown) => void;
}): boolean {
  let aborted = false;
  for (const operation of replyRunState.activeRunsByKey.values()) {
    if (opts.mode === "compacting" && !isReplyRunCompacting(operation)) {
      continue;
    }
    try {
      if (operation.abortForRestart()) {
        aborted = true;
      }
    } catch (error) {
      if (operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart") {
        aborted = true;
      }
      opts.onAbortError?.(operation.sessionId, error);
    }
  }
  return aborted;
}

export function getActiveReplyRunCount(): number {
  return replyRunState.activeRunsByKey.size;
}

export function listActiveReplyRunSessionIds(): string[] {
  return [...replyRunState.activeSessionIdsByKey.values()];
}

export function listActiveReplyRunSessionKeys(): string[] {
  return [...replyRunState.activeSessionIdsByKey.keys()];
}

export const testing = {
  resetReplyRunRegistry(): void {
    for (const [sessionKey, sessionId] of replyRunState.activeSessionIdsByKey) {
      markReplyRunDiagnosticProgress({
        sessionKey,
        sessionId,
        reason: "reply_operation:registry_reset",
      });
    }
    replyRunState.activeRunsByKey.clear();
    replyRunState.activeSessionIdsByKey.clear();
    replyRunState.activeKeysBySessionId.clear();
    replyRunState.waitKeysBySessionId.clear();
    for (const timer of terminalSettleTimers) {
      clearTimeout(timer);
    }
    terminalSettleTimers.clear();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        waiter.finish(false);
      }
    }
    replyRunState.waitersByKey.clear();
    replyRunState.followupAdmissionBarriersByKey.clear();
  },
};
export { testing as __testing };
