// Gateway session lifecycle state projection.
// Converts agent run lifecycle events into session row/store status updates.
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import type { SessionEntry } from "../config/sessions.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts" | "sessionId"> & {
  runId?: string;
  lifecycleGeneration?: string;
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
  | "updatedAt"
  | "status"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "restartRecoveryRuns"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: Pick<LifecycleEventLike, "data">): LifecyclePhase | null {
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
    case "abandoned":
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
  if (isRestartRecoveryLifecycleEvent(params)) {
    return {};
  }
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  const patch: Partial<PersistedLifecycleSessionShape> = {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const restartRecoveryRuns = params.entry?.restartRecoveryRuns;
  if (
    resolveLifecyclePhase(params.event) !== "start" &&
    runId &&
    lifecycleGeneration &&
    restartRecoveryRuns?.some(
      (run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration,
    )
  ) {
    const remainingRuns = restartRecoveryRuns.filter(
      (run) => run.runId !== runId || run.lifecycleGeneration !== lifecycleGeneration,
    );
    if (remainingRuns.length > 0) {
      return { restartRecoveryRuns: remainingRuns };
    }
    patch.restartRecoveryRuns = undefined;
  }
  return patch;
}

export function deriveGatewaySessionLifecycleProjectionPatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const { restartRecoveryRuns: _restartRecoveryRuns, ...patch } =
    derivePersistedSessionLifecyclePatch(params);
  return patch;
}

export function isRestartRecoveryLifecycleEvent(params: {
  entry?: Pick<SessionEntry, "restartRecoveryRuns"> | null;
  event: Pick<LifecycleEventLike, "runId" | "lifecycleGeneration" | "data">;
}): boolean {
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const phase = resolveLifecyclePhase(params.event);
  const interrupted = params.event.data?.stopReason === "restart";
  const matchesRecoveryRun = Boolean(
    runId &&
    lifecycleGeneration &&
    params.entry?.restartRecoveryRuns?.some(
      (run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration,
    ),
  );
  return (
    matchesRecoveryRun &&
    (phase === "start" || ((phase === "end" || phase === "error") && interrupted))
  );
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

function acceptsCronRunContinuationLifecycleEvent(params: {
  entry: SessionEntry;
  event: LifecycleEventLike;
}): boolean {
  const marker = params.entry.cronRunContinuation;
  if (marker?.phase === "running") {
    return true;
  }
  const runId = params.event.runId?.trim();
  return Boolean(marker?.phase === "continuing" && runId && marker.ownerRunId === runId);
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

  const exactCronRun = parseCronRunScopeSuffix(sessionEntry.canonicalKey).runId !== undefined;
  await updateSessionEntry(
    {
      storePath: sessionEntry.storePath,
      sessionKey: sessionEntry.canonicalKey,
    },
    async (entry) => {
      if (
        exactCronRun &&
        !acceptsCronRunContinuationLifecycleEvent({ entry, event: params.event })
      ) {
        // Exact cron rows transfer lifecycle ownership from the initial run to
        // one claimed continuation. Ready or replaced claims reject late events.
        return null;
      }
      // Reject a pre-reset run's lifecycle event: sessions.reset rotates the row
      // to a new sessionId under the same sessionKey, so an old in-flight run's
      // late start/end/error must not overwrite the fresh row's status (#88538).
      if (isStaleLifecycleEventForSession({ owningSessionId, currentSessionId: entry.sessionId })) {
        return null;
      }
      const patch = derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
      });
      return Object.keys(patch).length > 0 ? patch : null;
    },
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
      requireWriteSuccess: true,
    },
  );
}
