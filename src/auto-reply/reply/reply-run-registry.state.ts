import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "../../agents/embedded-agent-runner/run-state.js";
import { createAbortError } from "../../infra/abort-signal.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgress,
  resolveRunStaleThresholdMs,
} from "../../logging/diagnostic-run-activity.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "./reply-dispatcher.types.js";
import type { ReplyOperationStaleReason } from "./reply-run-finalization-lease.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  ReplyRunAlreadyActiveError,
  ReplyRunSuccessorAdmissionBlockedError,
  type ReplyBackendHandle,
  type ReplyOperation,
  type ReplyOperationPhase,
} from "./reply-run-registry.contracts.js";

type ReplyRunWaiter = {
  finish: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

export type ReplyRunAdmissionSource = {
  sessionId: string;
  sessionIds: Set<string>;
  operation: ReplyOperation;
  databaseIdentity?: OpenClawAgentDatabaseIdentity;
};

export type ReplyRunAdmissionBarrier = {
  settled: Promise<void>;
  source: ReplyRunAdmissionSource;
  sources: Map<OpenClawAgentDatabaseIdentity | undefined, ReplyRunAdmissionSource>;
};

type ReplyOperationAdmission = {
  lease?: SessionWorkAdmissionLease;
  readonly databaseIdentity?: OpenClawAgentDatabaseIdentity;
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
  clearOperationByOperation?: WeakMap<ReplyOperation, () => void>;
  executionStartedOperations?: WeakSet<ReplyOperation>;
  lifecycleAdmissionByOperation?: WeakMap<ReplyOperation, ReplyOperationAdmission>;
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
  executionStartedOperations: new WeakSet<ReplyOperation>(),
  lifecycleAdmissionByOperation: new WeakMap<ReplyOperation, ReplyOperationAdmission>(),
}));
// Admission and the active operation must remain visible across transformed SDK graphs.
export const lifecycleAdmissionByOperation = (replyRunState.lifecycleAdmissionByOperation ??=
  new WeakMap<ReplyOperation, ReplyOperationAdmission>());
replyRunState.followupAdmissionBarriersByKey ??= new Map();
replyRunState.successorAdmissionBarriersByKey ??= new Map();

export function resolveReplyOperationAgentId(sessionKey: string, agentId?: string) {
  const owner = normalizeOptionalString(agentId) ?? parseAgentSessionKey(sessionKey)?.agentId;
  return owner ? normalizeAgentId(owner) : undefined;
}

export function prepareReplyRunKeyUpdate(
  operation: ReplyOperation,
  nextSessionKey: string,
  agentId: string | undefined,
  stateCleared: boolean,
): { sessionKey: string; agentId?: string } | undefined {
  const nextKey = normalizeOptionalString(nextSessionKey);
  if (!nextKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  const nextAgentId = resolveReplyOperationAgentId(nextKey, agentId) ?? operation.agentId;
  if (nextKey === operation.key && nextAgentId === operation.agentId) {
    return undefined;
  }
  // Running and settled operations have already published their abort/steer/wait identity.
  if (operation.result || stateCleared || operation.phase !== "queued") {
    throw new Error(`Cannot rekey reply operation ${operation.key} in phase ${operation.phase}`);
  }
  const targetOwner = replyRunState.activeRunsByKey.get(nextKey);
  if (targetOwner && targetOwner !== operation) {
    throw new ReplyRunAlreadyActiveError(nextKey);
  }
  if (replyRunState.successorAdmissionBarriersByKey.has(nextKey)) {
    throw new ReplyRunSuccessorAdmissionBlockedError(nextKey);
  }
  return { sessionKey: nextKey, agentId: nextAgentId };
}

// Retain the owning closure across transformed SDK module graphs.
export const clearReplyOperationByOperation = (replyRunState.clearOperationByOperation ??=
  new WeakMap<ReplyOperation, () => void>());

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
const executionStartedOperations =
  replyRunState.executionStartedOperations ??
  (replyRunState.executionStartedOperations = new WeakSet<ReplyOperation>());
export function markReplyOperationExecutionStarted(operation: ReplyOperation): void {
  executionStartedOperations.add(operation);
}
export function hasReplyOperationExecutionStarted(operation: ReplyOperation): boolean {
  return executionStartedOperations.has(operation);
}
export const abortFrozenOperations = new WeakSet<ReplyOperation>();
export const operationsByUpstreamAbortSignal = new WeakMap<AbortSignal, ReplyOperation>();
export const retainStateUntilCompleteOperations = new WeakSet<ReplyOperation>();
type ReplyOperationAfterClear = {
  callbacks: Set<(sessionId: string) => void>;
  barrier?: ReplyRunAdmissionBarrier;
};
const afterClearByOperation = new WeakMap<ReplyOperation, ReplyOperationAfterClear>();
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

export function expireStaleReplyOperation(
  operation: ReplyOperation,
  reason: ReplyOperationStaleReason,
  options?: ReplyOperationStaleExpiryOptions,
): boolean {
  return expireReplyOperationByOperation.get(operation)?.(reason, options) ?? false;
}

export function forceClearReplyOperation(operation: ReplyOperation, cause?: unknown): boolean {
  if (replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    return false;
  }
  // Reclaim the bounded slot without claiming the delivery/persistence owner
  // finished. Only its completion call can settle ownerSettlement, possibly
  // with a barrier registered after this forced release.
  const clearState = clearReplyOperationByOperation.get(operation);
  if (!clearState) {
    return false;
  }
  operation.fail("run_failed", cause);
  clearState();
  return true;
}

// Committed output belongs to the bounded finalization owner. Stale recovery
// must not cancel delivery after the backend has already produced its answer.
export function hasCommittedReplyOperationOutcome(operation: ReplyOperation): boolean {
  return !operation.result && abortFrozenOperations.has(operation);
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

/** Resolve only the live operation admitted with this exact upstream signal. */
export function resolveActiveReplyRunOwnerForSignal(
  signal: AbortSignal,
): { sessionId: string; sessionKey: string; abort: () => boolean } | undefined {
  const operation = operationsByUpstreamAbortSignal.get(signal);
  if (!operation) {
    return undefined;
  }
  const { key: sessionKey, sessionId } = operation;
  const isCurrent = () =>
    !signal.aborted &&
    !operation.result &&
    operation.key === sessionKey &&
    operation.sessionId === sessionId &&
    replyRunState.activeRunsByKey.get(sessionKey) === operation;
  if (!isCurrent()) {
    return undefined;
  }
  return {
    sessionId,
    sessionKey,
    // A retained selector must never cancel the operation that replaced this owner.
    abort: () => isCurrent() && operation.abortByUser(),
  };
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
  const afterClearState = afterClearByOperation.get(operation);
  if (!afterClearState?.barrier && replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    const barrier = replyRunState.followupAdmissionBarriersByKey.get(operation.key);
    const source = barrier?.sources.get(
      lifecycleAdmissionByOperation.get(operation)?.databaseIdentity,
    );
    if (barrier && source) {
      void barrier.settled.then(() => afterClear(source.sessionId));
      return;
    }
    afterClear(operation.sessionId);
    return;
  }
  const state = afterClearState ?? { callbacks: new Set<(sessionId: string) => void>() };
  state.callbacks.add(afterClear);
  afterClearByOperation.set(operation, state);
}

export function isReplyOperationAbortedForRestart(operation: ReplyOperation): boolean {
  return operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart";
}

export function mergeReplyRunAdmissionSource<T extends ReplyRunAdmissionSource>(
  source: T,
  previous?: ReplyRunAdmissionSource,
): T {
  // Only a connected UUID lineage in the same physical store can carry old work.
  // Restart invalidation cannot disappear when the next owner replaces the source.
  // Keep valid pending source references stable for retained clear callbacks.
  if (
    previous &&
    !isReplyOperationAbortedForRestart(previous.operation) &&
    previous.databaseIdentity === source.databaseIdentity &&
    source.sessionIds.has(previous.sessionId)
  ) {
    for (const id of source.sessionIds) {
      previous.sessionIds.add(id);
    }
    return Object.assign(previous, source, { sessionIds: previous.sessionIds });
  }
  return source;
}

function resolveReplyRunAdmissionSource(
  operation: ReplyOperation,
  sessionId: string,
  previous?: ReplyRunAdmissionSource,
): ReplyRunAdmissionSource {
  return mergeReplyRunAdmissionSource(
    {
      sessionId,
      sessionIds: operation.captureOwnedSessionIds(),
      operation,
      databaseIdentity: lifecycleAdmissionByOperation.get(operation)?.databaseIdentity,
    },
    previous,
  );
}

function registerReplyRunAdmissionBarrier(
  barriersByKey: Map<string, ReplyRunAdmissionBarrier>,
  sessionKey: string,
  sessionId: string,
  barrier: Promise<void>,
  operation: ReplyOperation,
): ReplyRunAdmissionBarrier {
  const previous = barriersByKey.get(sessionKey);
  const source = resolveReplyRunAdmissionSource(
    operation,
    sessionId,
    previous?.sources.get(lifecycleAdmissionByOperation.get(operation)?.databaseIdentity),
  );
  // Retain only the latest source per physical store in this pending chain.
  // A foreign global barrier must not hide a same-store compaction successor.
  const sources = new Map(previous?.sources);
  sources.set(source.databaseIdentity, source);
  const settled = previous
    ? Promise.all([previous.settled, barrier]).then(() => undefined)
    : barrier;
  const entry = { settled, source, sources };
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
        registerReplyRunAdmissionBarrier(
          replyRunState.successorAdmissionBarriersByKey,
          sessionKey,
          params.sessionId,
          settlement.promise,
          params.operation,
        ),
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
      resolveReplyRunAdmissionSource(operation, sessionId, barrier.source);
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
  const state = afterClearByOperation.get(operation);
  if (!state) {
    return;
  }
  afterClearByOperation.delete(operation);
  for (const callback of state.callbacks) {
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
  operation: ReplyOperation,
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): ReplyRunAdmissionBarrier {
  const entry = registerReplyRunAdmissionBarrier(
    replyRunState.followupAdmissionBarriersByKey,
    operation.key,
    operation.sessionId,
    waitForReplyBarrierSettlement(barrier, timeout),
    operation,
  );
  // A later global barrier may belong to another store. Late callbacks still
  // wait for this operation's own delivery before releasing admission.
  const afterClear: ReplyOperationAfterClear = afterClearByOperation.get(operation) ?? {
    callbacks: new Set<(sessionId: string) => void>(),
  };
  afterClear.barrier = entry;
  afterClearByOperation.set(operation, afterClear);
  return entry;
}

export function updateFollowupAdmissionSessionId(operation: ReplyOperation): void {
  const sources = replyRunState.followupAdmissionBarriersByKey.get(operation.key)?.sources;
  const databaseIdentity = lifecycleAdmissionByOperation.get(operation)?.databaseIdentity;
  const source = sources?.get(databaseIdentity);
  if (sources && source) {
    sources.set(
      databaseIdentity,
      resolveReplyRunAdmissionSource(operation, operation.sessionId, source),
    );
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

export function isReplyRunRecoveryBlocked(operation: ReplyOperation): boolean {
  const backend = getAttachedBackend(operation);
  const blocker =
    !operation.result && backend
      ? resolveActiveEmbeddedRunRecoveryBlocker(operation.sessionId, backend)
      : undefined;
  return blocker === "human_input_wait" || blocker === "runtime_owned_wait";
}

export function isReplyRunEvidenceStale(operation: ReplyOperation): boolean {
  // Reading the wait may expire it and record the owner's resumed activity.
  const recoveryBlocked = isReplyRunRecoveryBlocked(operation);
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: operation.sessionId,
    sessionKey: operation.key,
  });
  return (
    !operation.result &&
    operation.phase !== "waiting_for_global_lane" &&
    Date.now() - operation.lastActivityAtMs >
      resolveRunStaleThresholdMs(activity, Date.now() - operation.lastActivityAtMs) &&
    !recoveryBlocked
  );
}
