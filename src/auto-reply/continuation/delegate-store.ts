/**
 * Continuation delegate store — pure TaskFlow-backed.
 *
 * Every delegate operation goes through TaskFlow (SQLite persistence).
 * Zero volatile Maps. Delegates survive gateway restarts by design.
 *
 * Adds Zod validation on state payloads, a `releasedAt` audit trail, and
 * `failFlow` for corrupt records on top of the base TaskFlow store.
 *
 * RFC: docs/design/continue-work-signal-v2.md §5.4
 */

import { z } from "zod";
import type {
  DiagnosticContinuationQueueHistoryPoint,
  DiagnosticContinuationQueueMetrics,
  DiagnosticContinuationQueueOwnerSample,
} from "../../infra/diagnostic-events.js";
import {
  DIAGNOSTIC_TRACEPARENT_PATTERN,
  normalizeDiagnosticTraceparent,
} from "../../infra/diagnostic-trace-context.js";
import { registerDiagnosticContinuationQueueMetricsProvider } from "../../logging/diagnostic-continuation-queues.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  deleteTaskFlowRecordById,
  failFlow,
  finishFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  listTaskFlowsForOwnerKey,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-runtime-internal.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting.js";
import type {
  ChainState,
  PendingContinuationDelegate,
  StagedPostCompactionDelegate,
} from "./types.js";

const log = createSubsystemLogger("continuation/delegate-store");

// ---------------------------------------------------------------------------
// Controller IDs (exported for test assertions)
// ---------------------------------------------------------------------------

export const CONTINUATION_DELEGATE_CONTROLLER_ID = "core/continuation-delegate";
export const CONTINUATION_POST_COMPACTION_CONTROLLER_ID = "core/continuation-post-compaction";

// ---------------------------------------------------------------------------
// Zod validation for TaskFlow state payloads
// ---------------------------------------------------------------------------

const TraceparentStateSchema = z
  .preprocess(
    (value) => (value === null ? undefined : value),
    z
      .string()
      .regex(new RegExp(DIAGNOSTIC_TRACEPARENT_PATTERN))
      .refine((value) => normalizeDiagnosticTraceparent(value) !== undefined, {
        message: "invalid W3C traceparent",
      })
      .transform((value) => normalizeDiagnosticTraceparent(value)!)
      .optional(),
  )
  .optional();

const PendingDelegateStateSchema = z
  .object({
    kind: z.literal("continuation_delegate"),
    task: z.string().min(1),
    delayMs: z.number().int().nonnegative().optional(),
    silent: z.boolean().optional(),
    silentWake: z.boolean().optional(),
    postCompaction: z.boolean().optional(),
    firstArmedAt: z.number().int().nonnegative().optional(),
    targetSessionKey: z.string().min(1).optional(),
    targetSessionKeys: z.array(z.string().min(1)).optional(),
    fanoutMode: z.enum(CONTINUATION_DELEGATE_FANOUT_MODES).optional(),
    traceparent: TraceparentStateSchema,
    traceparentProvenance: z.literal("internal").optional(),
    model: z.string().min(1).optional(),
    releasedAt: z.number().int().nonnegative().optional(),
    childSessionKey: z.string().min(1).optional(),
    // Durable chain-cost fold: the settled child's own run-token cost, written
    // ONLY when the child chain-cost persist to the child session entry failed.
    // Restart recovery adds it to the (stale) child-entry chain cost so the
    // continuation cost cap is enforced against the post-run total (#1144).
    chainTokensFold: z.number().int().nonnegative().optional(),
    persistedChainState: z
      .object({
        currentChainCount: z.number().int().nonnegative(),
        chainStartedAt: z.number().int().nonnegative(),
        accumulatedChainTokens: z.number().int().nonnegative(),
        chainId: z.string().min(1).optional(),
      })
      .optional(),
    persistedChainStateKind: z.enum(["advanced", "terminal"]).optional(),
    // Durable inherited policy for default-mode delayed delegates queued under
    // a silent/silent-wake parent chain. Recovery cannot reconstruct this from
    // the session key alone, so it must ride the TaskFlow row (#1158).
    inheritedSilent: z.boolean().optional(),
    inheritedWake: z.boolean().optional(),
    spawnRequesterSessionKey: z.string().min(1).optional(),
    spawnRequesterChannel: z.string().min(1).optional(),
    spawnRequesterAccountId: z.string().min(1).optional(),
    spawnRequesterTo: z.string().min(1).optional(),
    spawnRequesterThreadId: z.union([z.string().min(1), z.number()]).optional(),
    awaitingNextCompaction: z.boolean().optional(),
  })
  .superRefine((state, ctx) => {
    const hasSilent = state.silent === true;
    const hasSilentWake = state.silentWake === true;
    const hasPostCompaction = state.postCompaction === true;
    const flagCount = [hasSilent, hasSilentWake, hasPostCompaction].filter(Boolean).length;
    if (
      state.fanoutMode &&
      (state.targetSessionKey || (state.targetSessionKeys && state.targetSessionKeys.length > 0))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "continuation delegate payload cannot combine explicit targets with fanoutMode",
      });
      return;
    }
    if (flagCount <= 1 || (hasSilent && hasSilentWake && !hasPostCompaction)) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "continuation delegate payload has incompatible mode flags",
    });
  });

type PendingDelegateState = z.infer<typeof PendingDelegateStateSchema>;

type PendingDelegateCutoffOptions = {
  includeRunning?: boolean;
  queuedCreatedAtOrBefore?: number;
  includeRunningUpdatedAtOrBefore?: number;
};

export type ContinuationDelegateQueueDepths = {
  pendingQueued: number;
  pendingRunnable: number;
  pendingScheduled: number;
  stagedPostCompaction: number;
  totalQueued: number;
};

const CONTINUATION_QUEUE_HISTORY_LIMIT = 8;
let continuationQueueDiagnosticsLastSampleAt: number | undefined;
const continuationQueueDiagnosticsHistory: DiagnosticContinuationQueueHistoryPoint[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDelegateGoal(delegate: PendingContinuationDelegate): string {
  const task = delegate.task.trim();
  const isPostCompaction = delegate.mode === "post-compaction";
  if (!task) {
    return isPostCompaction ? "Post-compaction continuation delegate" : "Continuation delegate";
  }
  const excerpt = task.length > 80 ? `${task.slice(0, 77)}...` : task;
  return isPostCompaction
    ? `Post-compaction delegate: ${excerpt}`
    : `Continuation delegate: ${excerpt}`;
}

function buildDelegateState(delegate: PendingContinuationDelegate): PendingDelegateState {
  // `mode` is the sole runtime-surface encoding. Project it into the on-disk
  // boolean flags so existing persisted records
  // (which predate the mode-only runtime shape) keep their familiar schema
  // and `decodeDelegateState` / `flowToDelegate` keep working unchanged for
  // historical TaskFlow rows.
  const targetSessionKey = normalizeContinuationTargetKey(delegate.targetSessionKey);
  const targetSessionKeys = normalizeContinuationTargetKeys(delegate.targetSessionKeys);
  const traceparent = normalizeDiagnosticTraceparent(delegate.traceparent);
  return {
    kind: "continuation_delegate",
    task: delegate.task,
    ...(delegate.delayMs !== undefined ? { delayMs: delegate.delayMs } : {}),
    ...(delegate.mode === "silent" ? { silent: true } : {}),
    ...(delegate.mode === "silent-wake" ? { silentWake: true } : {}),
    ...(delegate.mode === "post-compaction" ? { postCompaction: true } : {}),
    ...(delegate.firstArmedAt !== undefined || delegate.delayMs !== undefined
      ? { firstArmedAt: delegate.firstArmedAt ?? Date.now() }
      : {}),
    ...(targetSessionKey ? { targetSessionKey } : {}),
    ...(targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(traceparent ? { traceparent, traceparentProvenance: "internal" as const } : {}),
    ...(delegate.model ? { model: delegate.model } : {}),
    ...(delegate.chainTokensFold !== undefined
      ? { chainTokensFold: delegate.chainTokensFold }
      : {}),
    ...(delegate.persistedChainState ? { persistedChainState: delegate.persistedChainState } : {}),
    ...(delegate.persistedChainStateKind
      ? { persistedChainStateKind: delegate.persistedChainStateKind }
      : {}),
    ...(delegate.inheritedSilent ? { inheritedSilent: true } : {}),
    ...(delegate.inheritedWake ? { inheritedWake: true } : {}),
    ...(delegate.spawnRequesterSessionKey
      ? { spawnRequesterSessionKey: delegate.spawnRequesterSessionKey }
      : {}),
    ...(delegate.spawnRequesterChannel
      ? { spawnRequesterChannel: delegate.spawnRequesterChannel }
      : {}),
    ...(delegate.spawnRequesterAccountId
      ? { spawnRequesterAccountId: delegate.spawnRequesterAccountId }
      : {}),
    ...(delegate.spawnRequesterTo ? { spawnRequesterTo: delegate.spawnRequesterTo } : {}),
    ...(delegate.spawnRequesterThreadId !== undefined
      ? { spawnRequesterThreadId: delegate.spawnRequesterThreadId }
      : {}),
  };
}

function isPendingDelegateFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === CONTINUATION_DELEGATE_CONTROLLER_ID;
}

function isPostCompactionDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    flow.syncMode === "managed" && flow.controllerId === CONTINUATION_POST_COMPACTION_CONTROLLER_ID
  );
}

function isContinuationDelegateFlow(flow: TaskFlowRecord): boolean {
  return isPendingDelegateFlow(flow) || isPostCompactionDelegateFlow(flow);
}

function isTerminalDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    isContinuationDelegateFlow(flow) &&
    (flow.status === "succeeded" ||
      flow.status === "blocked" ||
      flow.status === "failed" ||
      flow.status === "cancelled" ||
      flow.status === "lost")
  );
}

function isSucceededDelegateFlow(flow: TaskFlowRecord): boolean {
  return isContinuationDelegateFlow(flow) && flow.status === "succeeded";
}

function isRecoverablePendingFlow(flow: TaskFlowRecord): boolean {
  return isPendingDelegateFlow(flow) && (flow.status === "queued" || flow.status === "running");
}

function isRecoverableContinuationDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    (isPendingDelegateFlow(flow) || isPostCompactionDelegateFlow(flow)) &&
    (flow.status === "queued" || flow.status === "running")
  );
}

function isRecoverablePendingFlowWithinCutoffs(
  flow: TaskFlowRecord,
  options: PendingDelegateCutoffOptions = {},
): boolean {
  if (!isPendingDelegateFlow(flow)) {
    return false;
  }
  if (flow.status === "queued") {
    if (options.queuedCreatedAtOrBefore === undefined) {
      return true;
    }
    return flow.createdAt <= options.queuedCreatedAtOrBefore;
  }
  if (flow.status !== "running" || options.includeRunning !== true) {
    return false;
  }
  if (options.includeRunningUpdatedAtOrBefore === undefined) {
    return true;
  }
  return flow.updatedAt <= options.includeRunningUpdatedAtOrBefore;
}

function listRecoverablePendingFlows(
  sessionKey: string,
  options: PendingDelegateCutoffOptions = {},
): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isRecoverablePendingFlowWithinCutoffs(flow, options))
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

function listQueuedPendingFlows(sessionKey: string): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isPendingDelegateFlow(flow) && flow.status === "queued")
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

function listQueuedPostCompactionFlows(sessionKey: string): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isPostCompactionDelegateFlow(flow) && flow.status === "queued")
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

function decodeDelegateState(flow: TaskFlowRecord): PendingDelegateState | undefined {
  const parsed = PendingDelegateStateSchema.safeParse(flow.stateJson);
  return parsed.success ? parsed.data : undefined;
}

function countFlowsChangedSince(
  flows: TaskFlowRecord[],
  status: TaskFlowRecord["status"],
  since: number | undefined,
  now: number,
): number {
  if (since === undefined) {
    return 0;
  }
  return flows.filter((flow) => {
    const changedAt = flow.endedAt ?? flow.updatedAt;
    return flow.status === status && changedAt > since && changedAt <= now;
  }).length;
}

function createEmptyOwnerQueueSample(sessionKey: string): DiagnosticContinuationQueueOwnerSample {
  return {
    sessionKey,
    pendingQueued: 0,
    pendingRunnable: 0,
    pendingScheduled: 0,
    stagedPostCompaction: 0,
    invalidQueued: 0,
    totalQueued: 0,
  };
}

function noteOwnerQueuedFlow(
  owner: DiagnosticContinuationQueueOwnerSample,
  flow: TaskFlowRecord,
  now: number,
): void {
  owner.totalQueued += 1;
  const queuedAgeMs = Math.max(0, now - flow.createdAt);
  owner.oldestQueuedAgeMs = Math.max(owner.oldestQueuedAgeMs ?? 0, queuedAgeMs);
  owner.newestQueuedAgeMs =
    owner.newestQueuedAgeMs === undefined
      ? queuedAgeMs
      : Math.min(owner.newestQueuedAgeMs, queuedAgeMs);
}

function buildContinuationQueueDiagnostics(
  now = Date.now(),
): DiagnosticContinuationQueueMetrics | undefined {
  const flows = listTaskFlowRecords().filter(isContinuationDelegateFlow);
  const intervalMs =
    continuationQueueDiagnosticsLastSampleAt !== undefined
      ? Math.max(0, now - continuationQueueDiagnosticsLastSampleAt)
      : undefined;
  const previousSampleAt = continuationQueueDiagnosticsLastSampleAt;
  const enqueuedSinceLastSample =
    previousSampleAt === undefined
      ? 0
      : flows.filter((flow) => flow.createdAt > previousSampleAt && flow.createdAt <= now).length;
  const drainedSinceLastSample = countFlowsChangedSince(flows, "succeeded", previousSampleAt, now);
  const failedSinceLastSample = countFlowsChangedSince(flows, "failed", previousSampleAt, now);

  const owners = new Map<string, DiagnosticContinuationQueueOwnerSample>();
  let pendingQueued = 0;
  let pendingRunnable = 0;
  let pendingScheduled = 0;
  let stagedPostCompaction = 0;
  let invalidQueued = 0;

  for (const flow of flows) {
    if (flow.status !== "queued") {
      continue;
    }
    const owner = owners.get(flow.ownerKey) ?? createEmptyOwnerQueueSample(flow.ownerKey);
    owners.set(flow.ownerKey, owner);
    noteOwnerQueuedFlow(owner, flow, now);

    if (isPostCompactionDelegateFlow(flow)) {
      stagedPostCompaction += 1;
      owner.stagedPostCompaction += 1;
      continue;
    }

    pendingQueued += 1;
    owner.pendingQueued += 1;
    const state = decodeDelegateState(flow);
    if (!state) {
      invalidQueued += 1;
      owner.invalidQueued += 1;
      continue;
    }
    if (delegateDueAt(flow, state) <= now) {
      pendingRunnable += 1;
      owner.pendingRunnable += 1;
    } else {
      pendingScheduled += 1;
      owner.pendingScheduled += 1;
    }
  }

  const totalQueued = pendingQueued + stagedPostCompaction;
  const historyPoint: DiagnosticContinuationQueueHistoryPoint = {
    sampledAt: now,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    totalQueued,
    pendingRunnable,
    pendingScheduled,
    stagedPostCompaction,
    invalidQueued,
    enqueued: enqueuedSinceLastSample,
    drained: drainedSinceLastSample,
    failed: failedSinceLastSample,
  };
  continuationQueueDiagnosticsHistory.push(historyPoint);
  if (continuationQueueDiagnosticsHistory.length > CONTINUATION_QUEUE_HISTORY_LIMIT) {
    continuationQueueDiagnosticsHistory.splice(
      0,
      continuationQueueDiagnosticsHistory.length - CONTINUATION_QUEUE_HISTORY_LIMIT,
    );
  }
  continuationQueueDiagnosticsLastSampleAt = now;

  if (
    flows.length === 0 &&
    totalQueued === 0 &&
    enqueuedSinceLastSample === 0 &&
    drainedSinceLastSample === 0 &&
    failedSinceLastSample === 0
  ) {
    return undefined;
  }

  const rateFields =
    intervalMs !== undefined && intervalMs > 0
      ? {
          enqueueRatePerMinute: (enqueuedSinceLastSample * 60_000) / intervalMs,
          drainRatePerMinute: (drainedSinceLastSample * 60_000) / intervalMs,
          failedRatePerMinute: (failedSinceLastSample * 60_000) / intervalMs,
        }
      : {};

  return {
    sampledAt: now,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    totalQueued,
    pendingQueued,
    pendingRunnable,
    pendingScheduled,
    stagedPostCompaction,
    invalidQueued,
    enqueuedSinceLastSample,
    drainedSinceLastSample,
    failedSinceLastSample,
    ...rateFields,
    topQueues: [...owners.values()]
      .toSorted((a, b) => b.totalQueued - a.totalQueued || a.sessionKey.localeCompare(b.sessionKey))
      .slice(0, 8),
    queueDepthHistory: [...continuationQueueDiagnosticsHistory],
  };
}

registerDiagnosticContinuationQueueMetricsProvider(buildContinuationQueueDiagnostics);

function delegateDueAt(flow: TaskFlowRecord, state: PendingDelegateState): number {
  return flow.createdAt + (state.delayMs ?? 0);
}

function flowToDelegate(
  flow: TaskFlowRecord,
  state: PendingDelegateState,
): PendingContinuationDelegate {
  // Rehydrate runtime shape (mode-only) from the on-disk boolean flags.
  // silentWake takes precedence over silent
  // because on-disk rows may have both set (mode === "silent-wake" also
  // wrote silent in earlier encoders), and silent-wake is the more
  // specific mode.
  let mode: PendingContinuationDelegate["mode"];
  if (state.postCompaction === true) {
    mode = "post-compaction";
  } else if (state.silentWake === true) {
    mode = "silent-wake";
  } else if (state.silent === true) {
    mode = "silent";
  }
  return {
    task: state.task,
    ...(state.delayMs !== undefined ? { delayMs: state.delayMs } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(state.firstArmedAt !== undefined ? { firstArmedAt: state.firstArmedAt } : {}),
    ...(state.targetSessionKey ? { targetSessionKey: state.targetSessionKey } : {}),
    ...(state.targetSessionKeys && state.targetSessionKeys.length > 0
      ? { targetSessionKeys: state.targetSessionKeys }
      : {}),
    ...(state.fanoutMode ? { fanoutMode: state.fanoutMode } : {}),
    ...(state.traceparent && state.traceparentProvenance === "internal"
      ? { traceparent: state.traceparent }
      : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.chainTokensFold !== undefined ? { chainTokensFold: state.chainTokensFold } : {}),
    ...(state.persistedChainState ? { persistedChainState: state.persistedChainState } : {}),
    ...(state.persistedChainStateKind
      ? { persistedChainStateKind: state.persistedChainStateKind }
      : {}),
    ...(state.inheritedSilent ? { inheritedSilent: true } : {}),
    ...(state.inheritedWake ? { inheritedWake: true } : {}),
    ...(state.spawnRequesterSessionKey
      ? { spawnRequesterSessionKey: state.spawnRequesterSessionKey }
      : {}),
    ...(state.spawnRequesterChannel ? { spawnRequesterChannel: state.spawnRequesterChannel } : {}),
    ...(state.spawnRequesterAccountId
      ? { spawnRequesterAccountId: state.spawnRequesterAccountId }
      : {}),
    ...(state.spawnRequesterTo ? { spawnRequesterTo: state.spawnRequesterTo } : {}),
    ...(state.spawnRequesterThreadId !== undefined
      ? { spawnRequesterThreadId: state.spawnRequesterThreadId }
      : {}),
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  };
}

// ---------------------------------------------------------------------------
// Pending delegates — enqueue/consume/count/cancel
// ---------------------------------------------------------------------------

/**
 * Enqueue a delegate from the `continue_delegate` tool.
 */
export function enqueuePendingDelegate(
  sessionKey: string,
  delegate: PendingContinuationDelegate,
): void {
  const isPostCompaction = delegate.mode === "post-compaction";
  createManagedTaskFlow({
    ownerKey: sessionKey,
    controllerId: isPostCompaction
      ? CONTINUATION_POST_COMPACTION_CONTROLLER_ID
      : CONTINUATION_DELEGATE_CONTROLLER_ID,
    notifyPolicy: "silent",
    goal: buildDelegateGoal(delegate),
    currentStep: isPostCompaction
      ? "Staged for release after compaction"
      : "Queued for continuation dispatch",
    stateJson: buildDelegateState(delegate),
  });
}

/**
 * Consume pending delegates for a session whose `delayMs` horizon has matured.
 *
 * Filters by `Date.now() >= flow.createdAt + (state.delayMs ?? 0)`. Matured
 * entries are finished with the `releasedAt` audit trail and returned in FIFO
 * order. Unmatured entries are left in `queued` state to be re-checked on the
 * next consume cycle (filter-at-consume; preserves `mode=silent` no-wake
 * semantics so a quiet-channel session is not woken solely to drain a delegate
 * whose horizon has not yet matured).
 *
 * Skips corrupt payloads via `failFlow`. Only pushes delegates where
 * the queued/running claim was applied (concurrency-safe).
 *
 * Callers that need to know when to retry the consume cycle in a quiet channel
 * should call `peekSoonestUnmaturedDelegateDueAt(sessionKey)` immediately after
 * this returns. Pairing avoids a separate query path.
 *
 * Maturity contract for downstream callers: each returned delegate has
 * already passed its `createdAt + delayMs` horizon. The `delayMs` field on
 * the returned object is historical metadata — useful for telemetry
 * discriminators — and MUST NOT be used as a fresh scheduling instruction.
 * Re-arming a `setTimeout(delayMs)` against a consumed delegate charges the
 * wait twice and drifts recipient drains by approximately the original delay.
 */
export function listPendingDelegateSessionKeysForRecovery(
  options: Omit<PendingDelegateCutoffOptions, "includeRunning"> = {},
): string[] {
  const sessionKeys = listTaskFlowRecords()
    .filter((flow) =>
      isRecoverablePendingFlowWithinCutoffs(flow, {
        includeRunning: true,
        queuedCreatedAtOrBefore: options.queuedCreatedAtOrBefore,
        includeRunningUpdatedAtOrBefore: options.includeRunningUpdatedAtOrBefore,
      }),
    )
    .map((flow) => flow.ownerKey);
  return [...new Set(sessionKeys)].toSorted();
}

export function consumePendingDelegates(
  sessionKey: string,
  options: PendingDelegateCutoffOptions & {
    /**
     * Dispatch queued delegates immediately even if their `delayMs` has not
     * elapsed. Used as a fail-closed lever when the child chain-cost persist
     * failed: rather than leave a delayed delegate durably queued (where restart
     * recovery would rebuild its cost basis from the stale child entry and
     * under-enforce the cost cap), dispatch it now on the correct in-memory
     * folded basis (#1144).
     */
    ignoreDelay?: boolean;
  } = {},
): PendingContinuationDelegate[] {
  const delegates: PendingContinuationDelegate[] = [];
  const now = Date.now();

  for (const flow of listRecoverablePendingFlows(sessionKey, options)) {
    const state = decodeDelegateState(flow);
    if (!state) {
      // Schema-drift / corrupt payload needs a live breadcrumb. failFlow
      // alone leaves the record in SQLite where
      // nobody looks until `openclaw status --deep`.
      log.warn(
        `[continuation:delegate-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`,
      );
      failFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: "Rejected invalid continuation payload",
        blockedSummary: "Pending continuation delegate payload could not be decoded.",
      });
      continue;
    }

    // Filter-at-consume: leave unmatured QUEUED entries in `queued` so the next
    // response-finalize (or the hedge timer armed by the dispatch caller)
    // re-checks them. Honors `delayMs` on the tool path without threading a
    // wake-pathway timer (which would change `mode=silent` semantics).
    // `ignoreDelay` overrides this for the fail-closed persist-failure path.
    //
    // The gate applies ONLY to `queued` rows. A `running` row is already claimed
    // for dispatch (recovery includes it via `includeRunning`); re-driving it must
    // NOT be delay-gated, or a delegate force-claimed pre-due via `ignoreDelay`
    // and then orphaned by a crash would be skipped here on restart (now < dueAt)
    // AND get no hedge (hedges only watch queued rows) — stranding it `running`
    // forever (#1144).
    const dueAt = delegateDueAt(flow, state);
    if (!options.ignoreDelay && flow.status === "queued" && now < dueAt) {
      continue;
    }

    const releasedAt = Date.now();
    const claimed = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "running",
        currentStep:
          flow.status === "running"
            ? "Re-driving continuation delegate spawn"
            : "Released to continuation scheduler",
        stateJson: { ...state, releasedAt },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        endedAt: null,
        updatedAt: releasedAt,
      },
    });
    if (!claimed.applied || !claimed.flow) {
      continue;
    }

    delegates.push(flowToDelegate(claimed.flow, { ...state, releasedAt }));
  }

  return delegates;
}

export function markPendingDelegateSpawnAccepted(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  childSessionKey: string,
  options: { requireWriteSuccess?: boolean } = {},
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-accept-missing-flow] cannot commit accepted delegate because flow metadata is missing",
    );
    return false;
  }
  const current = getTaskFlowById(delegate.flowId);
  const state = current ? decodeDelegateState(current) : undefined;
  const now = Date.now();
  const expectedRevision = delegate.expectedRevision;
  const finished = finishFlow({
    flowId: delegate.flowId,
    expectedRevision,
    currentStep: "Accepted by continuation subagent",
    stateJson: {
      ...(state ?? { kind: "continuation_delegate", task: delegate.task }),
      childSessionKey,
    },
    updatedAt: now,
    endedAt: now,
  });
  if (!finished.applied) {
    if (finished.current && isSucceededDelegateFlow(finished.current)) {
      return true;
    }
    const message = `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${expectedRevision} acceptance was not committed`;
    log.warn(message);
    if (options.requireWriteSuccess === true) {
      throw new Error(message);
    }
  }
  return finished.applied;
}

export function markPendingDelegateFailed(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
  blockedSummary: string,
  currentStep = "Delegate spawn failed",
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-fail-missing-flow] cannot mark consumed delegate failed because flow metadata is missing",
    );
    return false;
  }
  const failed = failFlow({
    flowId: delegate.flowId,
    expectedRevision: delegate.expectedRevision,
    currentStep,
    blockedSummary,
    updatedAt: Date.now(),
  });
  if (failed.applied) {
    return true;
  }
  return Boolean(failed.current && isTerminalDelegateFlow(failed.current));
}

export function markPendingDelegateChainStatePersistPlanned(
  delegate: Pick<
    PendingContinuationDelegate,
    "flowId" | "expectedRevision" | "task" | "persistedChainState" | "persistedChainStateKind"
  >,
  chainState: ChainState,
  kind: "advanced" | "terminal" = "advanced",
): PendingContinuationDelegate {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    log.warn(
      "[continuation:delegate-chain-state-plan-missing-flow] cannot mark planned chain state because flow metadata is missing",
    );
    return {
      task: delegate.task,
      ...(delegate.persistedChainState
        ? { persistedChainState: delegate.persistedChainState }
        : {}),
      ...(delegate.persistedChainStateKind
        ? { persistedChainStateKind: delegate.persistedChainStateKind }
        : {}),
    };
  }
  const current = getTaskFlowById(delegate.flowId);
  const state = current ? decodeDelegateState(current) : undefined;
  const { chainTokensFold: _chainTokensFold, ...stateWithoutFold } =
    state ??
    ({ kind: "continuation_delegate", task: delegate.task } satisfies PendingDelegateState);
  const nextState: PendingDelegateState = {
    ...stateWithoutFold,
    persistedChainState: chainState,
    persistedChainStateKind: kind,
  };
  const planned = updateFlowRecordByIdExpectedRevision({
    flowId: delegate.flowId,
    expectedRevision: delegate.expectedRevision,
    patch: {
      stateJson: nextState,
      updatedAt: Date.now(),
    },
  });
  if (!planned.applied || !planned.flow) {
    throw new Error(
      `planned delegate chain-state marker was not committed for flow ${delegate.flowId}`,
    );
  }
  return flowToDelegate(planned.flow, nextState);
}

/**
 * Peek the soonest `dueAt` (createdAt + delayMs) across queued, unmatured
 * pending delegates for a session.
 *
 * Returns `undefined` if there are no unmatured entries. Used by
 * `dispatchToolDelegates` to arm a hedge `setTimeout` so unmatured entries
 * still fire in fully-quiet channels where no further response-finalize
 * arrives.
 */
export function peekSoonestUnmaturedDelegateDueAt(
  sessionKey: string,
  options: Pick<PendingDelegateCutoffOptions, "queuedCreatedAtOrBefore"> = {},
): number | undefined {
  const now = Date.now();
  let soonest: number | undefined;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    if (
      options.queuedCreatedAtOrBefore !== undefined &&
      flow.createdAt > options.queuedCreatedAtOrBefore
    ) {
      continue;
    }
    const state = decodeDelegateState(flow);
    if (!state) {
      continue;
    }
    const dueAt = delegateDueAt(flow, state);
    if (dueAt <= now) {
      continue;
    }
    if (soonest === undefined || dueAt < soonest) {
      soonest = dueAt;
    }
  }
  return soonest;
}

/**
 * Count pending delegates without consuming them.
 */
export function pendingDelegateCount(sessionKey: string): number {
  return listQueuedPendingFlows(sessionKey).length;
}

/**
 * True while this session still owns an in-flight regular continuation delegate,
 * queued OR already claimed to `running` (mid-dispatch, or awaiting restart recovery).
 * subagent-session cleanup uses this to defer deleting a child session whose
 * chain/requester state a delayed bracket/tool delegate still depends on:
 * {@link pendingDelegateCount} counts only queued flows, so it drops to 0 the
 * instant the hedge/dispatcher claims the delegate to `running` — before
 * `spawnSubagentDirect` finishes — which would let a deferred cleanup delete the
 * child out from under the running delegate (#1144).
 */
export function hasRecoverablePendingDelegate(sessionKey: string): boolean {
  return listTaskFlowsForOwnerKey(sessionKey).some(isRecoverablePendingFlow);
}

/**
 * Record a durable chain-cost fold on every QUEUED pending delegate for a
 * session. Called at settle when the child chain-cost persist to the child
 * session entry failed: the fold (the settled child's own run-token cost) is
 * then carried on the delegate rows themselves, so restart recovery — which
 * rebuilds chain cost from the now-stale child session entry — still enforces
 * the continuation cost cap against the post-run total. Returns the count
 * annotated. No-op for a non-positive fold (#1144).
 */
export function annotateQueuedDelegatesChainTokensFold(
  sessionKey: string,
  chainTokensFold: number,
): number {
  if (!(chainTokensFold > 0)) {
    return 0;
  }
  let annotated = 0;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    const state = decodeDelegateState(flow);
    if (!state) {
      continue;
    }
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        stateJson: { ...state, chainTokensFold },
        updatedAt: Date.now(),
      },
    });
    if (result.applied) {
      annotated += 1;
    }
  }
  return annotated;
}

/**
 * Clear durable chain-cost folds from still-queued delegates after the folded
 * basis has been persisted to the child entry. Without this, later hedges reload
 * the already-folded entry and add the same fold again (#1158).
 */
function clearDelegatesChainTokensFold(flows: readonly TaskFlowRecord[]): number {
  let cleared = 0;
  for (const flow of flows) {
    const state = decodeDelegateState(flow);
    if (!state?.chainTokensFold) {
      continue;
    }
    const { chainTokensFold: _chainTokensFold, ...nextState } = state;
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        stateJson: nextState,
        updatedAt: Date.now(),
      },
    });
    if (result.applied) {
      cleared += 1;
    }
  }
  return cleared;
}

export function clearQueuedDelegatesChainTokensFold(sessionKey: string): number {
  return clearDelegatesChainTokensFold(listQueuedPendingFlows(sessionKey));
}

export function clearRecoverableDelegatesChainTokensFold(sessionKey: string): number {
  return clearDelegatesChainTokensFold(
    listTaskFlowsForOwnerKey(sessionKey).filter(isRecoverablePendingFlow),
  );
}

/**
 * Persist inherited silent/wake policy on queued default-mode delegates before a
 * delay hedge can outlive the process that carried the in-memory inheritance.
 */
export function annotateQueuedDelegatesInheritedPolicy(
  sessionKey: string,
  policy: { inheritedSilent?: boolean; inheritedWake?: boolean },
): number {
  if (policy.inheritedSilent !== true && policy.inheritedWake !== true) {
    return 0;
  }
  let annotated = 0;
  for (const flow of listQueuedPendingFlows(sessionKey)) {
    const state = decodeDelegateState(flow);
    if (!state) {
      continue;
    }
    const hasOwnMode =
      state.silent === true || state.silentWake === true || state.postCompaction === true;
    if (hasOwnMode) {
      continue;
    }
    const nextState = {
      ...state,
      ...(policy.inheritedSilent ? { inheritedSilent: true } : {}),
      ...(policy.inheritedWake ? { inheritedWake: true } : {}),
    };
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        stateJson: nextState,
        updatedAt: Date.now(),
      },
    });
    if (result.applied) {
      annotated += 1;
    }
  }
  return annotated;
}

export function getContinuationDelegateQueueDepths(
  sessionKey: string,
  now = Date.now(),
): ContinuationDelegateQueueDepths {
  const pendingFlows = listQueuedPendingFlows(sessionKey);
  let pendingRunnable = 0;
  for (const flow of pendingFlows) {
    const state = decodeDelegateState(flow);
    if (state && delegateDueAt(flow, state) <= now) {
      pendingRunnable += 1;
    }
  }
  const stagedPostCompaction = listQueuedPostCompactionFlows(sessionKey).length;
  return {
    pendingQueued: pendingFlows.length,
    pendingRunnable,
    pendingScheduled: pendingFlows.length - pendingRunnable,
    stagedPostCompaction,
    totalQueued: pendingFlows.length + stagedPostCompaction,
  };
}

/**
 * Cancel all pending delegates for a session (both regular and post-compaction).
 */
export function cancelPendingDelegates(sessionKey: string): void {
  for (const flow of listTaskFlowsForOwnerKey(sessionKey).filter(
    (f) => isPendingDelegateFlow(f) || isPostCompactionDelegateFlow(f),
  )) {
    deleteTaskFlowRecordById(flow.flowId);
  }
}

// ---------------------------------------------------------------------------
// Post-compaction delegate staging
// ---------------------------------------------------------------------------

/**
 * Stage a delegate for release after compaction.
 */
export function stagePostCompactionDelegate(
  sessionKey: string,
  delegate: StagedPostCompactionDelegate,
): void {
  createManagedTaskFlow({
    ownerKey: sessionKey,
    controllerId: CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
    notifyPolicy: "silent",
    goal: buildDelegateGoal({ task: delegate.task, mode: "post-compaction" }),
    currentStep: "Staged for release after compaction",
    stateJson: buildDelegateState({
      task: delegate.task,
      mode: "post-compaction",
      firstArmedAt: delegate.firstArmedAt ?? delegate.stagedAt,
      ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
      ...(delegate.targetSessionKeys ? { targetSessionKeys: delegate.targetSessionKeys } : {}),
      ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
      ...(delegate.traceparent ? { traceparent: delegate.traceparent } : {}),
      ...(delegate.model ? { model: delegate.model } : {}),
    }),
  });
}

export function requeueReleasedPostCompactionDelegate(
  delegate: Pick<PendingContinuationDelegate, "flowId" | "expectedRevision" | "task">,
): boolean {
  if (!delegate.flowId || delegate.expectedRevision === undefined) {
    return false;
  }
  const flow = getTaskFlowById(delegate.flowId);
  if (!flow || !isPostCompactionDelegateFlow(flow) || flow.status !== "running") {
    return false;
  }
  const state = decodeDelegateState(flow);
  const now = Date.now();
  const result = updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: delegate.expectedRevision,
    patch: {
      status: "queued",
      currentStep: "Staged for release after compaction",
      stateJson: state
        ? (() => {
            const { releasedAt: _releasedAt, awaitingNextCompaction: _awaiting, ...rest } = state;
            return rest;
          })()
        : { kind: "continuation_delegate", task: delegate.task, postCompaction: true },
      waitJson: null,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: now,
    },
  });
  return result.applied;
}

export function requeueAwaitingNextCompactionDelegates(options: {
  runningUpdatedAtOrBefore: number;
}): number {
  let requeued = 0;
  for (const flow of listTaskFlowRecords()) {
    if (
      !isPostCompactionDelegateFlow(flow) ||
      flow.status !== "running" ||
      flow.updatedAt > options.runningUpdatedAtOrBefore
    ) {
      continue;
    }
    const state = decodeDelegateState(flow);
    if (!state || state.awaitingNextCompaction !== true) {
      continue;
    }
    if (requeueReleasedPostCompactionDelegate(flowToDelegate(flow, state))) {
      requeued++;
    }
  }
  return requeued;
}

export function failStagedPostCompactionDelegatesForCleanup(
  sessionKey: string,
  blockedSummary: string,
): number {
  let failed = 0;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (
      !isPostCompactionDelegateFlow(flow) ||
      (flow.status !== "queued" && flow.status !== "running")
    ) {
      continue;
    }
    const result = failFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: "Dropped post-compaction delegate during subagent cleanup",
      blockedSummary,
    });
    if (result.applied) {
      failed++;
    }
  }
  return failed;
}

export function failQueuedDelegatesCreatedAtOrAfter(
  sessionKey: string,
  createdAtOrAfter: number,
  blockedSummary: string,
): number {
  let failed = 0;
  for (const flow of listTaskFlowsForOwnerKey(sessionKey)) {
    if (
      !isRecoverableContinuationDelegateFlow(flow) ||
      flow.status !== "queued" ||
      flow.createdAt < createdAtOrAfter
    ) {
      continue;
    }
    const result = failFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: "Rejected replay-unsafe continuation delegate election",
      blockedSummary,
    });
    if (result.applied) {
      failed++;
    }
  }
  return failed;
}

/**
 * Consume staged post-compaction delegates by CLAIMING them to `running`
 * (non-terminal), mirroring {@link consumePendingDelegates}. The row is NOT
 * finished here: terminalization waits for {@link finalizeStagedPostCompactionDelegates}
 * after the caller has durably handed the delegate off (session-delivery row
 * enqueued or re-staged). A crash between claim and handoff therefore leaves a
 * recoverable `running` row — {@link listRecoverableStagedPostCompactionDelegates}
 * surfaces it for startup re-dispatch — instead of silently losing the staged
 * work behind a premature `finished` (#1144/#1158).
 *
 * At-least-once on the crash-recovery seam is intentional: a duplicate
 * post-compaction shard is far cheaper than a dropped one.
 */
export function consumeStagedPostCompactionDelegates(
  sessionKey: string,
  options: { claimFor?: "release" | "next-seam-persist" } = {},
): PendingContinuationDelegate[] {
  const delegates: PendingContinuationDelegate[] = [];

  for (const flow of listQueuedPostCompactionFlows(sessionKey)) {
    const state = decodeDelegateState(flow);
    if (!state) {
      // Mirror the pending-path breadcrumb on the post-compaction consume lane.
      // Same schema-drift risk, same
      // dropped-work consequence.
      log.warn(
        `[continuation:post-compaction-decode-failed] flowId=${flow.flowId} session=${sessionKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`,
      );
      failFlow({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        currentStep: "Rejected invalid post-compaction payload",
        blockedSummary: "Staged post-compaction delegate payload could not be decoded.",
      });
      continue;
    }

    const releasedAt = Date.now();
    const claimForNextSeamPersist = options.claimFor === "next-seam-persist";
    const claimed = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "running",
        currentStep: claimForNextSeamPersist
          ? "Persisting staged delegate for next compaction seam"
          : "Released after compaction — awaiting durable handoff",
        stateJson: {
          ...state,
          releasedAt,
          ...(claimForNextSeamPersist ? { awaitingNextCompaction: true } : {}),
        },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        endedAt: null,
        updatedAt: releasedAt,
      },
    });
    if (!claimed.applied || !claimed.flow) {
      continue;
    }

    delegates.push(flowToDelegate(claimed.flow, { ...state, releasedAt }));
  }

  return delegates;
}

/**
 * Finalize (finish) the specific post-compaction rows a caller claimed via
 * {@link consumeStagedPostCompactionDelegates}, once their durable handoff
 * succeeded. Finalizes ONLY the passed flow ids and only while they are still
 * `running` — so a row claimed by another path, or left `running` by a crash
 * (awaiting {@link listRecoverableStagedPostCompactionDelegates}), is never
 * terminalized out from under its owner (#1144). Returns the number of rows finalized.
 */
export function finalizeStagedPostCompactionDelegates(
  flowIds: readonly (string | undefined)[],
): number {
  let finalized = 0;
  for (const flowId of flowIds) {
    if (!flowId) {
      continue;
    }
    const flow = getTaskFlowById(flowId);
    if (!flow || !isPostCompactionDelegateFlow(flow) || flow.status !== "running") {
      continue;
    }
    const state = decodeDelegateState(flow);
    const now = Date.now();
    const finished = finishFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: "Durably handed off after compaction",
      stateJson: { ...(state ?? { kind: "continuation_delegate", task: "" }), releasedAt: now },
      updatedAt: now,
      endedAt: now,
    });
    if (finished.applied) {
      finalized += 1;
    }
  }
  return finalized;
}

export function assertStagedPostCompactionFinalizationComplete(params: {
  flowIds: readonly (string | undefined)[];
  finalized: number;
  context: string;
}): void {
  const expected = params.flowIds.filter(
    (flowId): flowId is string => typeof flowId === "string" && flowId.length > 0,
  ).length;
  if (params.finalized === expected) {
    return;
  }
  throw new Error(
    `[continuation:post-compaction-finalize-incomplete] ${params.context}: finalized ${params.finalized}/${expected} claimed row(s)`,
  );
}

/**
 * List post-compaction rows left `running` by a crash between release-claim and
 * durable handoff (#1144/#1158), so startup recovery can re-drive them to
 * delivery WITHOUT waiting for another compaction seam. Returns the claimed
 * delegates (with their `flowId` handle) grouped by owner session key and does
 * NOT mutate row status — the recovery dispatcher finalizes only the rows whose
 * spawn is accepted, leaving a failed row `running` and recoverable on the next
 * restart. Queued (never-released, awaiting-seam) rows are intentionally
 * excluded: releasing them here would fire a rehydration delegate before the
 * compaction it was staged for actually happened.
 */
export function listRecoverableStagedPostCompactionDelegates(options?: {
  /**
   * Only include rows last updated at or before this cutoff. Startup recovery
   * passes a boot-time cutoff so a post-compaction release that claims a row to
   * `running` AFTER this process started (live traffic) is left to the live
   * release/finalize path, not re-driven by restart recovery (duplicate work).
   */
  runningUpdatedAtOrBefore?: number;
}): Array<{ sessionKey: string; delegate: PendingContinuationDelegate }> {
  const recoverable: Array<{ sessionKey: string; delegate: PendingContinuationDelegate }> = [];
  for (const flow of listTaskFlowRecords()) {
    if (!isPostCompactionDelegateFlow(flow) || flow.status !== "running") {
      continue;
    }
    if (
      options?.runningUpdatedAtOrBefore !== undefined &&
      flow.updatedAt > options.runningUpdatedAtOrBefore
    ) {
      continue;
    }
    const state = decodeDelegateState(flow);
    if (!state) {
      log.warn(
        `[continuation:post-compaction-recover-decode-failed] flowId=${flow.flowId} owner=${flow.ownerKey} raw=${JSON.stringify(flow.stateJson).slice(0, 200)}`,
      );
      continue;
    }
    if (state.awaitingNextCompaction === true) {
      continue;
    }
    recoverable.push({ sessionKey: flow.ownerKey, delegate: flowToDelegate(flow, state) });
  }
  return recoverable;
}

export function stagedPostCompactionDelegateCount(sessionKey: string): number {
  return listQueuedPostCompactionFlows(sessionKey).length;
}

// ---------------------------------------------------------------------------
// Continue-work request store intentionally stays absent: tool-based
// `continue_work` flows through the closure requestContinuation callback in
// agent-runner-execution.ts, then surfaces on the run outcome. Keeping this
// path single-sourced prevents a future side-channel Map from drifting.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetDelegateStoreForTests(): void {
  continuationQueueDiagnosticsLastSampleAt = undefined;
  continuationQueueDiagnosticsHistory.length = 0;
}
