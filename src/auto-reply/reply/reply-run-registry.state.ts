import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createAbortError } from "../../infra/abort-signal.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "./reply-dispatcher.types.js";
import type { ReplyOperationStaleReason } from "./reply-run-finalization-lease.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  type ReplyBackendHandle,
  type ReplyOperation,
  type ReplyOperationPhase,
} from "./reply-run-registry.contracts.js";

type ReplyRunWaiter = {
  finish: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

export type ReplyRunAdmissionBarrier = {
  settled: Promise<void>;
  sessionId: string;
};

type ReplyRunState = {
  activeRunsByKey: Map<string, ReplyOperation>;
  activeSessionIdsByKey: Map<string, string>;
  activeKeysBySessionId: Map<string, string>;
  waitKeysBySessionId: Map<string, string>;
  waitersByKey: Map<string, Set<ReplyRunWaiter>>;
  followupAdmissionBarriersByKey: Map<string, ReplyRunAdmissionBarrier>;
  successorAdmissionBarriersByKey: Map<string, ReplyRunAdmissionBarrier>;
  evictOperationByOperation?: WeakMap<ReplyOperation, () => void>;
};

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

export const replyRunState = resolveGlobalSingleton<ReplyRunState>(REPLY_RUN_STATE_KEY, () => ({
  activeRunsByKey: new Map<string, ReplyOperation>(),
  activeSessionIdsByKey: new Map<string, string>(),
  activeKeysBySessionId: new Map<string, string>(),
  waitKeysBySessionId: new Map<string, string>(),
  waitersByKey: new Map<string, Set<ReplyRunWaiter>>(),
  followupAdmissionBarriersByKey: new Map<string, ReplyRunAdmissionBarrier>(),
  successorAdmissionBarriersByKey: new Map<string, ReplyRunAdmissionBarrier>(),
  evictOperationByOperation: new WeakMap<ReplyOperation, () => void>(),
}));
replyRunState.followupAdmissionBarriersByKey ??= new Map();
replyRunState.successorAdmissionBarriersByKey ??= new Map();
export const evictReplyOperationByOperation =
  replyRunState.evictOperationByOperation ??
  (replyRunState.evictOperationByOperation = new WeakMap<ReplyOperation, () => void>());

export function createUserAbortError(): Error {
  return createAbortError("Reply operation aborted by user");
}

export function registerWaitSessionId(sessionKey: string, sessionId: string): void {
  replyRunState.waitKeysBySessionId.set(sessionId, sessionKey);
}

function clearWaitSessionIds(sessionKey: string): void {
  for (const [sessionId, mappedKey] of replyRunState.waitKeysBySessionId) {
    if (mappedKey === sessionKey) {
      replyRunState.waitKeysBySessionId.delete(sessionId);
    }
  }
}

export function notifyReplyRunEnded(sessionKey: string): void {
  const waiters = replyRunState.waitersByKey.get(sessionKey);
  if (!waiters || waiters.size === 0) {
    return;
  }
  replyRunState.waitersByKey.delete(sessionKey);
  for (const waiter of waiters) {
    waiter.finish(true);
  }
}

export function resolveReplyRunForCurrentSessionId(sessionId: string): ReplyOperation | undefined {
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

export function resolveReplyRunWaitKey(sessionId: string): string | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  return (
    replyRunState.activeKeysBySessionId.get(normalizedSessionId) ??
    replyRunState.waitKeysBySessionId.get(normalizedSessionId)
  );
}

export function isReplyRunCompacting(operation: ReplyOperation): boolean {
  if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") {
    return true;
  }
  if (operation.phase !== "running") {
    return false;
  }
  const backend = getAttachedBackend(operation);
  return backend?.isCompacting?.() ?? false;
}

export function isReplyOperationPreBackendPhase(phase: ReplyOperationPhase): boolean {
  return (
    phase === "queued" ||
    phase === "waiting_for_deferred_maintenance" ||
    phase === "waiting_for_global_lane"
  );
}

export const attachedBackendByOperation = new WeakMap<ReplyOperation, ReplyBackendHandle>();
export const abortFrozenOperations = new WeakSet<ReplyOperation>();
export const operationsByUpstreamAbortSignal = new WeakMap<AbortSignal, ReplyOperation>();
export const retainStateUntilCompleteOperations = new WeakSet<ReplyOperation>();
const afterClearCallbacksByOperation = new WeakMap<
  ReplyOperation,
  Set<(sessionId: string) => void>
>();
const successorBarrierStartsByOperation = new WeakMap<ReplyOperation, Set<() => void>>();
type ReplyOperationSuccessorBarrierGroup = {
  registrationKey: string;
  barriers: Set<ReplyRunAdmissionBarrier>;
};
// Alias-keyed fences registered for one lane rotate together. Rekeyed command
// operations retain prior-lane identities so source successors do not adopt
// the target session.
const successorBarrierGroupsByOperation = new WeakMap<
  ReplyOperation,
  Set<ReplyOperationSuccessorBarrierGroup>
>();
export type ReplyOperationStaleExpiryOptions = {
  afterClearBarrier?: PromiseLike<unknown>;
  followupAdmissionBarrierTimeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy;
};
export const expireReplyOperationByOperation = new WeakMap<
  ReplyOperation,
  (reason: ReplyOperationStaleReason, options?: ReplyOperationStaleExpiryOptions) => boolean
>();

export function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  return attachedBackendByOperation.get(operation);
}

export function isReplyOperationAbortable(operation: ReplyOperation): boolean {
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

/** Queue-first compatibility adapter for shipped Plugin SDK/embedded handles. */

export function runAfterReplyOperationClear(
  operation: ReplyOperation,
  afterClear: (sessionId: string) => void,
): void {
  if (replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    const barrier = replyRunState.followupAdmissionBarriersByKey.get(operation.key);
    if (barrier) {
      void barrier.settled.then(() => afterClear(barrier.sessionId));
      return;
    }
    afterClear(operation.sessionId);
    return;
  }
  const callbacks =
    afterClearCallbacksByOperation.get(operation) ?? new Set<(sessionId: string) => void>();
  callbacks.add(afterClear);
  afterClearCallbacksByOperation.set(operation, callbacks);
}

function registerSuccessorAdmissionBarrier(
  sessionKey: string,
  sessionId: string,
  barrier: Promise<void>,
): ReplyRunAdmissionBarrier {
  const barriersByKey = replyRunState.successorAdmissionBarriersByKey;
  const previous = barriersByKey.get(sessionKey)?.settled;
  const settled = previous ? Promise.all([previous, barrier]).then(() => undefined) : barrier;
  const entry = { settled, sessionId };
  barriersByKey.set(sessionKey, entry);
  void settled.then(() => {
    if (barriersByKey.get(sessionKey) === entry) {
      barriersByKey.delete(sessionKey);
    }
  });
  return entry;
}

/** Fence successor admission until owner handoff started at slot clear settles. */
export function registerReplyOperationSuccessorBarrier(params: {
  operation: ReplyOperation;
  sessionId: string;
  sessionKeys: readonly string[];
  start: () => PromiseLike<unknown>;
}): void {
  const settlement = createDeferredCore();
  const barriers = new Set<ReplyRunAdmissionBarrier>();
  for (const sessionKey of new Set(params.sessionKeys.map(normalizeOptionalString))) {
    if (sessionKey) {
      barriers.add(
        registerSuccessorAdmissionBarrier(sessionKey, params.sessionId, settlement.promise),
      );
    }
  }
  let started = false;
  const start = () => {
    if (started) {
      return;
    }
    started = true;
    try {
      void Promise.resolve(params.start()).then(
        () => settlement.resolve(undefined),
        () => {},
      );
    } catch {
      // A failed handoff leaves the fence closed. Visible callers stay
      // abortably blocked; bounded queued callers cannot observe a partial release.
    }
  };
  if (replyRunState.activeRunsByKey.get(params.operation.key) !== params.operation) {
    start();
    return;
  }
  const groups =
    successorBarrierGroupsByOperation.get(params.operation) ??
    new Set<ReplyOperationSuccessorBarrierGroup>();
  groups.add({ registrationKey: params.operation.key, barriers });
  successorBarrierGroupsByOperation.set(params.operation, groups);
  const starts = successorBarrierStartsByOperation.get(params.operation) ?? new Set<() => void>();
  starts.add(start);
  successorBarrierStartsByOperation.set(params.operation, starts);
}

export function startReplyOperationSuccessorBarriers(operation: ReplyOperation): void {
  const starts = successorBarrierStartsByOperation.get(operation);
  // These maps are operation-owned lifecycle metadata, not identity indexes.
  // Clear drops both before handoff starts so adoption cannot retain stale groups.
  successorBarrierStartsByOperation.delete(operation);
  successorBarrierGroupsByOperation.delete(operation);
  if (!starts) {
    return;
  }
  for (const start of starts) {
    start();
  }
}

export function updateSuccessorAdmissionSessionId(
  operation: ReplyOperation,
  sessionId: string,
): void {
  for (const group of successorBarrierGroupsByOperation.get(operation) ?? []) {
    if (group.registrationKey !== operation.key) {
      continue;
    }
    for (const barrier of group.barriers) {
      barrier.sessionId = sessionId;
    }
  }
}

export function isReplyRunSuccessorAdmissionBlocked(sessionKey: string): boolean {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return Boolean(
    normalizedSessionKey &&
    !replyRunState.activeRunsByKey.has(normalizedSessionKey) &&
    replyRunState.successorAdmissionBarriersByKey.has(normalizedSessionKey),
  );
}

export function flushReplyOperationAfterClear(operation: ReplyOperation, sessionId: string): void {
  const callbacks = afterClearCallbacksByOperation.get(operation);
  if (!callbacks) {
    return;
  }
  afterClearCallbacksByOperation.delete(operation);
  for (const callback of callbacks) {
    callback(sessionId);
  }
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

export function registerFollowupAdmissionBarrier(
  sessionKey: string,
  sessionId: string,
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): ReplyRunAdmissionBarrier {
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

export function updateFollowupAdmissionSessionId(sessionKey: string, sessionId: string): void {
  const barrier = replyRunState.followupAdmissionBarriersByKey.get(sessionKey);
  if (barrier) {
    barrier.sessionId = sessionId;
  }
}

export function clearReplyRunState(params: {
  sessionKey: string;
  sessionId: string;
  operation: ReplyOperation;
}): void {
  if (replyRunState.activeRunsByKey.get(params.sessionKey) !== params.operation) {
    if (
      replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey &&
      replyRunState.activeSessionIdsByKey.get(params.sessionKey) !== params.sessionId
    ) {
      replyRunState.activeKeysBySessionId.delete(params.sessionId);
    }
    return;
  }
  replyRunState.activeRunsByKey.delete(params.sessionKey);
  replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
  if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) {
    replyRunState.activeKeysBySessionId.delete(params.sessionId);
  }
  clearWaitSessionIds(params.sessionKey);
  notifyReplyRunEnded(params.sessionKey);
}

export function markReplyRunDiagnosticProgress(params: {
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

export function isReplyRunEvidenceStale(operation: ReplyOperation): boolean {
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: operation.sessionId,
    sessionKey: operation.key,
  });
  return (
    !operation.result &&
    operation.phase !== "waiting_for_global_lane" &&
    Date.now() - operation.lastActivityAtMs > resolveRunStaleThresholdMs(activity)
  );
}
