import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "@openclaw/normalization-core/number-coercion";
import type { Snapshot } from "quickjs-wasi";
import { raceWithAbortSignal } from "./agent-tools.abort.js";
import { runBridgeRequest } from "./code-mode-bridge.js";
import type { CodeModeCatalogProjection } from "./code-mode-catalog.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import type { CodeModeOutputState } from "./code-mode-json.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import type {
  CodeModeConfig,
  CodeModeSettlementMode,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "./code-mode-runtime.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import { ToolInputError } from "./tools/common.js";

export type CodeModeBridgeDispatchState = {
  started: boolean;
};

export type PendingBridgeState = PendingBridgeRequest & {
  promise: Promise<SettledBridgeRequest>;
  settled?: SettledBridgeRequest;
  settledSequence?: number;
  cancel?: () => void;
};

type CodeModeRunState = {
  runId: string;
  replayId: string;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  snapshot: Snapshot;
  pending: PendingBridgeState[];
  settlementMode: CodeModeSettlementMode;
  // True only when every future bridge call is enforced read-only before execution.
  replaySafe: boolean;
  output: CodeModeOutputState;
  expiresAt: number;
  agentWaitRetainUntil?: number;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  bridgeDispatch: CodeModeBridgeDispatchState;
  owner: CodeModeRunOwner;
};

export type CodeModeRunOwner = ReturnType<typeof createCodeModeRunOwner>;

const MAX_ACTIVE_CODE_MODE_RUNS = 64;
const MAX_AGENT_WAIT_SNAPSHOT_TTL_WINDOWS = 4;
const BRIDGE_CLOSED_MESSAGE = "Code Mode tool canceled, expired, or owner lost; start a new run.";

export const activeRuns = new Map<string, CodeModeRunState>();
export const resumingRunIds = new Set<string>();
const liveRunOwners = new Set<CodeModeRunOwner>();
let activeRunReservations = 0;
let nextPendingBridgeSettlementSequence = 0;
let activeRunExpiryTimer: ReturnType<typeof setTimeout> | undefined;

/** Catalog ownership spans worker legs and snapshots; parking never closes the cell. */
export function createCodeModeRunOwner(ctx: ToolSearchToolContext) {
  const runId = `cm_${randomUUID()}`;
  const closed = new AbortController();
  const signal = ctx.abortSignal
    ? AbortSignal.any([closed.signal, ctx.abortSignal])
    : closed.signal;
  const disposers = ctx.catalogRef
    ? (ctx.catalogRef.onDispose ??= new Set<() => void>())
    : undefined;
  let releaseCall = () => {};
  const close = (reason?: unknown) => {
    if (closed.signal.aborted) {
      return;
    }
    releaseCall();
    signal.removeEventListener("abort", onLifetimeAbort);
    disposers?.delete(close);
    liveRunOwners.delete(owner);
    const parked = activeRuns.get(runId);
    if (parked?.owner === owner) {
      activeRuns.delete(runId);
      cancelPendingBridgeStates(parked.pending);
    }
    closed.abort(reason);
    scheduleActiveRunExpiry();
  };
  const onLifetimeAbort = () => close(signal.reason);
  const owner = {
    runId,
    signal,
    close,
    bindCall(callSignal?: AbortSignal): AbortSignal {
      releaseCall();
      if (signal.aborted) {
        return signal;
      }
      const combined = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
      const release = () => combined.removeEventListener("abort", onAbort);
      const onAbort = () => {
        // A completed observer cannot cancel a later wait on this same cell.
        if (releaseCall === release) {
          close(combined.reason);
        }
      };
      releaseCall = release;
      combined.addEventListener("abort", onAbort, { once: true });
      if (combined.aborted) {
        onAbort();
      }
      // Pending work follows the cell, not an observer replaced by a later wait.
      return signal;
    },
  };
  liveRunOwners.add(owner);
  disposers?.add(close);
  signal.addEventListener("abort", onLifetimeAbort, { once: true });
  if (!ctx.catalogRef?.current || signal.aborted) {
    close(signal.reason);
  }
  return owner;
}

export function createCodeModeBridgeDispatchState(): CodeModeBridgeDispatchState {
  return { started: false };
}

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
  activeRuns.delete(runId);
  state?.owner.close();
  cancelPendingBridgeStates(state?.pending ?? []);
  resumingRunIds.delete(runId);
  scheduleActiveRunExpiry();
}

/** Cancel every cell before its Gateway-owned runtimes disappear. */
export function disposeAllCodeModeRuns(): void {
  liveRunOwners.forEach((owner) => owner.close());
  activeRuns.clear();
  resumingRunIds.clear();
  scheduleActiveRunExpiry();
}

/** Abort each bridge call whose result has not already reached its guest. */
export function cancelPendingBridgeStates(pending: readonly PendingBridgeState[]): void {
  for (const entry of pending) {
    if (!entry.settled) {
      entry.cancel?.();
    }
  }
}

/** Apply restored-guest cancellation to the parent-owned host operations. */
export function cancelPendingBridgeStatesById(
  pending: PendingBridgeState[],
  canceledRequestIds: readonly string[],
): void {
  if (canceledRequestIds.length === 0) {
    return;
  }
  const canceled = new Set(canceledRequestIds);
  cancelPendingBridgeStates(pending.filter((entry) => canceled.has(entry.id)));
  pending.splice(0, pending.length, ...pending.filter((entry) => !canceled.has(entry.id)));
}

/** Deliver bridge responses in actual settlement order, not request order. */
export function settledBridgeRequestsInCompletionOrder(
  pending: readonly PendingBridgeState[],
): SettledBridgeRequest[] {
  return pending
    .filter((entry) => entry.settled !== undefined)
    .toSorted((left, right) => (left.settledSequence ?? 0) - (right.settledSequence ?? 0))
    .flatMap((entry) => (entry.settled ? [entry.settled] : []));
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
    const state = activeRuns.get(ownedRunId);
    if (!state) {
      throw new ToolInputError("code mode run is unavailable or expired.");
    }
    activeRuns.delete(ownedRunId);
    scheduleActiveRunExpiry();
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

export function pendingBridgeRequestsReplaySafe(
  pending: readonly PendingBridgeRequest[],
  runtime: ToolSearchRuntime,
  catalogProjection: CodeModeCatalogProjection,
): boolean {
  return pending.every((request) =>
    isPendingBridgeRequestReplaySafe(request, runtime, catalogProjection),
  );
}

function isPendingBridgeRequestReplaySafe(
  request: PendingBridgeRequest,
  runtime: ToolSearchRuntime,
  catalogProjection: CodeModeCatalogProjection,
): boolean {
  if (
    request.method === "search" ||
    request.method === "describe" ||
    request.method === "yield" ||
    request.method === "agentSpawn" ||
    request.method === "agentWait" ||
    request.method === "skillsList" ||
    request.method === "skillsRead" ||
    request.method === "sleep"
  ) {
    return true;
  }
  if (request.method === "nodes") {
    return request.args[0] === "list" || request.args[0] === "get";
  }
  if (request.method !== "callValue") {
    return false;
  }
  const callableName = Array.isArray(request.args) ? request.args[0] : undefined;
  if (typeof callableName !== "string") {
    return false;
  }
  const binding = catalogProjection.byCallableName.get(callableName);
  return binding ? runtime.isReplaySafeExactId(binding.id) : false;
}

export function createPendingBridgeStates(
  pendingRequests: PendingBridgeRequest[],
  params: {
    config: CodeModeConfig;
    runtime: ToolSearchRuntime;
    catalogProjection: CodeModeCatalogProjection;
    namespaceRuntime: CodeModeNamespaceRuntime;
    parentToolCallId: string;
    codeModeRunId: string;
    remainingMs: number;
    activeRunId?: string;
    ctx: ToolSearchToolContext;
    signal: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
    bridgeDispatch: CodeModeBridgeDispatchState;
  },
): PendingBridgeState[] {
  // Pending siblings retain dispatch context, never the original request batch.
  return pendingRequests.map((request) => {
    // Bridge calls start immediately while the VM snapshot is stored. Their
    // settled values are later replayed into QuickJS by the wait tool.
    const abortController = new AbortController();
    const signal = abortController.signal;
    // Relay only while pending: closing a finished cell must not cancel an
    // external operation whose result was already delivered to its guest.
    const onAbort = () => abortController.abort(params.signal.reason);
    params.signal.addEventListener("abort", onAbort, { once: true });
    if (params.signal.aborted) {
      onAbort();
    }
    if (request.method !== "sleep") {
      params.bridgeDispatch.started = true;
    }
    const bridgeCall = runBridgeRequest({
      runtime: params.runtime,
      catalogProjection: params.catalogProjection,
      namespaceRuntime: params.namespaceRuntime,
      parentToolCallId: params.parentToolCallId,
      codeModeRunId: params.codeModeRunId,
      maxOutputBytes: params.config.maxOutputBytes,
      remainingMs: Math.max(1, params.remainingMs),
      ctx: params.ctx,
      request,
      signal,
      onUpdate: params.onUpdate,
    });
    const completion = raceWithAbortSignal(bridgeCall, signal).catch((): SettledBridgeRequest => ({
      id: request.id,
      ok: false,
      error: signal.reason instanceof Error ? signal.reason.message : BRIDGE_CLOSED_MESSAGE,
    }));
    const state: PendingBridgeState = {
      ...request,
      promise: completion.then((settled) => {
        params.signal.removeEventListener("abort", onAbort);
        state.settledSequence = ++nextPendingBridgeSettlementSequence;
        state.settled = settled;
        // Only the response is needed until guest replay; live calls keep their own request.
        state.args = [];
        state.cancel = undefined;
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
      cancel: () => abortController.abort(new Error(BRIDGE_CLOSED_MESSAGE)),
    };
    return state;
  });
}

export function storeSnapshotState(params: {
  owner: CodeModeRunOwner;
  replayId: string;
  pending: PendingBridgeState[];
  replaySafe: boolean;
  settlementMode: CodeModeSettlementMode;
  snapshot: Snapshot;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: CodeModeOutputState;
  bridgeDispatch: CodeModeBridgeDispatchState;
}) {
  const runId = params.owner.runId;
  if (params.owner.signal.aborted) {
    cancelPendingBridgeStates(params.pending);
    return codeModeAbortedResult(params);
  }
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
  const state: CodeModeRunState = {
    runId,
    replayId: params.replayId,
    parentToolCallId: params.parentToolCallId,
    ctx: params.ctx,
    config: params.config,
    snapshot: params.snapshot,
    pending: params.pending,
    settlementMode: params.settlementMode,
    replaySafe: params.replaySafe,
    output: params.output,
    expiresAt,
    agentWaitRetainUntil,
    runtime: params.runtime,
    catalogProjection: params.catalogProjection,
    namespaceRuntime: params.namespaceRuntime,
    bridgeDispatch: params.bridgeDispatch,
    owner: params.owner,
  };
  const result = params.output.takeResult(
    {
      status: "waiting" as const,
      runId,
      reason: codeModeWaitingReason(params.pending),
      pendingToolCalls: pendingToolCalls(params.pending),
      replaySafe: params.replaySafe,
      telemetry: telemetry(params.runtime),
    },
    {},
    params.runtime.hasNetworkContent(),
  );
  // A result that cannot expose its continuation must not leave an unreachable parked cell.
  activeRuns.set(runId, state);
  scheduleActiveRunExpiry();
  return result;
}

export function codeModeAbortedResult(params: {
  bridgeDispatch: CodeModeBridgeDispatchState;
  output: CodeModeOutputState;
  replaySafe: boolean;
  runtime: ToolSearchRuntime;
}) {
  return params.output.takeResult(
    {
      status: "failed" as const,
      code: "aborted" as const,
      failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("host" as const),
      bridgeDispatchStarted: params.bridgeDispatch.started,
      replaySafe: params.replaySafe,
      telemetry: telemetry(params.runtime),
    },
    { error: "code mode execution aborted" },
    params.runtime.hasNetworkContent(),
  );
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
