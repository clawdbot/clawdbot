import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithAbortWrappedToolSettlements } from "./agent-tools.abort.js";
import {
  beginCodeModeBridgeActivity,
  beginCodeModeSnapshotActivity,
  type CodeModeActivityOwner,
} from "./code-mode-activity.js";
import { CODE_MODE_CONVERSATIONS_LIST_TOOL_ID, runBridgeRequest } from "./code-mode-bridge.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import type { CodeModeToolContext } from "./code-mode-execution-policy.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { CodeModePrivateAuthority } from "./code-mode-private-authority.js";
import {
  enforceSnapshotPayloadLimits,
  type CodeModeConfig,
  type CodeModeSettlementMode,
  type PendingBridgeRequest,
  type SettledBridgeRequest,
} from "./code-mode-runtime.js";
import {
  recordCodeModeBridgeCancelRequested,
  recordCodeModeBridgeCancelledBeforeStart,
  recordCodeModeBridgeRegistered,
  recordCodeModeBridgeSettled,
  recordCodeModeBridgeStarted,
  type CodeModeStats,
} from "./code-mode-stats.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { ToolSearchRuntime } from "./tool-search.js";
import { ToolInputError } from "./tools/common.js";

export type PendingBridgeState = PendingBridgeRequest & {
  conversationList: boolean;
  promise: Promise<SettledBridgeRequest>;
  settled?: SettledBridgeRequest;
  settledSequence?: number;
  cancel?: () => void;
};

type BridgeDispatchEntry = {
  status: "queued" | "active" | "settled";
  id: string;
  cancelRequested: boolean;
  start: () => Promise<SettledBridgeRequest>;
  cancelActive: () => void;
  settleVisible: (result: SettledBridgeRequest) => void;
  settlePhysical: (result: SettledBridgeRequest) => void;
};

/** Bound host execution without limiting how many bridge promises the guest may register. */
export class CodeModeBridgeDispatchQueue {
  readonly #maxConcurrent: number;
  readonly #queued: BridgeDispatchEntry[] = [];
  readonly #stats?: CodeModeStats;
  readonly #activityOwner?: CodeModeActivityOwner;
  #active = 0;

  constructor(maxConcurrent: number, stats?: CodeModeStats, activityOwner?: CodeModeActivityOwner) {
    this.#maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.#stats = stats;
    this.#activityOwner = activityOwner;
  }

  enqueue(params: {
    id: string;
    method: PendingBridgeRequest["method"];
    start: () => Promise<SettledBridgeRequest>;
    cancelActive: () => void;
    signal?: AbortSignal;
  }): {
    promise: Promise<SettledBridgeRequest>;
    cancel: () => void;
  } {
    let resolvePromise: (result: SettledBridgeRequest) => void = () => {};
    const promise = new Promise<SettledBridgeRequest>((resolve) => {
      resolvePromise = resolve;
    });
    const entry: BridgeDispatchEntry = {
      id: params.id,
      status: "queued",
      cancelRequested: false,
      start: params.start,
      cancelActive: params.cancelActive,
      settleVisible: () => {},
      settlePhysical: () => {},
    };
    const releaseActivity = beginCodeModeBridgeActivity(this.#activityOwner);
    const onAbort = () => cancel();
    let visibleSettled = false;
    entry.settleVisible = (result) => {
      if (visibleSettled) {
        return;
      }
      visibleSettled = true;
      resolvePromise(result);
    };
    entry.settlePhysical = (result) => {
      if (entry.status === "settled") {
        return;
      }
      const wasActive = entry.status === "active";
      entry.status = "settled";
      releaseActivity();
      params.signal?.removeEventListener("abort", onAbort);
      recordCodeModeBridgeSettled(this.#stats, {
        failed: !result.ok && !entry.cancelRequested,
        settledAfterCancel: wasActive && entry.cancelRequested,
      });
      entry.settleVisible(entry.cancelRequested ? cancelledBridgeRequest(params.id) : result);
      if (wasActive) {
        this.#active = Math.max(0, this.#active - 1);
        this.#pump();
      }
    };
    const cancel = () => {
      if (entry.status === "settled" || entry.cancelRequested) {
        return;
      }
      entry.cancelRequested = true;
      recordCodeModeBridgeCancelRequested(this.#stats);
      if (entry.status === "queued") {
        recordCodeModeBridgeCancelledBeforeStart(this.#stats);
        const index = this.#queued.indexOf(entry);
        if (index >= 0) {
          this.#queued.splice(index, 1);
        }
        const cancelled = cancelledBridgeRequest(params.id);
        entry.settleVisible(cancelled);
        entry.settlePhysical(cancelled);
      } else if (entry.status === "active") {
        entry.cancelActive();
        entry.settleVisible(cancelledBridgeRequest(params.id));
      }
    };
    recordCodeModeBridgeRegistered(this.#stats, params.method);
    if (params.signal?.aborted) {
      cancel();
    } else {
      params.signal?.addEventListener("abort", onAbort, { once: true });
      this.#queued.push(entry);
      this.#pump();
    }
    return { promise, cancel };
  }

  #pump(): void {
    while (this.#active < this.#maxConcurrent) {
      const entry = this.#queued.shift();
      if (!entry) {
        return;
      }
      entry.status = "active";
      this.#active += 1;
      recordCodeModeBridgeStarted(this.#stats);
      try {
        void runWithAbortWrappedToolSettlements(entry.start).then(
          (result) => entry.settlePhysical(result),
          () => entry.settlePhysical(cancelledBridgeRequest(entry.id)),
        );
      } catch {
        entry.settlePhysical(cancelledBridgeRequest(entry.id));
      }
    }
  }
}

function cancelledBridgeRequest(id: string): SettledBridgeRequest {
  return { id, ok: false, error: "code mode bridge call cancelled" };
}
type CodeModeRunState = {
  runId: string;
  replayId: string;
  parentToolCallId: string;
  ctx: CodeModeToolContext;
  activityOwner: CodeModeActivityOwner;
  config: CodeModeConfig;
  bridgeDispatchQueue: CodeModeBridgeDispatchQueue;
  privateAuthority: CodeModePrivateAuthority;
  snapshotBytes: Uint8Array;
  pending: PendingBridgeState[];
  settlementMode: CodeModeSettlementMode;
  // Host recovery policy persists across wait calls independently of evidence.
  enforceReplaySafeTools: boolean;
  // Monotonic host-observed fact: once false, later safe calls cannot restore it.
  replaySafe: boolean;
  output: unknown[];
  // Retain all output for cumulative limits, but never replay blocks already returned to the model.
  deliveredOutputCount: number;
  expiresAt: number;
  agentWaitRetainUntil?: number;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  codeModeStats?: CodeModeStats;
  releaseSnapshotActivity?: () => void;
};

const MAX_ACTIVE_CODE_MODE_RUNS = 64;
const MAX_AGENT_WAIT_SNAPSHOT_TTL_WINDOWS = 4;

export const activeRuns = new Map<string, CodeModeRunState>();
export const resumingRunIds = new Set<string>();
let activeRunReservations = 0;
let nextPendingBridgeSettlementSequence = 0;
let activeRunExpiryTimer: ReturnType<typeof setTimeout> | undefined;

// One unreferenced timer owns parked snapshots even when no later exec or wait
// arrives; otherwise expired runs keep their VM bytes and live tool calls.
function scheduleActiveRunExpiry(): void {
  if (activeRunExpiryTimer) {
    clearTimeout(activeRunExpiryTimer);
    activeRunExpiryTimer = undefined;
  }
  let nextExpiresAt = Number.POSITIVE_INFINITY;
  for (const state of activeRuns.values()) {
    nextExpiresAt = Math.min(nextExpiresAt, state.expiresAt);
  }
  if (!Number.isFinite(nextExpiresAt)) {
    return;
  }
  activeRunExpiryTimer = setTimeout(
    () => {
      activeRunExpiryTimer = undefined;
      removeExpiredRuns();
      scheduleActiveRunExpiry();
    },
    Math.max(1, nextExpiresAt - Date.now()),
  );
  activeRunExpiryTimer.unref?.();
}

export function removeExpiredRuns(now = Date.now()): void {
  for (const [runId, state] of activeRuns) {
    if (!isFutureDateTimestampMs(state.expiresAt, { nowMs: now })) {
      // Parked collectors extend idle TTL, bounded so a lost terminal event cannot pin all slots.
      if (
        state.pending?.some((entry) => entry.method === "agentWait" && !entry.settled) &&
        state.agentWaitRetainUntil !== undefined &&
        isFutureDateTimestampMs(state.agentWaitRetainUntil, { nowMs: now })
      ) {
        const renewed = resolveCodeModeSnapshotExpiresAt(now, state.config.snapshotTtlSeconds);
        if (renewed !== undefined) {
          state.expiresAt = Math.min(renewed, state.agentWaitRetainUntil);
          continue;
        }
      }
      disposeCodeModeRun(runId);
    }
  }
}

export function disposeCodeModeRun(runId: string): void {
  const state = activeRuns.get(runId);
  state?.privateAuthority?.revoke();
  cancelPendingBridgeStates(state?.pending ?? []);
  if (activeRuns.delete(runId)) {
    state?.releaseSnapshotActivity?.();
  }
  resumingRunIds.delete(runId);
  scheduleActiveRunExpiry();
}

/** Dispose only parked runs owned by one command accounting lifecycle. */
export function disposeCodeModeRunsByActivityOwner(owner: CodeModeActivityOwner | undefined): void {
  if (!owner) {
    return;
  }
  const ownedRunIds = Array.from(activeRuns.entries())
    .filter(([, state]) => state.activityOwner === owner)
    .map(([runId]) => runId);
  for (const runId of ownedRunIds) {
    disposeCodeModeRun(runId);
  }
}

/** Cancel suspended bridge work before its Gateway-owned runtimes disappear. */
export function disposeAllCodeModeRuns(): void {
  activeRuns.forEach((state) => {
    state.privateAuthority?.revoke();
    cancelPendingBridgeStates(state.pending);
    state.releaseSnapshotActivity?.();
  });
  activeRuns.clear();
  resumingRunIds.clear();
  scheduleActiveRunExpiry();
}

/** Advance the snapshot frontier before exposing output to a wait observer. */
export function takeUndeliveredCodeModeRunOutput(state: CodeModeRunState): unknown[] {
  const output = state.output.slice(state.deliveredOutputCount);
  state.deliveredOutputCount = state.output.length;
  return output;
}

/** Abort each bridge call whose result has not already reached its guest. */
export function cancelPendingBridgeStates(pending: readonly PendingBridgeState[]): void {
  for (const entry of pending) {
    if (!entry.settled) {
      entry.cancel?.();
    }
  }
}

/** Deliver bridge responses in actual settlement order, not request order. */
export function settledBridgeRequestsInCompletionOrder(
  pending: readonly PendingBridgeState[],
  privateAuthority?: CodeModePrivateAuthority,
): SettledBridgeRequest[] {
  const delivered = pending
    .filter((entry) => entry.settled !== undefined)
    .toSorted((left, right) => (left.settledSequence ?? 0) - (right.settledSequence ?? 0));
  privateAuthority?.deliverBridgeSettlements(
    delivered.map((entry) => ({
      id: entry.id,
      ...(entry.conversationList
        ? {
            conversationListResult:
              entry.settled?.ok === true
                ? entry.method === "callValue"
                  ? entry.settled.value
                  : isRecord(entry.settled.value) &&
                      isRecord(entry.settled.value.result) &&
                      "details" in entry.settled.value.result
                    ? entry.settled.value.result.details
                    : undefined
                : undefined,
          }
        : {}),
    })),
  );
  return delivered.flatMap((entry) => (entry.settled ? [entry.settled] : []));
}

/** Keep every dispatched bridge call required until its guest has received the result. */
export function pendingBridgeStatesForSettlement(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
): readonly PendingBridgeState[] {
  if (settlementMode.kind === "awaiting") {
    return pending;
  }
  const requiredRequestIds = new Set(settlementMode.requiredRequestIds);
  return pending.filter((entry) => requiredRequestIds.has(entry.id));
}

/** Await the shared guest frontier without guessing native Promise ownership. */
export function waitForPendingBridgeSettlement(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
): Promise<void> {
  const required = pendingBridgeStatesForSettlement(pending, settlementMode);
  const outstanding = required.filter((entry) => !entry.settled);
  // Workers reject hostless pending guests; headless execution also validates
  // the frontier before reaching this shared settlement helper.
  if (
    outstanding.length === 0 ||
    (settlementMode.kind === "awaiting" && outstanding.length !== required.length)
  ) {
    return Promise.resolve();
  }
  const settlement =
    settlementMode.kind === "draining"
      ? Promise.all(outstanding.map((entry) => entry.promise))
      : Promise.race(outstanding.map((entry) => entry.promise));
  return settlement.then(() => undefined);
}

function resolveCodeModeSnapshotExpiresAt(now: number, ttlSeconds: number): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(ttlSeconds, { nowMs: now });
}

function enforceActiveRunLimit(): void {
  removeExpiredRuns();
  if (activeRuns.size + activeRunReservations >= MAX_ACTIVE_CODE_MODE_RUNS) {
    throw new ToolInputError("too many suspended code mode runs.");
  }
}

export function reserveActiveRunSlot(ownedRunId?: string): () => void {
  if (ownedRunId === undefined) {
    enforceActiveRunLimit();
  } else {
    const ownedState = activeRuns.get(ownedRunId);
    if (!ownedState || !activeRuns.delete(ownedRunId)) {
      throw new ToolInputError("code mode run is unavailable or expired.");
    }
    ownedState.releaseSnapshotActivity?.();
  }
  // Resume transfers an existing slot without exposing a free capacity window
  // to concurrent exec calls or rejecting its own run at the global limit.
  activeRunReservations += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeRunReservations = Math.max(0, activeRunReservations - 1);
  };
}

export function snapshotState(params: {
  pendingRequests: PendingBridgeRequest[];
  snapshotBytes: Uint8Array;
  parentToolCallId: string;
  codeModeReplayId: string;
  ctx: CodeModeToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  privateAuthority: CodeModePrivateAuthority;
  output: unknown[];
  deliveredOutputCount?: number;
  reservedActiveRunSlot?: boolean;
  enforceReplaySafeTools: boolean;
  replaySafe: boolean;
  settlementMode: CodeModeSettlementMode;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  bridgeDispatchQueue?: CodeModeBridgeDispatchQueue;
  codeModeStats?: CodeModeStats;
}) {
  enforceSnapshotStateLimits(params);
  const runId = `cm_${randomUUID()}`;
  const bridgeDispatchQueue =
    params.bridgeDispatchQueue ??
    new CodeModeBridgeDispatchQueue(
      params.config.maxPendingToolCalls,
      params.codeModeStats,
      params.ctx.codeModeActivityOwner,
    );
  const pending = createPendingBridgeStates({
    ...params,
    activeRunId: runId,
    codeModeRunId: params.codeModeReplayId,
    bridgeDispatchQueue,
  });
  try {
    return storeSnapshotState({
      ...params,
      runId,
      replayId: params.codeModeReplayId,
      pending,
      bridgeDispatchQueue,
      replaySafe:
        params.replaySafe &&
        pendingBridgeRequestsReplaySafe(params.pendingRequests, params.runtime),
    });
  } catch (error) {
    cancelPendingBridgeStates(pending);
    throw error;
  }
}

export function pendingBridgeRequestsReplaySafe(
  pending: readonly PendingBridgeRequest[],
  runtime: ToolSearchRuntime,
): boolean {
  return pending.every((request) => {
    if (
      request.method === "search" ||
      request.method === "describe" ||
      request.method === "yield" ||
      request.method === "agentWait" ||
      request.method === "skillsList" ||
      request.method === "skillsRead"
    ) {
      return true;
    }
    if (request.method !== "call" && request.method !== "callValue") {
      return false;
    }
    const id = Array.isArray(request.args) ? request.args[0] : undefined;
    return typeof id === "string" && runtime.isReplaySafeExactId(id);
  });
}

function enforceSnapshotStateLimits(params: {
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
  output: unknown[];
  reservedActiveRunSlot?: boolean;
}) {
  if (!params.reservedActiveRunSlot) {
    enforceActiveRunLimit();
  }
  enforceSnapshotPayloadLimits(params);
}

export function createPendingBridgeStates(params: {
  pendingRequests: PendingBridgeRequest[];
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  parentToolCallId: string;
  codeModeRunId: string;
  activeRunId?: string;
  ctx: CodeModeToolContext;
  privateAuthority: CodeModePrivateAuthority;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  bridgeDispatchQueue: CodeModeBridgeDispatchQueue;
}): PendingBridgeState[] {
  const prepared = params.pendingRequests.map((request) => {
    const rawTarget =
      request.method === "call" || request.method === "callValue" ? request.args[0] : null;
    let resolvedTarget: string | undefined;
    if (typeof rawTarget === "string") {
      try {
        resolvedTarget = params.runtime.resolveCallTargetId(rawTarget, {
          includeMcp: false,
          recoverySurface: "tools",
        });
      } catch {
        // The real call retains lookup-error ownership; this pass only classifies authority.
      }
    }
    return {
      request,
      conversationListIntent:
        rawTarget === "conversations_list" ||
        rawTarget === CODE_MODE_CONVERSATIONS_LIST_TOOL_ID ||
        resolvedTarget === CODE_MODE_CONVERSATIONS_LIST_TOOL_ID,
      conversationListEligible: resolvedTarget === CODE_MODE_CONVERSATIONS_LIST_TOOL_ID,
    };
  });
  params.privateAuthority.beginBridgeFrontier(
    prepared.map(({ request, conversationListIntent, conversationListEligible }) => ({
      id: request.id,
      conversationListIntent,
      conversationListEligible,
    })),
  );
  return prepared.map(({ request, conversationListEligible }) => {
    const abortController = new AbortController();
    const signal = params.signal
      ? AbortSignal.any([params.signal, abortController.signal])
      : abortController.signal;
    const scheduled = params.bridgeDispatchQueue.enqueue({
      id: request.id,
      method: request.method,
      start: () =>
        runBridgeRequest({
          runtime: params.runtime,
          namespaceRuntime: params.namespaceRuntime,
          parentToolCallId: params.parentToolCallId,
          codeModeRunId: params.codeModeRunId,
          ctx: params.ctx,
          request,
          privateAuthority: params.privateAuthority,
          signal,
          onUpdate: params.onUpdate,
        }),
      cancelActive: () => abortController.abort(),
      signal: params.signal,
    });
    const state: PendingBridgeState = {
      id: request.id,
      method: request.method,
      args: request.args,
      conversationList: conversationListEligible,
      promise: scheduled.promise.then((settled) => {
        state.settledSequence = ++nextPendingBridgeSettlementSequence;
        state.settled = settled;
        if (state.method === "agentWait" && params.activeRunId) {
          const active = activeRuns.get(params.activeRunId);
          if (active?.pending.includes(state)) {
            const renewed = resolveCodeModeSnapshotExpiresAt(
              Date.now(),
              active.config.snapshotTtlSeconds,
            );
            if (renewed !== undefined) {
              active.expiresAt = renewed;
              scheduleActiveRunExpiry();
            }
          }
        }
        return settled;
      }),
      cancel: scheduled.cancel,
    };
    if (request.argumentBytes !== undefined) {
      state.argumentBytes = request.argumentBytes;
    }
    return state;
  });
}

export function storeSnapshotState(params: {
  runId: string;
  replayId: string;
  pending: PendingBridgeState[];
  enforceReplaySafeTools: boolean;
  replaySafe: boolean;
  settlementMode: CodeModeSettlementMode;
  snapshotBytes: Uint8Array;
  parentToolCallId: string;
  ctx: CodeModeToolContext;
  config: CodeModeConfig;
  bridgeDispatchQueue: CodeModeBridgeDispatchQueue;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  privateAuthority: CodeModePrivateAuthority;
  codeModeStats?: CodeModeStats;
  output: unknown[];
  deliveredOutputCount?: number;
}) {
  const now = Date.now();
  const expiresAt = resolveCodeModeSnapshotExpiresAt(now, params.config.snapshotTtlSeconds);
  if (expiresAt === undefined) {
    throw new ToolInputError("code mode run expiry is unavailable.");
  }
  const hasPendingAgentWait = params.pending.some(
    (entry) => entry.method === "agentWait" && !entry.settled,
  );
  const agentWaitRetainUntil = hasPendingAgentWait
    ? resolveCodeModeSnapshotExpiresAt(
        now,
        params.config.snapshotTtlSeconds * MAX_AGENT_WAIT_SNAPSHOT_TTL_WINDOWS,
      )
    : undefined;
  const previous = activeRuns.get(params.runId);
  const releaseSnapshotActivity =
    previous?.activityOwner === params.ctx.codeModeActivityOwner &&
    previous?.releaseSnapshotActivity
      ? previous.releaseSnapshotActivity
      : beginCodeModeSnapshotActivity(params.ctx.codeModeActivityOwner);
  if (previous?.activityOwner !== params.ctx.codeModeActivityOwner) {
    previous?.releaseSnapshotActivity?.();
  }
  activeRuns.set(params.runId, {
    runId: params.runId,
    replayId: params.replayId,
    parentToolCallId: params.parentToolCallId,
    ctx: params.ctx,
    activityOwner: params.ctx.codeModeActivityOwner,
    config: params.config,
    bridgeDispatchQueue: params.bridgeDispatchQueue,
    privateAuthority: params.privateAuthority,
    snapshotBytes: params.snapshotBytes,
    pending: params.pending,
    settlementMode: params.settlementMode,
    enforceReplaySafeTools: params.enforceReplaySafeTools,
    replaySafe: params.replaySafe,
    output: params.output,
    deliveredOutputCount: params.output.length,
    expiresAt,
    agentWaitRetainUntil,
    runtime: params.runtime,
    namespaceRuntime: params.namespaceRuntime,
    codeModeStats: params.codeModeStats,
    releaseSnapshotActivity,
  });
  scheduleActiveRunExpiry();
  return {
    status: "waiting" as const,
    runId: params.runId,
    reason: codeModeWaitingReason(params.pending),
    pendingToolCalls: pendingToolCalls(params.pending),
    replaySafe: params.replaySafe,
    output: params.output.slice(params.deliveredOutputCount ?? 0),
    telemetry: telemetry(params.runtime),
  };
}

export function codeModeWaitingReason(
  pending: readonly PendingBridgeState[],
): "pending_tools" | "yield" {
  return pending.length > 0 && pending.every((entry) => entry.method === "yield")
    ? "yield"
    : "pending_tools";
}

export function pendingToolCalls(pending: readonly PendingBridgeState[]) {
  // Settled calls remain in snapshots until QuickJS consumes their response,
  // but they must not be advertised as outstanding work to exec or wait.
  return pending
    .filter((entry) => !entry.settled)
    .map((entry) => ({ id: entry.id, method: entry.method }));
}

export function telemetry(runtime: ToolSearchRuntime) {
  return {
    ...runtime.telemetry(),
    visibleTools: [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME],
  };
}
