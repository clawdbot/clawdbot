import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  buildAgentRunTerminalOutcome,
  isStickyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { normalizeBlockedLivenessWaitStatus } from "../../shared/agent-liveness.js";
import { isNonTerminalAgentRunStatus } from "../../shared/agent-run-status.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import type { DedupeEntry } from "../server-shared.js";

export type AgentWaitTerminalSnapshot = {
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTerminalOutcome["timeoutPhase"];
  providerStarted?: boolean;
};

const AGENT_WAITERS_BY_RUN_ID = new Map<string, Set<() => void>>();

function normalizeTerminalOutcomeForWaitSnapshot(outcome: AgentRunTerminalOutcome): {
  status: AgentWaitTerminalSnapshot["status"];
  error?: string;
} {
  if (outcome.reason === "hard_timeout") {
    return { status: outcome.status, error: outcome.error };
  }
  return normalizeBlockedLivenessWaitStatus(outcome);
}

function parseRunIdFromDedupeKey(key: string): string | null {
  if (key.startsWith("agent:")) {
    return key.slice("agent:".length) || null;
  }
  if (key.startsWith("chat:")) {
    return key.slice("chat:".length) || null;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildDedupeTerminalSnapshot(params: {
  status: AgentRunTerminalOutcome["status"];
  startedAt?: number;
  endedAt: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded: boolean;
  timeoutPhase: unknown;
  providerStarted: unknown;
}): AgentWaitTerminalSnapshot {
  const terminalOutcome = buildAgentRunTerminalOutcome({
    status: params.status,
    livenessState: params.livenessState,
    error: params.error,
    stopReason: params.stopReason,
    timeoutPhase: params.timeoutPhase,
    providerStarted: params.providerStarted,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
  });
  const normalized = normalizeTerminalOutcomeForWaitSnapshot(terminalOutcome);
  return {
    status: normalized.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    error:
      normalized.status === "error"
        ? normalized.error
        : normalized.status === "timeout"
          ? terminalOutcome.error
          : undefined,
    stopReason: params.stopReason,
    livenessState: params.livenessState,
    ...(params.yielded ? { yielded: params.yielded } : {}),
    ...(terminalOutcome.timeoutPhase ? { timeoutPhase: terminalOutcome.timeoutPhase } : {}),
    ...(terminalOutcome.providerStarted !== undefined
      ? { providerStarted: terminalOutcome.providerStarted }
      : {}),
  };
}

function removeWaiter(runId: string, waiter: () => void): void {
  const waiters = AGENT_WAITERS_BY_RUN_ID.get(runId);
  if (!waiters) {
    return;
  }
  waiters.delete(waiter);
  if (waiters.size === 0) {
    AGENT_WAITERS_BY_RUN_ID.delete(runId);
  }
}

function addWaiter(runId: string, waiter: () => void): () => void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return () => {};
  }
  const existing = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
  if (existing) {
    existing.add(waiter);
    return () => removeWaiter(normalizedRunId, waiter);
  }
  AGENT_WAITERS_BY_RUN_ID.set(normalizedRunId, new Set([waiter]));
  return () => removeWaiter(normalizedRunId, waiter);
}

// Waiters are keyed only by run id so chat and agent dedupe entries can wake
// the same `agent.wait` request regardless of which path finishes first.
function notifyWaiters(runId: string): void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return;
  }
  const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  for (const waiter of waiters) {
    waiter();
  }
}

function readTerminalSnapshotFromDedupeEntry(entry: DedupeEntry): AgentWaitTerminalSnapshot | null {
  const payload = entry.payload as
    | {
        status?: unknown;
        startedAt?: unknown;
        endedAt?: unknown;
        error?: unknown;
        summary?: unknown;
        stopReason?: unknown;
        livenessState?: unknown;
        yielded?: unknown;
        timeoutPhase?: unknown;
        providerStarted?: unknown;
        result?: unknown;
      }
    | undefined;
  const status = typeof payload?.status === "string" ? payload.status : undefined;
  if (isNonTerminalAgentRunStatus(status)) {
    return null;
  }

  const startedAt = asFiniteNumber(payload?.startedAt);
  const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
  const resultMeta = asOptionalRecord(asOptionalRecord(payload?.result)?.meta);
  const stopReason = asString(payload?.stopReason) ?? asString(resultMeta?.stopReason);
  const livenessState = asString(payload?.livenessState) ?? asString(resultMeta?.livenessState);
  const yielded = payload?.yielded === true || resultMeta?.yielded === true;
  const timeoutPhase = payload?.timeoutPhase ?? resultMeta?.timeoutPhase;
  const providerStarted = payload?.providerStarted ?? resultMeta?.providerStarted;
  const errorMessage =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.summary === "string"
        ? payload.summary
        : entry.error?.message;

  const terminalStatus =
    status === "ok" || status === "timeout" || status === "error"
      ? status
      : entry.ok
        ? null
        : "error";
  if (!terminalStatus) {
    return null;
  }
  return buildDedupeTerminalSnapshot({
    status: terminalStatus,
    startedAt,
    endedAt,
    error: errorMessage,
    stopReason,
    livenessState,
    yielded,
    timeoutPhase,
    providerStarted,
  });
}

function terminalOutcomeFromWaitSnapshot(
  snapshot: AgentWaitTerminalSnapshot,
): AgentRunTerminalOutcome | undefined {
  if (snapshot.pendingError) {
    return undefined;
  }
  return buildAgentRunTerminalOutcome(snapshot);
}

export function readTerminalSnapshotFromGatewayDedupe(params: {
  dedupe: Map<string, DedupeEntry>;
  runId: string;
  ignoreAgentTerminalSnapshot?: boolean;
}): AgentWaitTerminalSnapshot | null {
  // Agent and chat handlers both cache terminal state. Project them into one
  // wait result while preserving stronger terminal outcomes such as hard timeout.
  if (params.ignoreAgentTerminalSnapshot) {
    const chatEntry = params.dedupe.get(`chat:${params.runId}`);
    if (!chatEntry) {
      return null;
    }
    return readTerminalSnapshotFromDedupeEntry(chatEntry);
  }

  const chatEntry = params.dedupe.get(`chat:${params.runId}`);
  const chatSnapshot = chatEntry ? readTerminalSnapshotFromDedupeEntry(chatEntry) : null;

  const agentEntry = params.dedupe.get(`agent:${params.runId}`);
  const agentSnapshot = agentEntry ? readTerminalSnapshotFromDedupeEntry(agentEntry) : null;
  if (agentEntry) {
    if (!agentSnapshot) {
      // If agent is still in-flight, only trust chat if it was written after
      // this agent entry (indicating a newer completed chat run reused runId).
      if (chatSnapshot && chatEntry && chatEntry.ts > agentEntry.ts) {
        return chatSnapshot;
      }
      return null;
    }
  }

  if (agentSnapshot && chatSnapshot && agentEntry && chatEntry) {
    // Reused idempotency keys can leave both records present. Prefer the
    // freshest terminal snapshot so callers observe the latest run outcome.
    return chatEntry.ts > agentEntry.ts ? chatSnapshot : agentSnapshot;
  }

  return agentSnapshot ?? chatSnapshot;
}

export async function waitForTerminalGatewayDedupe(params: {
  dedupe: Map<string, DedupeEntry>;
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  ignoreAgentTerminalSnapshot?: boolean;
}): Promise<AgentWaitTerminalSnapshot | null> {
  const initial = readTerminalSnapshotFromGatewayDedupe(params);
  if (initial) {
    return initial;
  }
  if (params.timeoutMs <= 0 || params.signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;

    // Always re-read from the dedupe map on wake; waiters are notifications,
    // not carriers of terminal data, so stale callbacks cannot resolve a run.
    const finish = (snapshot: AgentWaitTerminalSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (onAbort) {
        params.signal?.removeEventListener("abort", onAbort);
      }
      removeWaiterLocal?.();
      resolve(snapshot);
    };

    const onWake = () => {
      const snapshot = readTerminalSnapshotFromGatewayDedupe(params);
      if (snapshot) {
        finish(snapshot);
      }
    };

    const removeWaiterLocal: (() => void) | undefined = addWaiter(params.runId, onWake);
    onWake();
    if (settled) {
      return;
    }

    const timeoutHandle: NodeJS.Timeout | undefined = setSafeTimeout(
      () => finish(null),
      params.timeoutMs,
    );
    timeoutHandle.unref?.();

    const onAbort: (() => void) | undefined = () => finish(null);
    params.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function setGatewayDedupeEntry(params: {
  dedupe: Map<string, DedupeEntry>;
  key: string;
  entry: DedupeEntry;
}) {
  // Preserve sticky terminal outcomes before publishing the new entry. This
  // protects waiters from late accepted/in-flight rewrites for the same run id.
  const existing = params.dedupe.get(params.key);
  const existingSnapshot = existing ? readTerminalSnapshotFromDedupeEntry(existing) : null;
  const incomingSnapshot = readTerminalSnapshotFromDedupeEntry(params.entry);
  const existingOutcome = existingSnapshot
    ? terminalOutcomeFromWaitSnapshot(existingSnapshot)
    : undefined;
  const incomingOutcome = incomingSnapshot
    ? terminalOutcomeFromWaitSnapshot(incomingSnapshot)
    : undefined;
  if (existingOutcome && isStickyAgentRunTerminalOutcome(existingOutcome) && !incomingOutcome) {
    // Accepted/in-flight rewrites are not evidence against a terminal hard
    // timeout or explicit cancellation already stored for this run id.
    return;
  }
  if (existingOutcome && incomingOutcome && isStickyAgentRunTerminalOutcome(existingOutcome)) {
    const merged = mergeAgentRunTerminalOutcome(existingOutcome, incomingOutcome);
    if (merged === existingOutcome) {
      return;
    }
  }
  params.dedupe.set(params.key, params.entry);
  const runId = parseRunIdFromDedupeKey(params.key);
  if (!runId) {
    return;
  }
  if (!incomingSnapshot) {
    return;
  }
  notifyWaiters(runId);
}

export const testing = {
  getWaiterCount(runId?: string): number {
    if (runId) {
      return AGENT_WAITERS_BY_RUN_ID.get(runId)?.size ?? 0;
    }
    let total = 0;
    for (const waiters of AGENT_WAITERS_BY_RUN_ID.values()) {
      total += waiters.size;
    }
    return total;
  },
  resetWaiters() {
    AGENT_WAITERS_BY_RUN_ID.clear();
  },
};
export { testing as __testing };
