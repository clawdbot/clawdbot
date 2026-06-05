// Gateway session lifecycle state projection.
// Converts agent run lifecycle events into session row/store status updates.
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts" | "sessionId"> & {
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    error?: unknown;
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function mapAgentRunTerminalOutcomeToSessionStatus(
  outcome: AgentRunTerminalOutcome,
): SessionRunStatus {
  switch (outcome.reason) {
    case "completed":
      return "done";
    case "hard_timeout":
    case "timed_out":
      return "timeout";
    case "cancelled":
    case "aborted":
      return "killed";
    case "blocked":
    case "failed":
      return "failed";
    default:
      return outcome.reason satisfies never;
  }
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  const terminal = buildAgentRunTerminalOutcome({
    status: phase === "error" ? "error" : event.data?.aborted === true ? "timeout" : "ok",
    error: event.data?.error,
    stopReason: event.data?.stopReason,
    livenessState: event.data?.livenessState,
    timeoutPhase: event.data?.timeoutPhase,
    providerStarted: event.data?.providerStarted,
    startedAt: event.data?.startedAt,
    endedAt: event.data?.endedAt ?? event.ts,
  });
  return mapAgentRunTerminalOutcomeToSessionStatus(terminal);
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    // A start event clears terminal fields from the previous run so UI rows do
    // not show stale runtime/end state while the new run is active.
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveTerminalStatus(params.event) === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

/**
 * A pre-`sessions.reset` run's lifecycle event must not mutate a session row
 * whose sessionId was rotated by the reset. True only when both the owning
 * run's sessionId and the current row's sessionId are known and differ.
 */
export function isStaleLifecycleEventForSession(params: {
  owningSessionId?: string;
  currentSessionId?: string;
}): boolean {
  return Boolean(
    params.owningSessionId &&
    params.currentSessionId &&
    params.owningSessionId !== params.currentSessionId,
  );
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  agentId?: string;
  event: LifecycleEventLike;
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey, {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
  });
  if (!sessionEntry.entry) {
    return;
  }

  const owningSessionId =
    typeof params.event.sessionId === "string" && params.event.sessionId
      ? params.event.sessionId
      : undefined;

  await updateSessionStoreEntry({
    storePath: sessionEntry.storePath,
    sessionKey: sessionEntry.canonicalKey,
    skipMaintenance: true,
    takeCacheOwnership: true,
    update: async (entry) => {
      // Reject a pre-reset run's lifecycle event: sessions.reset rotates the row
      // to a new sessionId under the same sessionKey, so an old in-flight run's
      // late start/end/error must not overwrite the fresh row's status (#88538).
      if (isStaleLifecycleEventForSession({ owningSessionId, currentSessionId: entry.sessionId })) {
        return null;
      }
      return derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      });
    },
  });
}
