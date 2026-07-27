import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { runBridgeRequest } from "./code-mode-bridge.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import {
  enforceSnapshotPayloadLimits,
  type CodeModeConfig,
  type PendingBridgeRequest,
  type SettledBridgeRequest,
} from "./code-mode-runtime.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { ToolSearchRuntime, type ToolSearchToolContext } from "./tool-search.js";
import { ToolInputError } from "./tools/common.js";

export type PendingBridgeState = PendingBridgeRequest & {
  promise: Promise<SettledBridgeRequest>;
  settled?: SettledBridgeRequest;
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
  // True only when every future bridge call is enforced read-only before execution.
  replaySafe: boolean;
  output: unknown[];
  createdAt: number;
  expiresAt: number;
  agentWaitRetainUntil?: number;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
};

const MAX_ACTIVE_CODE_MODE_RUNS = 64;
const MAX_AGENT_WAIT_SNAPSHOT_TTL_WINDOWS = 4;

export const activeRuns = new Map<string, CodeModeRunState>();
export const resumingRunIds = new Set<string>();
let activeRunReservations = 0;

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
  for (const pending of state?.pending ?? []) {
    if (!pending.settled) {
      pending.cancel?.();
    }
  }
  activeRuns.delete(runId);
  resumingRunIds.delete(runId);
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

export function reserveActiveRunSlot(): () => void {
  enforceActiveRunLimit();
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
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: unknown[];
  replaySafe: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  enforceSnapshotStateLimits(params);
  const runId = `cm_${randomUUID()}`;
  return storeSnapshotState({
    ...params,
    runId,
    replayId: params.codeModeReplayId,
    pending: createPendingBridgeStates({
      ...params,
      activeRunId: runId,
      codeModeRunId: params.codeModeReplayId,
    }),
    replaySafe:
      params.replaySafe && pendingBridgeRequestsReplaySafe(params.pendingRequests, params.runtime),
  });
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
      request.method === "agentSpawn" ||
      request.method === "agentWait"
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
}) {
  enforceActiveRunLimit();
  enforceSnapshotPayloadLimits(params);
}

export function createPendingBridgeStates(params: {
  pendingRequests: PendingBridgeRequest[];
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  parentToolCallId: string;
  codeModeRunId: string;
  activeRunId?: string;
  ctx: ToolSearchToolContext;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): PendingBridgeState[] {
  return params.pendingRequests.map((request) => {
    // Bridge calls start immediately while the VM snapshot is stored. Their
    // settled values are later replayed into QuickJS by the wait tool.
    const abortController = new AbortController();
    const signal = params.signal
      ? AbortSignal.any([params.signal, abortController.signal])
      : abortController.signal;
    const promise = runBridgeRequest({
      runtime: params.runtime,
      namespaceRuntime: params.namespaceRuntime,
      parentToolCallId: params.parentToolCallId,
      codeModeRunId: params.codeModeRunId,
      ctx: params.ctx,
      request,
      signal,
      onUpdate: params.onUpdate,
    });
    const state: PendingBridgeState = {
      ...request,
      promise,
      cancel: () => abortController.abort(),
    };
    void promise.then((settled) => {
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
          }
        }
      }
    });
    return state;
  });
}

export function storeSnapshotState(params: {
  runId: string;
  replayId: string;
  pending: PendingBridgeState[];
  replaySafe: boolean;
  snapshotBytes: Uint8Array;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: unknown[];
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
  activeRuns.set(params.runId, {
    runId: params.runId,
    replayId: params.replayId,
    parentToolCallId: params.parentToolCallId,
    ctx: params.ctx,
    config: params.config,
    snapshotBytes: params.snapshotBytes,
    pending: params.pending,
    replaySafe: params.replaySafe,
    output: params.output,
    createdAt: now,
    expiresAt,
    agentWaitRetainUntil,
    runtime: params.runtime,
    namespaceRuntime: params.namespaceRuntime,
  });
  return {
    status: "waiting" as const,
    runId: params.runId,
    reason: codeModeWaitingReason(params.pending),
    pendingToolCalls: pendingToolCalls(params.pending),
    replaySafe: params.replaySafe,
    output: params.output,
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
  return pending.map((entry) => ({ id: entry.id, method: entry.method }));
}

export function telemetry(runtime: ToolSearchRuntime) {
  return {
    ...runtime.telemetry(),
    visibleTools: [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME],
  };
}
