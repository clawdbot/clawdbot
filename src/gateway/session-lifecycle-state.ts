// Gateway session lifecycle state projection.
// Converts agent run lifecycle events into session row/store status updates.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { sanitizeUserFacingText } from "../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  isMainSessionRecoveryLifecycleEvent,
  projectMainSessionRecoveryLifecycle,
} from "../agents/main-session-recovery-lifecycle.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration, type AgentEventPayload } from "../infra/agent-events.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

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
    yielded?: unknown;
    status?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "lastRunError" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "status"
  | "lastRunError"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "restartRecoveryRuns"
  | "mainRestartRecovery"
  | "lifecycleRunId"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

const SESSION_RUN_ERROR_MAX_CHARS = 160;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: Pick<LifecycleEventLike, "data">): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

const SESSION_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "timeout",
  cancellation: "killed",
  failure: "failed",
} as const satisfies Record<ReturnType<typeof classifyAgentRunTerminalOutcome>, SessionRunStatus>;

function resolveTerminalOutcome(event: LifecycleEventLike): AgentRunTerminalOutcome {
  const phase = resolveLifecyclePhase(event);
  return buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: phase === "error" ? "error" : "end",
    data: event.data,
    endedAt: event.data?.endedAt ?? event.ts,
  });
}

function resolveSessionRunError(
  outcome: AgentRunTerminalOutcome,
  status: SessionRunStatus,
): string | undefined {
  if ((status !== "failed" && status !== "timeout") || !outcome.error) {
    return undefined;
  }
  const sanitized = sanitizeUserFacingText(outcome.error, { errorContext: true })
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? truncateUtf16Safe(sanitized, SESSION_RUN_ERROR_MAX_CHARS) : undefined;
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

function deriveGatewaySessionLifecycleSnapshot(params: {
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
      lastRunError: undefined,
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  const yieldedWaiting = isAgentLifecycleYieldedWaiting({
    phase,
    yielded: params.event.data?.yielded,
    livenessState: params.event.data?.livenessState,
    stopReason: params.event.data?.stopReason,
    aborted: params.event.data?.aborted,
    status: params.event.data?.status,
    timeoutPhase: params.event.data?.timeoutPhase,
    error: params.event.data?.error,
  });
  const terminal = yieldedWaiting ? undefined : resolveTerminalOutcome(params.event);
  const status = terminal
    ? SESSION_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(terminal)]
    : "running";
  return {
    updatedAt,
    status,
    lastRunError: terminal ? resolveSessionRunError(terminal, status) : undefined,
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: status === "killed",
  };
}

function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  const snapshotPatch: Partial<PersistedLifecycleSessionShape> = {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
  const projection = projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
    entry: params.entry,
    event: params.event,
    snapshotPatch,
  });
  if (projection.action === "suppress") {
    return {};
  }
  const phase = resolveLifecyclePhase(params.event);
  const runId = normalizeLifecycleRunId(params.event.runId);
  // Run ownership follows the durable running projection. Terminal settlement
  // releases it; yielded parents retain it for their continuation lifecycle.
  return {
    ...projection.patch,
    ...(phase === "start"
      ? { lifecycleRunId: runId }
      : projection.patch.status && projection.patch.status !== "running"
        ? { lifecycleRunId: undefined }
        : {}),
  };
}

export function deriveGatewaySessionLifecycleProjectionPatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const {
    restartRecoveryRuns: _restartRecoveryRuns,
    lifecycleRunId: _lifecycleRunId,
    ...patch
  } = derivePersistedSessionLifecyclePatch(params);
  return patch;
}

function normalizeLifecycleRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRestartRecoveryLifecycleEvent(params: {
  entry?: Pick<SessionEntry, "restartRecoveryRuns"> | null;
  event: Pick<LifecycleEventLike, "runId" | "lifecycleGeneration" | "data">;
}): boolean {
  return isMainSessionRecoveryLifecycleEvent(params);
}

/**
 * Reject pre-reset runs and explicitly older runs sharing one session so late
 * lifecycle events cannot overwrite a newer run's authoritative state.
 */
export function isStaleLifecycleEventForSession(params: {
  owningSessionId?: string;
  currentSessionId?: string;
  eventRunId?: unknown;
  currentRunId?: unknown;
  eventStartedAt?: unknown;
  currentStartedAt?: number;
}): boolean {
  if (
    params.owningSessionId &&
    params.currentSessionId &&
    params.owningSessionId !== params.currentSessionId
  ) {
    return true;
  }
  const eventRunId = normalizeLifecycleRunId(params.eventRunId);
  const currentRunId = normalizeLifecycleRunId(params.currentRunId);
  // Matching ownership is stronger than producer timestamps. Missing or
  // different identities retain the legacy timestamp fence.
  if (eventRunId && currentRunId && eventRunId === currentRunId) {
    return false;
  }
  return (
    isFiniteTimestamp(params.eventStartedAt) &&
    isFiniteTimestamp(params.currentStartedAt) &&
    params.eventStartedAt < params.currentStartedAt
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
    async (storedEntry) => {
      const entry = storedEntry as SessionEntry;
      if (
        exactCronRun &&
        !acceptsCronRunContinuationLifecycleEvent({ entry, event: params.event })
      ) {
        // Exact cron rows transfer lifecycle ownership from the initial run to
        // one claimed continuation. Ready or replaced claims reject late events.
        return null;
      }
      if (
        isStaleLifecycleEventForSession({
          owningSessionId,
          currentSessionId: entry.sessionId,
          eventRunId: params.event.runId,
          currentRunId: entry.lifecycleRunId,
          eventStartedAt: params.event.data?.startedAt,
          currentStartedAt: entry.startedAt,
        })
      ) {
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
