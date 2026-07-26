import { z } from "zod";
import {
  DIAGNOSTIC_TRACEPARENT_PATTERN,
  normalizeDiagnosticTraceparent,
} from "../../infra/diagnostic-trace-context.js";
import { registerDiagnosticContinuationQueueMetricsProvider } from "../../logging/diagnostic-continuation-queues.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  validateInlineAttachmentSnapshots,
  parseInlineAttachmentMountPath,
} from "../../shared/inline-attachments.js";
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
import type { JsonValue } from "../../tasks/task-registry.types.js";
import { createContinuationQueueDiagnostics } from "./delegate-flow-diagnostics.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting.js";
import type { ChainState, PendingContinuationDelegate } from "./types.js";

const log = createSubsystemLogger("continuation/delegate-store");

export const CONTINUATION_DELEGATE_CONTROLLER_ID = "core/continuation-delegate";
export const CONTINUATION_POST_COMPACTION_CONTROLLER_ID = "core/continuation-post-compaction";

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

const InlineAttachmentStateSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    mimeType: z.string().optional(),
  })
  .strict();

const InlineAttachmentMountStateSchema = z
  .object({
    mountPath: z.string().optional(),
  })
  .strict()
  .transform((mount, ctx) => {
    const parsed = parseInlineAttachmentMountPath(mount.mountPath);
    if (parsed.status === "invalid") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachAs.mountPath contains unsupported characters",
      });
      return z.NEVER;
    }
    return parsed.status === "valid" ? { mountPath: parsed.mountPath } : undefined;
  });

const PendingDelegateStateSchema = z
  .object({
    kind: z.literal("continuation_delegate"),
    task: z.string().min(1),
    delayMs: z.number().int().nonnegative().optional(),
    silent: z.boolean().optional(),
    silentWake: z.boolean().optional(),
    postCompaction: z.boolean().optional(),
    firstArmedAt: z.number().int().nonnegative().optional(),
    attachments: z
      .array(InlineAttachmentStateSchema)
      .max(50)
      .transform((attachments) => (attachments.length > 0 ? attachments : undefined))
      .optional(),
    attachAs: InlineAttachmentMountStateSchema.optional(),
    targetSessionKey: z.string().min(1).optional(),
    targetSessionKeys: z.array(z.string().min(1)).optional(),
    fanoutMode: z.enum(CONTINUATION_DELEGATE_FANOUT_MODES).optional(),
    returnOptions: z
      .object({
        artifacts: z.enum(["forbidden", "optional", "required"]).optional(),
      })
      .strict()
      .optional(),
    recipientContext: z
      .object({
        purpose: z.string().trim().min(1).max(1024),
      })
      .strict()
      .optional(),
    traceparent: TraceparentStateSchema,
    traceparentProvenance: z.literal("internal").optional(),
    model: z.string().min(1).optional(),
    releasedAt: z.number().int().nonnegative().optional(),
    childSessionKey: z.string().min(1).optional(),
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
    inheritedSilent: z.boolean().optional(),
    inheritedWake: z.boolean().optional(),
    spawnRequesterSessionKey: z.string().min(1).optional(),
    spawnRequesterChannel: z.string().min(1).optional(),
    spawnRequesterAccountId: z.string().min(1).optional(),
    spawnRequesterTo: z.string().min(1).optional(),
    spawnRequesterThreadId: z.union([z.string().min(1), z.number()]).optional(),
    awaitingNextCompaction: z.boolean().optional(),
  })
  .strict()
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
    if (validateInlineAttachmentSnapshots({ attachments: state.attachments })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message: "invalid inline attachment snapshot",
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

export type PendingDelegateCutoffOptions = {
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

type DelegateStateChanges = {
  releasedAt?: number | null;
  childSessionKey?: string | null;
  chainTokensFold?: number | null;
  persistedChainState?: ChainState | null;
  persistedChainStateKind?: "advanced" | "terminal" | null;
  inheritedSilent?: true;
  inheritedWake?: true;
  awaitingNextCompaction?: true | null;
};

function delegateGoal(delegate: PendingContinuationDelegate): string {
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

function encodeDelegateState(delegate: PendingContinuationDelegate): PendingDelegateState {
  const targetSessionKey = normalizeContinuationTargetKey(delegate.targetSessionKey);
  const targetSessionKeys = normalizeContinuationTargetKeys(delegate.targetSessionKeys);
  const traceparent = normalizeDiagnosticTraceparent(delegate.traceparent);
  const parsedMountPath = parseInlineAttachmentMountPath(delegate.attachAs?.mountPath);
  if (parsedMountPath.status === "invalid") {
    throw new Error("invalid continuation delegate attachment mount path");
  }
  const attachAs =
    delegate.attachments?.length && parsedMountPath.status === "valid"
      ? { mountPath: parsedMountPath.mountPath }
      : undefined;
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
    ...(delegate.attachments && delegate.attachments.length > 0
      ? { attachments: delegate.attachments }
      : {}),
    ...(attachAs ? { attachAs } : {}),
    ...(targetSessionKey ? { targetSessionKey } : {}),
    ...(targetSessionKeys.length > 0 ? { targetSessionKeys } : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.returnOptions ? { returnOptions: delegate.returnOptions } : {}),
    ...(delegate.recipientContext ? { recipientContext: delegate.recipientContext } : {}),
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

function applyDelegateStateChanges(
  state: PendingDelegateState,
  changes: DelegateStateChanges = {},
): PendingDelegateState {
  const next = { ...state };
  for (const key of [
    "releasedAt",
    "childSessionKey",
    "chainTokensFold",
    "persistedChainState",
    "persistedChainStateKind",
    "inheritedSilent",
    "inheritedWake",
    "awaitingNextCompaction",
  ] as const) {
    const value = changes[key];
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      Object.assign(next, { [key]: value });
    }
  }
  return next;
}

function resolveUpdatedDelegateState(params: {
  flowId: string;
  fallbackDelegate?: PendingContinuationDelegate;
  changes?: DelegateStateChanges;
}): PendingDelegateState | undefined {
  const current = getTaskFlowById(params.flowId);
  const state =
    (current ? decodeDelegateState(current) : undefined) ??
    (params.fallbackDelegate ? encodeDelegateState(params.fallbackDelegate) : undefined);
  return state ? applyDelegateStateChanges(state, params.changes) : undefined;
}

function scrubStoredDelegateAttachmentState(
  stateJson: JsonValue | null | undefined,
): JsonValue | null | undefined {
  if (stateJson === undefined || stateJson === null) {
    return stateJson;
  }
  if (typeof stateJson !== "object" || Array.isArray(stateJson)) {
    return {};
  }
  const scrubbed = { ...stateJson };
  delete scrubbed.attachments;
  delete scrubbed.attachAs;
  return scrubbed;
}

function decodeDelegateState(flow: TaskFlowRecord): PendingDelegateState | undefined {
  const parsed = PendingDelegateStateSchema.safeParse(flow.stateJson);
  return parsed.success ? parsed.data : undefined;
}

export function decodeDelegateFlow(flow: TaskFlowRecord): PendingContinuationDelegate | undefined {
  const state = decodeDelegateState(flow);
  if (!state) {
    return undefined;
  }
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
    ...(state.attachments ? { attachments: state.attachments } : {}),
    ...(state.attachAs ? { attachAs: state.attachAs } : {}),
    ...(state.targetSessionKey ? { targetSessionKey: state.targetSessionKey } : {}),
    ...(state.targetSessionKeys && state.targetSessionKeys.length > 0
      ? { targetSessionKeys: state.targetSessionKeys }
      : {}),
    ...(state.fanoutMode ? { fanoutMode: state.fanoutMode } : {}),
    ...(state.returnOptions ? { returnOptions: state.returnOptions } : {}),
    ...(state.recipientContext ? { recipientContext: state.recipientContext } : {}),
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

export function isPendingDelegateFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === CONTINUATION_DELEGATE_CONTROLLER_ID;
}

export function isPostCompactionDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    flow.syncMode === "managed" && flow.controllerId === CONTINUATION_POST_COMPACTION_CONTROLLER_ID
  );
}

export function isContinuationDelegateFlow(flow: TaskFlowRecord): boolean {
  return isPendingDelegateFlow(flow) || isPostCompactionDelegateFlow(flow);
}

export function isTerminalDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    isContinuationDelegateFlow(flow) &&
    (flow.status === "succeeded" ||
      flow.status === "blocked" ||
      flow.status === "failed" ||
      flow.status === "cancelled" ||
      flow.status === "lost")
  );
}

export function isSucceededDelegateFlow(flow: TaskFlowRecord): boolean {
  return isContinuationDelegateFlow(flow) && flow.status === "succeeded";
}

export function isRecoverablePendingFlow(flow: TaskFlowRecord): boolean {
  return isPendingDelegateFlow(flow) && (flow.status === "queued" || flow.status === "running");
}

export function isRecoverableContinuationDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    isContinuationDelegateFlow(flow) && (flow.status === "queued" || flow.status === "running")
  );
}

export function isRecoverablePendingFlowWithinCutoffs(
  flow: TaskFlowRecord,
  options: PendingDelegateCutoffOptions = {},
): boolean {
  if (!isPendingDelegateFlow(flow)) {
    return false;
  }
  if (flow.status === "queued") {
    return (
      options.queuedCreatedAtOrBefore === undefined ||
      flow.createdAt <= options.queuedCreatedAtOrBefore
    );
  }
  if (flow.status !== "running" || options.includeRunning !== true) {
    return false;
  }
  return (
    options.includeRunningUpdatedAtOrBefore === undefined ||
    flow.updatedAt <= options.includeRunningUpdatedAtOrBefore
  );
}

export function listRecoverablePendingFlows(
  sessionKey: string,
  options: PendingDelegateCutoffOptions = {},
): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isRecoverablePendingFlowWithinCutoffs(flow, options))
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

export function listQueuedPendingFlows(sessionKey: string): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isPendingDelegateFlow(flow) && flow.status === "queued")
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

export function listQueuedPostCompactionFlows(sessionKey: string): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter((flow) => isPostCompactionDelegateFlow(flow) && flow.status === "queued")
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

export function delegateDueAt(flow: TaskFlowRecord, delegate: PendingContinuationDelegate): number {
  return flow.createdAt + (delegate.delayMs ?? 0);
}

export function isAwaitingNextCompactionDelegateFlow(flow: TaskFlowRecord): boolean {
  return decodeDelegateState(flow)?.awaitingNextCompaction === true;
}

type DelegateFlowPatch = {
  status?: TaskFlowRecord["status"];
  currentStep?: string;
  waitJson?: null;
  blockedTaskId?: null;
  blockedSummary?: string | null;
  endedAt?: number | null;
  updatedAt?: number;
};

export const delegateFlowRecords = {
  create(params: {
    ownerKey: string;
    controller: "pending" | "post-compaction";
    delegate: PendingContinuationDelegate;
    currentStep: string;
  }) {
    return createManagedTaskFlow({
      ownerKey: params.ownerKey,
      controllerId:
        params.controller === "post-compaction"
          ? CONTINUATION_POST_COMPACTION_CONTROLLER_ID
          : CONTINUATION_DELEGATE_CONTROLLER_ID,
      notifyPolicy: "silent",
      goal: delegateGoal(params.delegate),
      currentStep: params.currentStep,
      stateJson: encodeDelegateState(params.delegate),
    });
  },
  update(params: {
    flowId: string;
    expectedRevision: number;
    fallbackDelegate?: PendingContinuationDelegate;
    changes?: DelegateStateChanges;
    patch: DelegateFlowPatch;
  }) {
    const state = resolveUpdatedDelegateState(params);
    if (!state) {
      return {
        applied: false as const,
        reason: "not_found" as const,
        current: undefined,
      };
    }
    return updateFlowRecordByIdExpectedRevision({
      flowId: params.flowId,
      expectedRevision: params.expectedRevision,
      patch: {
        ...params.patch,
        stateJson: state,
      },
    });
  },
  finish(params: {
    flowId: string;
    expectedRevision: number;
    fallbackDelegate?: PendingContinuationDelegate;
    changes?: DelegateStateChanges;
    currentStep: string;
    updatedAt?: number;
    endedAt?: number;
  }) {
    const state = resolveUpdatedDelegateState(params);
    if (!state) {
      return {
        applied: false as const,
        reason: "not_found" as const,
        current: undefined,
      };
    }
    return finishFlow({
      flowId: params.flowId,
      expectedRevision: params.expectedRevision,
      currentStep: params.currentStep,
      stateJson: scrubStoredDelegateAttachmentState(state),
      updatedAt: params.updatedAt,
      endedAt: params.endedAt,
    });
  },
  fail(params: Parameters<typeof failFlow>[0]) {
    const current = getTaskFlowById(params.flowId);
    const stateJson = params.stateJson !== undefined ? params.stateJson : current?.stateJson;
    return failFlow({
      ...params,
      ...(stateJson !== undefined
        ? { stateJson: scrubStoredDelegateAttachmentState(stateJson) }
        : {}),
    });
  },
  get: getTaskFlowById,
  listAll: listTaskFlowRecords,
  listForOwner: listTaskFlowsForOwnerKey,
  delete: deleteTaskFlowRecordById,
};

function describeStoredDelegateState(stateJson: unknown): string {
  if (!stateJson || typeof stateJson !== "object" || Array.isArray(stateJson)) {
    return `stateType=${Array.isArray(stateJson) ? "array" : typeof stateJson}`;
  }
  return `stateType=object keyCount=${Object.keys(stateJson as Record<string, unknown>).length}`;
}

export function rejectCorruptDelegateFlow(
  flow: TaskFlowRecord,
  options: { kind: "pending" | "post-compaction"; sessionKey: string },
): void {
  const isPostCompaction = options.kind === "post-compaction";
  const tag = isPostCompaction
    ? "continuation:post-compaction-decode-failed"
    : "continuation:delegate-decode-failed";
  log.warn(
    `[${tag}] flowId=${flow.flowId} session=${options.sessionKey} ${describeStoredDelegateState(flow.stateJson)}`,
  );
  delegateFlowRecords.fail({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    stateJson: {},
    currentStep: isPostCompaction
      ? "Rejected invalid post-compaction payload"
      : "Rejected invalid continuation payload",
    blockedSummary: isPostCompaction
      ? "Staged post-compaction delegate payload could not be decoded."
      : "Pending continuation delegate payload could not be decoded.",
  });
}

export function warnCorruptRecoverablePostCompactionFlow(flow: TaskFlowRecord): void {
  log.warn(
    `[continuation:post-compaction-recover-decode-failed] flowId=${flow.flowId} owner=${flow.ownerKey} ${describeStoredDelegateState(flow.stateJson)}`,
  );
}

const continuationQueueDiagnostics = createContinuationQueueDiagnostics({
  listFlows: listTaskFlowRecords,
  isContinuationDelegateFlow,
  isPostCompactionDelegateFlow,
  decodeDelegateFlow,
  delegateDueAt,
});

registerDiagnosticContinuationQueueMetricsProvider(continuationQueueDiagnostics.sample);

export function getContinuationDelegateQueueDepths(
  sessionKey: string,
  now = Date.now(),
): ContinuationDelegateQueueDepths {
  const pendingFlows = listQueuedPendingFlows(sessionKey);
  let pendingRunnable = 0;
  for (const flow of pendingFlows) {
    const delegate = decodeDelegateFlow(flow);
    if (delegate && delegateDueAt(flow, delegate) <= now) {
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

export function resetDelegateFlowDiagnosticsForTests(): void {
  continuationQueueDiagnostics.reset();
}
