// Tracks active reply runs so stop, queue, and status commands can coordinate.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";
import * as replyRunSettle from "./reply-run-finalization-lease.js";
import {
  replyMessageInjectionTargetOperation,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
  type ReplyOperationPhase,
  type ReplyRunRegistry,
} from "./reply-run-registry.contracts.js";
import { resolveReplyMessageInjectionRejection } from "./reply-run-registry.message-injection.js";
import {
  createReplyOperation,
  expireStaleReplyOperation,
  forceClearReplyOperation,
} from "./reply-run-registry.operation.js";
import {
  clearReplyRunState,
  evictReplyOperationByOperation,
  getAttachedBackend,
  isReplyOperationPreBackendPhase,
  isReplyRunCompacting,
  isReplyRunEvidenceStale,
  markReplyRunDiagnosticProgress,
  replyRunState,
  resolveReplyRunForCurrentSessionId,
  resolveReplyRunWaitKey,
  type ReplyRunAdmissionBarrier,
} from "./reply-run-registry.state.js";

type ReplyOperationStaleReason = replyRunSettle.ReplyOperationStaleReason;

type ReplyRunWaiter = {
  finish: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

export async function waitForReplyOperationOwnerSettlement(
  operation: ReplyOperation,
  timeoutMs: number,
): Promise<boolean> {
  const settlement = operation.ownerSettlement;
  if (!settlement) {
    return true;
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 100, 100);
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    settlement.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), resolvedTimeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return settled;
}

export function expireStaleReplyRunBySessionId(
  sessionId: string,
  reason: ReplyOperationStaleReason,
  options?: Parameters<typeof expireStaleReplyOperation>[2],
): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? expireStaleReplyOperation(operation, reason, options) : false;
}

// lastActivityAtMs is refreshed by agent events only; timers and user-message

export function markReplyOperationGlobalLaneWaitProgress(operation: ReplyOperation): void {
  if (operation.result || operation.phase !== "waiting_for_global_lane") {
    return;
  }
  markReplyRunDiagnosticProgress({
    sessionKey: operation.key,
    sessionId: operation.sessionId,
    reason: "global_lane:waiting",
  });
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
  resolveMessageInjectionTarget({ sessionKey, originatingLeafEntryId, expectedRunId }) {
    const operation = this.get(sessionKey);
    const resolved = resolveReplyMessageInjectionRejection({
      operation,
      originatingLeafEntryId,
      expectedRunId,
    });
    if (!("injection" in resolved)) {
      return undefined;
    }
    const target: ReplyMessageInjectionTarget = {
      [replyMessageInjectionTargetOperation]: operation!,
      identity: normalizeOptionalString(expectedRunId) ? "run" : "leaf",
      ...(resolved.backend.runId ? { runId: resolved.backend.runId } : {}),
      originatingLeafEntryId,
    };
    return target;
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

/** Cancels the current reply backend only when its native run identity matches exactly. */
export function supersedeReplyRunByRunId(runId: string, beforeCancel: () => void): boolean {
  const expectedRunId = normalizeOptionalString(runId);
  if (!expectedRunId) {
    return false;
  }
  for (const operation of replyRunState.activeRunsByKey.values()) {
    const backend = getAttachedBackend(operation);
    if (normalizeOptionalString(backend?.runId) !== expectedRunId) {
      continue;
    }
    beforeCancel();
    backend?.cancel("superseded");
    return true;
  }
  return false;
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

export function abortReplyRunBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  return operation.abortByUser();
}

export function resolveActiveReplyOperationForSessionId(
  sessionId: string,
): ReplyOperation | undefined {
  return resolveReplyRunForCurrentSessionId(sessionId);
}

export function forceClearReplyRunBySessionId(sessionId: string, cause?: unknown): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? forceClearReplyOperation(operation, cause) : false;
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
  timeoutMs?: number | null,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  if (!waitKey) {
    return Promise.resolve(true);
  }
  return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}

async function waitForReplyRunAdmissionBarrier(params: {
  barriersByKey: Map<string, ReplyRunAdmissionBarrier>;
  minimumTimeoutMs: number;
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
}): Promise<{ settled: boolean; sessionId?: string }> {
  const deadline =
    typeof params.timeoutMs === "number"
      ? Date.now() +
        resolveTimerTimeoutMs(params.timeoutMs, params.minimumTimeoutMs, params.minimumTimeoutMs)
      : undefined;
  let sessionId: string | undefined;
  while (true) {
    if (params.signal?.aborted) {
      return { settled: false };
    }
    const barrier = params.barriersByKey.get(params.sessionKey);
    if (!barrier) {
      return { settled: true, sessionId };
    }
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { settled: false };
    }
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const outcome = await Promise.race([
      barrier.settled.then(() => true),
      ...(remainingMs !== undefined
        ? [
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), Math.max(1, remainingMs));
              timer.unref?.();
            }),
          ]
        : []),
      ...(params.signal
        ? [
            new Promise<boolean>((resolve) => {
              abortHandler = () => resolve(false);
              params.signal?.addEventListener("abort", abortHandler, { once: true });
              if (params.signal?.aborted) {
                abortHandler();
              }
            }),
          ]
        : []),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
    }
    if (!outcome) {
      return { settled: false };
    }
    sessionId = barrier.sessionId;
  }
}

export async function waitForReplyRunFollowupAdmission(
  sessionKey: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<{ settled: boolean; sessionId?: string }> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barriersByKey: replyRunState.followupAdmissionBarriersByKey,
        minimumTimeoutMs: 100,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
}

export async function waitForReplyRunSuccessorAdmission(
  sessionKey: string,
  timeoutMs?: number | null,
  opts?: { signal?: AbortSignal },
): Promise<{ settled: boolean; sessionId?: string }> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barriersByKey: replyRunState.successorAdmissionBarriersByKey,
        minimumTimeoutMs: 0,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
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

function evictPriorLifecycleReplyRuns(): void {
  const errors: unknown[] = [];
  for (const operation of replyRunState.activeRunsByKey.values()) {
    if (
      operation.lifecycleGeneration &&
      isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration)
    ) {
      continue;
    }
    const evict = evictReplyOperationByOperation.get(operation);
    if (evict) {
      try {
        evict();
      } catch (error) {
        errors.push(error);
        try {
          clearReplyRunState({
            sessionKey: operation.key,
            sessionId: operation.sessionId,
            operation,
          });
        } catch (clearError) {
          errors.push(clearError);
        }
      }
      continue;
    }
    // Pre-generation hot-loaded operations have no retained callback, but their
    // public method still closes over the module instance that owns the backend.
    try {
      if (!operation.abortForRestart()) {
        errors.push(new Error(`Stale reply operation was not abortable: ${operation.key}`));
      }
    } catch (error) {
      errors.push(error);
    }
    // Admission stays occupied until the old closure clears it. If abort
    // synchronously clears and replaces the slot, its captured stateCleared
    // makes this completion idempotent instead of erasing the replacement.
    try {
      operation.complete();
    } catch (error) {
      errors.push(error);
    }
    try {
      clearReplyRunState({
        sessionKey: operation.key,
        sessionId: operation.sessionId,
        operation,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to abort stale reply runs");
  }
}

registerAgentEventLifecycleRotationHandler("reply-runs", evictPriorLifecycleReplyRuns);

const replyRunRegistryTestApi = {
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
    replyRunSettle.resetReplyRunSettleTimersForTesting();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        waiter.finish(false);
      }
    }
    replyRunState.waitersByKey.clear();
    replyRunState.followupAdmissionBarriersByKey.clear();
    replyRunState.successorAdmissionBarriersByKey.clear();
  },
};

if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.replyRunRegistryTestApi")] =
    replyRunRegistryTestApi;
}
