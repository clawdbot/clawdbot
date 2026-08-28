import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { raceWithAbortSignal } from "./agent-tools.abort.js";
import { runBridgeRequest } from "./code-mode-bridge.js";
import type { CodeModeCatalogProjection } from "./code-mode-catalog.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import {
  enforceSnapshotPayloadLimits,
  type CodeModeConfig,
  type CodeModeSettlementMode,
  type PendingBridgeRequest,
  type SettledBridgeRequest,
} from "./code-mode-runtime.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import {
  consumeToolEffectReceipt,
  toolEffectStateProvesNoEffect,
  type ToolEffectReceipt,
} from "./tool-effect-receipt.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";
import { ToolSearchRuntime, type ToolSearchToolContext } from "./tool-search.js";
import { ToolInputError } from "./tools/common.js";

export type CodeModeBridgeDispatchState = {
  started: boolean;
  operations: Map<string, "pending" | ToolEffectReceipt["state"]>;
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
  snapshotBytes: Uint8Array;
  pending: PendingBridgeState[];
  settlementMode: CodeModeSettlementMode;
  // True only when every future bridge call is enforced read-only before execution.
  replaySafe: boolean;
  output: unknown[];
  // Retain all output for cumulative limits, but never replay blocks already returned to the model.
  deliveredOutputCount: number;
  expiresAt: number;
  agentWaitRetainUntil?: number;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  bridgeDispatch: CodeModeBridgeDispatchState;
  ownerSignal: AbortSignal;
  releaseOwner: () => void;
};

const MAX_ACTIVE_CODE_MODE_RUNS = 64;
const MAX_AGENT_WAIT_SNAPSHOT_TTL_WINDOWS = 4;
const BRIDGE_CLOSED_MESSAGE = "Code Mode tool canceled, expired, or owner lost; start a new run.";

export const activeRuns = new Map<string, CodeModeRunState>();
export const resumingRunIds = new Set<string>();
let activeRunReservations = 0;
let nextPendingBridgeSettlementSequence = 0;
let activeRunExpiryTimer: ReturnType<typeof setTimeout> | undefined;

export function createCodeModeBridgeDispatchState(): CodeModeBridgeDispatchState {
  return { started: false, operations: new Map() };
}

/** Read the host-only side-effect classification for one Code Mode run. */
export function isCodeModeBridgeRepairEligible(state: CodeModeBridgeDispatchState): boolean {
  return (
    state.started &&
    state.operations.size > 0 &&
    [...state.operations.values()].every(
      (effect) => effect !== "pending" && toolEffectStateProvesNoEffect(effect),
    )
  );
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
  state?.releaseOwner();
  cancelPendingBridgeStates(state?.pending ?? []);
  resumingRunIds.delete(runId);
  scheduleActiveRunExpiry();
}

/** Cancel suspended bridge work before its Gateway-owned runtimes disappear. */
export function disposeAllCodeModeRuns(): void {
  activeRuns.forEach((state) => {
    state.releaseOwner();
    cancelPendingBridgeStates(state.pending);
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
    state.releaseOwner();
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
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: unknown[];
  remainingMs: number;
  deliveredOutputCount?: number;
  reservedActiveRunSlot?: boolean;
  replaySafe: boolean;
  settlementMode: CodeModeSettlementMode;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  bridgeDispatch: CodeModeBridgeDispatchState;
}) {
  enforceSnapshotStateLimits(params);
  const runId = `cm_${randomUUID()}`;
  const pending = createPendingBridgeStates({
    ...params,
    activeRunId: runId,
    codeModeRunId: params.codeModeReplayId,
  });
  try {
    return storeSnapshotState({
      ...params,
      runId,
      replayId: params.codeModeReplayId,
      pending,
      replaySafe:
        params.replaySafe &&
        pendingBridgeRequestsReplaySafe(
          params.pendingRequests,
          params.runtime,
          params.catalogProjection,
        ),
    });
  } catch (error) {
    cancelPendingBridgeStates(pending);
    throw error;
  }
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

function enforceSnapshotStateLimits(params: {
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
  reservedActiveRunSlot?: boolean;
}) {
  if (!params.reservedActiveRunSlot) {
    enforceActiveRunLimit();
  }
  enforceSnapshotPayloadLimits(params);
}

export function createPendingBridgeStates(params: {
  pendingRequests: PendingBridgeRequest[];
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  parentToolCallId: string;
  codeModeRunId: string;
  remainingMs: number;
  activeRunId?: string;
  ctx: ToolSearchToolContext;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  bridgeDispatch: CodeModeBridgeDispatchState;
}): PendingBridgeState[] {
  return params.pendingRequests.map((request) => {
    // Bridge calls start immediately while the VM snapshot is stored. Their
    // settled values are later replayed into QuickJS by the wait tool.
    const abortController = new AbortController();
    const signal = AbortSignal.any(
      [params.signal, params.ctx.abortSignal, abortController.signal].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined,
      ),
    );
    const target = params.catalogProjection.byCallableName.get(String(request.args[0]));
    const yieldRunSignal = target?.name === "sessions_yield" ? params.ctx.abortSignal : undefined;
    const tracksDispatch = request.method !== "sleep";
    // Discovery is read-only; replay-safe actions such as agentSpawn may still mutate.
    const recoverySafe =
      ["search", "describe", "skillsList", "skillsRead"].includes(request.method) ||
      (["nodes", "callValue"].includes(request.method) &&
        isPendingBridgeRequestReplaySafe(request, params.runtime, params.catalogProjection));
    if (tracksDispatch) {
      params.bridgeDispatch.started = true;
      params.bridgeDispatch.operations.set(request.id, "pending");
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
    const completion = raceWithAbortSignal(bridgeCall, signal, yieldRunSignal).catch(
      (): SettledBridgeRequest => ({
        id: request.id,
        ok: false,
        error: signal.reason instanceof Error ? signal.reason.message : BRIDGE_CLOSED_MESSAGE,
      }),
    );
    const state: PendingBridgeState = {
      ...request,
      promise: completion.then((settled) => {
        // The effect receipt owns classification; consume the predecessor marker
        // so reusing this settled object cannot preserve stale no-start authority.
        consumeTrustedToolNoStartError(settled);
        const effectReceipt = consumeToolEffectReceipt(settled);
        if (tracksDispatch) {
          params.bridgeDispatch.operations.set(
            request.id,
            effectReceipt?.state ??
              (recoverySafe ? (settled.ok ? "read_completed" : "failed_no_effect") : "uncertain"),
          );
        }
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
      cancel: () => abortController.abort(new Error(BRIDGE_CLOSED_MESSAGE)),
    };
    return state;
  });
}

export function storeSnapshotState(params: {
  runId: string;
  replayId: string;
  pending: PendingBridgeState[];
  replaySafe: boolean;
  settlementMode: CodeModeSettlementMode;
  snapshotBytes: Uint8Array;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: unknown[];
  deliveredOutputCount?: number;
  bridgeDispatch: CodeModeBridgeDispatchState;
  signal?: AbortSignal;
}) {
  const catalogRef = params.ctx.catalogRef;
  const closed = new AbortController();
  const ownerSignal = AbortSignal.any(
    [params.signal, params.ctx.abortSignal, closed.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    ),
  );
  if (!catalogRef?.current || ownerSignal.aborted) {
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
  const disposers = (catalogRef.onDispose ??= new Set());
  const onClose = () => {
    // A transferred snapshot may reuse this cell id; stale observers own only
    // the exact parked state they subscribed for, never its replacement.
    if (activeRuns.get(params.runId) === state) {
      disposeCodeModeRun(params.runId);
    }
  };
  const state: CodeModeRunState = {
    runId: params.runId,
    replayId: params.replayId,
    parentToolCallId: params.parentToolCallId,
    ctx: params.ctx,
    config: params.config,
    snapshotBytes: params.snapshotBytes,
    pending: params.pending,
    settlementMode: params.settlementMode,
    replaySafe: params.replaySafe,
    output: params.output,
    deliveredOutputCount: params.output.length,
    expiresAt,
    agentWaitRetainUntil,
    runtime: params.runtime,
    catalogProjection: params.catalogProjection,
    namespaceRuntime: params.namespaceRuntime,
    bridgeDispatch: params.bridgeDispatch,
    ownerSignal,
    releaseOwner: () => {
      disposers.delete(onClose);
      ownerSignal.removeEventListener("abort", onClose);
      closed.abort();
    },
  };
  activeRuns.set(params.runId, state);
  disposers.add(onClose);
  ownerSignal.addEventListener("abort", onClose, { once: true });
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

export function codeModeAbortedResult(params: {
  bridgeDispatch: CodeModeBridgeDispatchState;
  output: unknown[];
  deliveredOutputCount?: number;
  replaySafe: boolean;
  runtime: ToolSearchRuntime;
}) {
  return {
    status: "failed" as const,
    error: "code mode execution aborted",
    code: "aborted" as const,
    failurePhase: params.bridgeDispatch.started ? ("bridge" as const) : ("host" as const),
    bridgeDispatchStarted: params.bridgeDispatch.started,
    output: params.output.slice(params.deliveredOutputCount ?? 0),
    replaySafe: params.replaySafe,
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
