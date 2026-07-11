// Agent job tracking owns terminal run state and `agent.wait` resolution.
// Gateway dedupe retains response payloads only for idempotent RPC replay.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  buildAgentRunTerminalOutcome,
  isStickyAgentRunTerminalOutcome,
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { isNonTerminalAgentRunStatus } from "../../shared/agent-run-status.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import type { DedupeEntry } from "../server-shared.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
const AGENT_RUN_CACHE_MAX_ENTRIES = 5_000;

export type AgentJobTerminalSnapshot = {
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

type AgentJobSource = "agent" | "chat" | "lifecycle";
type AgentRunObservation = AgentJobTerminalSnapshot & {
  runId: string;
  source: AgentJobSource;
  recordedAt: number;
  version: number;
};
type AgentRunSnapshot = AgentRunObservation & { cachedAt: number };
type PendingAgentRunTerminal = {
  snapshot: AgentRunObservation;
  timer: NodeJS.Timeout;
};
type AgentJobRecord = {
  cachedAt: number;
  snapshotsBySource: Map<AgentJobSource, AgentRunSnapshot>;
};
type AgentJobWaiter = () => void;
type DedupeObservation =
  | { state: "active" }
  | { state: "terminal"; snapshot: AgentJobTerminalSnapshot }
  | { state: "untracked" };

const agentJobs = new Map<string, AgentJobRecord>();
const agentRunStarts = new Map<string, number>();
const pendingAgentRunErrors = new Map<string, PendingAgentRunTerminal>();
const pendingAgentRunTimeouts = new Map<string, PendingAgentRunTerminal>();
const agentRunWaiters = new Map<string, Set<AgentJobWaiter>>();
let agentRunListenerStarted = false;
let agentRunVersion = 0;

function nextAgentRunVersion(): number {
  agentRunVersion += 1;
  return agentRunVersion;
}

function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, job] of agentJobs) {
    if (now - job.cachedAt <= AGENT_RUN_CACHE_TTL_MS) {
      continue;
    }
    agentJobs.delete(runId);
  }
}

function enforceAgentRunCacheMaxEntries() {
  if (agentJobs.size <= AGENT_RUN_CACHE_MAX_ENTRIES) {
    return;
  }
  const toRemove = agentJobs.size - AGENT_RUN_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const runId of agentJobs.keys()) {
    if (removed >= toRemove) {
      break;
    }
    if ((agentRunWaiters.get(runId)?.size ?? 0) > 0) {
      continue;
    }
    agentJobs.delete(runId);
    removed += 1;
  }
}

function terminalOutcomeFromSnapshot(
  snapshot: AgentJobTerminalSnapshot,
): AgentRunTerminalOutcome | undefined {
  if (snapshot.pendingError) {
    return undefined;
  }
  return buildAgentRunTerminalOutcome(snapshot);
}

function shouldPreserveTerminalSnapshot(
  existing: AgentJobTerminalSnapshot,
  incoming: AgentJobTerminalSnapshot,
): boolean {
  const existingOutcome = terminalOutcomeFromSnapshot(existing);
  const incomingOutcome = terminalOutcomeFromSnapshot(incoming);
  if (!existingOutcome || !incomingOutcome) {
    return false;
  }
  return mergeAgentRunTerminalOutcome(existingOutcome, incomingOutcome) === existingOutcome;
}

function mergeSnapshot(
  existing: AgentRunSnapshot | undefined,
  incoming: AgentRunSnapshot,
): AgentRunSnapshot {
  if (!existing || !shouldPreserveTerminalSnapshot(existing, incoming)) {
    return incoming;
  }
  return { ...existing, cachedAt: incoming.cachedAt };
}

function notifyAgentRunWaiters(runId: string) {
  for (const waiter of agentRunWaiters.get(runId) ?? []) {
    waiter();
  }
}

function recordAgentRunSnapshot(
  snapshot: Omit<AgentRunObservation, "version">,
  version = nextAgentRunVersion(),
) {
  const entry = { ...snapshot, cachedAt: Date.now(), version };
  pruneAgentRunCache(entry.cachedAt);

  const existing = agentJobs.get(entry.runId);
  const snapshotsBySource =
    existing?.snapshotsBySource ?? new Map<AgentJobSource, AgentRunSnapshot>();
  const sourceSnapshot = mergeSnapshot(snapshotsBySource.get(entry.source), entry);
  snapshotsBySource.set(entry.source, sourceSnapshot);
  agentJobs.set(entry.runId, {
    cachedAt: entry.cachedAt,
    snapshotsBySource,
  });
  enforceAgentRunCacheMaxEntries();
  notifyAgentRunWaiters(entry.runId);
}

function clearPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunErrors.delete(runId);
}

function clearPendingAgentRunTimeout(runId: string) {
  const pending = pendingAgentRunTimeouts.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunTimeouts.delete(runId);
}

function beginAgentJob(runId: string, startedAt?: number) {
  nextAgentRunVersion();
  clearPendingAgentRunError(runId);
  clearPendingAgentRunTimeout(runId);
  agentJobs.delete(runId);
  if (startedAt !== undefined) {
    agentRunStarts.set(runId, startedAt);
  }
}

function schedulePendingAgentRunTerminal(
  pendingRuns: Map<string, PendingAgentRunTerminal>,
  snapshot: AgentRunObservation,
) {
  const existing = pendingRuns.get(snapshot.runId);
  if (existing && shouldPreserveTerminalSnapshot(existing.snapshot, snapshot)) {
    return;
  }
  if (pendingRuns === pendingAgentRunErrors) {
    clearPendingAgentRunError(snapshot.runId);
  } else {
    clearPendingAgentRunTimeout(snapshot.runId);
  }
  const timer = setSafeTimeout(() => {
    const pending = pendingRuns.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingRuns.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot, pending.snapshot.version);
  }, AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
  timer.unref?.();
  pendingRuns.set(snapshot.runId, { snapshot, timer });
}

function schedulePendingAgentRunError(snapshot: AgentRunObservation) {
  const pendingTimeout = pendingAgentRunTimeouts.get(snapshot.runId);
  if (pendingTimeout && shouldPreserveTerminalSnapshot(pendingTimeout.snapshot, snapshot)) {
    return;
  }
  clearPendingAgentRunTimeout(snapshot.runId);
  schedulePendingAgentRunTerminal(pendingAgentRunErrors, snapshot);
}

function schedulePendingAgentRunTimeout(snapshot: AgentRunObservation) {
  const pendingTimeout = pendingAgentRunTimeouts.get(snapshot.runId);
  if (pendingTimeout && shouldPreserveTerminalSnapshot(pendingTimeout.snapshot, snapshot)) {
    return;
  }
  clearPendingAgentRunError(snapshot.runId);
  schedulePendingAgentRunTerminal(pendingAgentRunTimeouts, snapshot);
}

function createPendingErrorTimeoutSnapshot(
  snapshot: AgentJobTerminalSnapshot,
): AgentJobTerminalSnapshot {
  return {
    status: "timeout",
    startedAt: snapshot.startedAt,
    error: snapshot.error,
    pendingError: true,
    ...(snapshot.providerStarted !== undefined
      ? { providerStarted: snapshot.providerStarted }
      : {}),
  };
}

function createSnapshotFromLifecycleEvent(params: {
  runId: string;
  phase: "end" | "error";
  data?: Record<string, unknown>;
}): AgentRunObservation {
  const { runId, phase, data } = params;
  const startedAt =
    typeof data?.startedAt === "number" ? data.startedAt : agentRunStarts.get(runId);
  const endedAt = typeof data?.endedAt === "number" ? data.endedAt : undefined;
  const error = typeof data?.error === "string" ? data.error : undefined;
  const stopReason = typeof data?.stopReason === "string" ? data.stopReason : undefined;
  const livenessState = typeof data?.livenessState === "string" ? data.livenessState : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcome({
    status: phase === "error" ? "error" : data?.aborted ? "timeout" : "ok",
    error,
    stopReason,
    livenessState,
    timeoutPhase: data?.timeoutPhase,
    providerStarted: data?.providerStarted,
    startedAt,
    endedAt,
  });
  return {
    runId,
    source: "lifecycle",
    recordedAt: Date.now(),
    status: terminalOutcome.status,
    startedAt,
    endedAt,
    error: terminalOutcome.error,
    stopReason,
    livenessState,
    ...(data?.yielded === true ? { yielded: true } : {}),
    ...(terminalOutcome.timeoutPhase ? { timeoutPhase: terminalOutcome.timeoutPhase } : {}),
    ...(terminalOutcome.providerStarted !== undefined
      ? { providerStarted: terminalOutcome.providerStarted }
      : {}),
    version: nextAgentRunVersion(),
  };
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : Date.now();
      beginAgentJob(evt.runId, startedAt);
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const snapshot = createSnapshotFromLifecycleEvent({
      runId: evt.runId,
      phase,
      data: evt.data,
    });
    agentRunStarts.delete(evt.runId);
    if (phase === "error") {
      schedulePendingAgentRunError(snapshot);
      return;
    }
    if (snapshot.status === "timeout") {
      schedulePendingAgentRunTimeout(snapshot);
      return;
    }
    const pendingTimeout = pendingAgentRunTimeouts.get(evt.runId);
    if (pendingTimeout && shouldPreserveTerminalSnapshot(pendingTimeout.snapshot, snapshot)) {
      return;
    }
    clearPendingAgentRunError(evt.runId);
    clearPendingAgentRunTimeout(evt.runId);
    recordAgentRunSnapshot(snapshot, snapshot.version);
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseDedupeObservation(entry: DedupeEntry): DedupeObservation {
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
    return { state: "active" };
  }

  const terminalStatus =
    status === "ok" || status === "timeout" || status === "error"
      ? status
      : entry.ok
        ? undefined
        : "error";
  if (!terminalStatus) {
    return { state: "untracked" };
  }

  const resultMeta = asOptionalRecord(asOptionalRecord(payload?.result)?.meta);
  const startedAt = asFiniteNumber(payload?.startedAt);
  const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
  const stopReason = asString(payload?.stopReason) ?? asString(resultMeta?.stopReason);
  const livenessState = asString(payload?.livenessState) ?? asString(resultMeta?.livenessState);
  const terminalOutcome = buildAgentRunTerminalOutcome({
    status: terminalStatus,
    startedAt,
    endedAt,
    error:
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.summary === "string"
          ? payload.summary
          : entry.error?.message,
    stopReason,
    livenessState,
    timeoutPhase: payload?.timeoutPhase ?? resultMeta?.timeoutPhase,
    providerStarted: payload?.providerStarted ?? resultMeta?.providerStarted,
  });
  return {
    state: "terminal",
    snapshot: {
      status: terminalOutcome.status,
      startedAt,
      endedAt,
      error: terminalOutcome.status === "ok" ? undefined : terminalOutcome.error,
      stopReason,
      livenessState,
      ...(payload?.yielded === true || resultMeta?.yielded === true ? { yielded: true } : {}),
      ...(terminalOutcome.timeoutPhase ? { timeoutPhase: terminalOutcome.timeoutPhase } : {}),
      ...(terminalOutcome.providerStarted !== undefined
        ? { providerStarted: terminalOutcome.providerStarted }
        : {}),
    },
  };
}

function parseDedupeKey(key: string): { runId: string; source: "agent" | "chat" } | undefined {
  const separator = key.indexOf(":");
  if (separator === -1) {
    return undefined;
  }
  const source = key.slice(0, separator);
  const runId = key.slice(separator + 1);
  if ((source !== "agent" && source !== "chat") || !runId) {
    return undefined;
  }
  return { runId, source };
}

export function setGatewayDedupeEntry(params: {
  dedupe: Map<string, DedupeEntry>;
  key: string;
  entry: DedupeEntry;
}) {
  const existing = params.dedupe.get(params.key);
  const existingObservation = existing ? parseDedupeObservation(existing) : undefined;
  const incomingObservation = parseDedupeObservation(params.entry);
  const existingOutcome =
    existingObservation?.state === "terminal"
      ? terminalOutcomeFromSnapshot(existingObservation.snapshot)
      : undefined;
  const incomingOutcome =
    incomingObservation.state === "terminal"
      ? terminalOutcomeFromSnapshot(incomingObservation.snapshot)
      : undefined;
  if (existingOutcome && isStickyAgentRunTerminalOutcome(existingOutcome) && !incomingOutcome) {
    return;
  }
  if (existingOutcome && incomingOutcome && isStickyAgentRunTerminalOutcome(existingOutcome)) {
    if (mergeAgentRunTerminalOutcome(existingOutcome, incomingOutcome) === existingOutcome) {
      return;
    }
  }

  params.dedupe.set(params.key, params.entry);
  const key = parseDedupeKey(params.key);
  if (!key) {
    return;
  }
  if (incomingObservation.state === "active") {
    beginAgentJob(key.runId);
    return;
  }
  if (incomingObservation.state === "terminal") {
    recordAgentRunSnapshot({
      ...incomingObservation.snapshot,
      runId: key.runId,
      source: key.source,
      recordedAt: params.entry.ts,
    });
  }
}

function getFreshestDedupeSnapshot(
  snapshotsBySource: Map<AgentJobSource, AgentRunSnapshot>,
): AgentRunSnapshot | undefined {
  const agent = snapshotsBySource.get("agent");
  const chat = snapshotsBySource.get("chat");
  if (agent && chat) {
    return chat.recordedAt > agent.recordedAt ? chat : agent;
  }
  return agent ?? chat;
}

function getCanonicalAgentRunSnapshot(
  snapshotsBySource: Map<AgentJobSource, AgentRunSnapshot>,
): AgentRunSnapshot | undefined {
  const dedupe = getFreshestDedupeSnapshot(snapshotsBySource);
  const lifecycle = snapshotsBySource.get("lifecycle");
  if (!dedupe || !lifecycle) {
    return dedupe ?? lifecycle;
  }
  return dedupe.version > lifecycle.version
    ? mergeSnapshot(lifecycle, dedupe)
    : mergeSnapshot(dedupe, lifecycle);
}

function getAgentRunSnapshot(params: {
  runId: string;
  source?: "chat";
  afterVersion: number;
}): AgentRunSnapshot | undefined {
  pruneAgentRunCache();
  const job = agentJobs.get(params.runId);
  const snapshot = params.source
    ? job?.snapshotsBySource.get(params.source)
    : job
      ? getCanonicalAgentRunSnapshot(job.snapshotsBySource)
      : undefined;
  return snapshot && snapshot.version > params.afterVersion ? snapshot : undefined;
}

function addAgentRunWaiter(runId: string, waiter: AgentJobWaiter): () => void {
  const waiters = agentRunWaiters.get(runId) ?? new Set<AgentJobWaiter>();
  waiters.add(waiter);
  agentRunWaiters.set(runId, waiters);
  return () => {
    waiters.delete(waiter);
    if (waiters.size === 0) {
      agentRunWaiters.delete(runId);
    }
  };
}

function publicSnapshot(snapshot: AgentRunObservation): AgentJobTerminalSnapshot {
  return {
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    error: snapshot.error,
    stopReason: snapshot.stopReason,
    livenessState: snapshot.livenessState,
    yielded: snapshot.yielded,
    pendingError: snapshot.pendingError,
    timeoutPhase: snapshot.timeoutPhase,
    providerStarted: snapshot.providerStarted,
  };
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
  ignoreCachedSnapshot?: boolean;
  source?: "chat";
}): Promise<AgentJobTerminalSnapshot | null> {
  ensureAgentRunListener();
  const afterVersion = params.ignoreCachedSnapshot ? agentRunVersion : -1;
  const cached = getAgentRunSnapshot({
    runId: params.runId,
    source: params.source,
    afterVersion,
  });
  if (cached) {
    return publicSnapshot(cached);
  }
  if (params.timeoutMs <= 0) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let removeWaiter = () => {};
    const finish = (snapshot: AgentJobTerminalSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      removeWaiter();
      resolve(snapshot);
    };
    const onWake = () => {
      const snapshot = getAgentRunSnapshot({
        runId: params.runId,
        source: params.source,
        afterVersion,
      });
      if (snapshot) {
        finish(publicSnapshot(snapshot));
      }
    };
    removeWaiter = addAgentRunWaiter(params.runId, onWake);
    const timeoutHandle = setSafeTimeout(() => {
      if (!params.source) {
        const pendingError = pendingAgentRunErrors.get(params.runId)?.snapshot;
        if (pendingError && pendingError.version > afterVersion) {
          finish(createPendingErrorTimeoutSnapshot(pendingError));
          return;
        }
        const pendingTimeout = pendingAgentRunTimeouts.get(params.runId)?.snapshot;
        if (
          pendingTimeout &&
          pendingTimeout.version > afterVersion &&
          terminalOutcomeFromSnapshot(pendingTimeout)?.reason === "hard_timeout"
        ) {
          finish(publicSnapshot(pendingTimeout));
          return;
        }
      }
      finish(null);
    }, params.timeoutMs);
    timeoutHandle.unref?.();
    onWake();
  });
}

ensureAgentRunListener();

export const testing = {
  getWaiterCount(runId?: string): number {
    if (runId) {
      return agentRunWaiters.get(runId)?.size ?? 0;
    }
    let total = 0;
    for (const waiters of agentRunWaiters.values()) {
      total += waiters.size;
    }
    return total;
  },
  getAgentRunCacheSize(): number {
    return agentJobs.size;
  },
  resetAgentRunCache(): void {
    agentJobs.clear();
  },
  resetAgentJobs(): void {
    agentJobs.clear();
    agentRunStarts.clear();
    agentRunVersion = 0;
    for (const pending of pendingAgentRunErrors.values()) {
      clearTimeout(pending.timer);
    }
    for (const pending of pendingAgentRunTimeouts.values()) {
      clearTimeout(pending.timer);
    }
    pendingAgentRunErrors.clear();
    pendingAgentRunTimeouts.clear();
    agentRunWaiters.clear();
  },
  getTerminalSnapshot(runId: string, source?: "chat"): AgentJobTerminalSnapshot | null {
    const snapshot = getAgentRunSnapshot({ runId, source, afterVersion: -1 });
    return snapshot ? publicSnapshot(snapshot) : null;
  },
  agentRunCacheMaxEntries: AGENT_RUN_CACHE_MAX_ENTRIES,
};
export { testing as __testing };
