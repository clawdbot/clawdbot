/**
 * Gateway-backed agent run wait helpers.
 * Normalizes run wait responses, reads the latest assistant reply, and drains
 * pending run sets for tools that need synchronous completion semantics.
 */
import {
  addTimerTimeoutGraceMs,
  asDateTimestampMs,
  clampTimerTimeoutMs,
  parseFiniteNumber,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeBlockedLivenessWaitStatus } from "../shared/agent-liveness.js";
import {
  buildAgentRunTerminalOutcomeFromWaitResult,
  type AgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";
import {
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
  type AgentRunTimeoutPhase,
} from "./run-timeout-attribution.js";
import { extractAssistantText, stripToolMessages } from "./tools/chat-history-text.js";

type GatewayCaller = typeof callGateway;

const defaultRunWaitDeps = {
  callGateway,
};

let runWaitDeps: {
  callGateway: GatewayCaller;
} = defaultRunWaitDeps;

function resolveRunWaitTimeoutMs(value: number | undefined): number {
  return clampTimerTimeoutMs(parseFiniteNumber(value) ?? 1) ?? 1;
}

function resolveRunWaitDeadlineAtMs(params: { deadlineAtMs?: number; timeoutMs?: number }): number {
  if (params.deadlineAtMs !== undefined) {
    return asDateTimestampMs(params.deadlineAtMs) ?? resolveDateTimestampMs(Date.now());
  }
  return (
    resolveExpiresAtMsFromDurationMs(resolveRunWaitTimeoutMs(params.timeoutMs)) ??
    resolveDateTimestampMs(Date.now())
  );
}

/** Latest assistant reply plus a stable fingerprint for baseline comparisons. */
export type AssistantReplySnapshot = {
  text?: string;
  fingerprint?: string;
};

/** Normalized terminal or pending state returned by `agent.wait`. */
export type AgentWaitResult = {
  status: "ok" | "timeout" | "error" | "pending";
  error?: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
};

/** Summary returned after waiting for a dynamic set of pending runs to drain. */
export type AgentRunsDrainResult = {
  timedOut: boolean;
  pendingRunIds: string[];
  deadlineAtMs: number;
};

type RawAgentWaitResponse = {
  status?: string;
  error?: string;
  startedAt?: unknown;
  endedAt?: unknown;
  stopReason?: unknown;
  livenessState?: unknown;
  yielded?: unknown;
  pendingError?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
};

function normalizeAgentWaitResult(
  status: AgentWaitResult["status"],
  wait?: RawAgentWaitResponse,
): AgentWaitResult {
  const stopReason = typeof wait?.stopReason === "string" ? wait.stopReason : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult({ ...wait, status });
  const normalized = normalizeTerminalOutcomeForWait(terminalOutcome, status, wait?.livenessState);
  return {
    status: normalized.status,
    error: normalized.error,
    startedAt: typeof wait?.startedAt === "number" ? wait.startedAt : undefined,
    endedAt: typeof wait?.endedAt === "number" ? wait.endedAt : undefined,
    stopReason,
    livenessState: typeof wait?.livenessState === "string" ? wait.livenessState : undefined,
    yielded: wait?.yielded === true ? true : undefined,
    pendingError: wait?.pendingError === true ? true : undefined,
    timeoutPhase: normalizeAgentRunTimeoutPhase(wait?.timeoutPhase),
    providerStarted: normalizeProviderStarted(wait?.providerStarted),
  };
}

function normalizeTerminalOutcomeForWait(
  outcome: AgentRunTerminalOutcome | undefined,
  fallbackStatus: AgentWaitResult["status"],
  livenessState?: unknown,
): { status: AgentWaitResult["status"]; error?: string } {
  if (outcome?.reason === "hard_timeout") {
    return { status: outcome.status, error: outcome.error };
  }
  return normalizeBlockedLivenessWaitStatus({
    status: outcome?.status ?? fallbackStatus,
    livenessState,
    error: outcome?.error,
  });
}

const RECOVERABLE_AGENT_WAIT_ERROR_PATTERNS: readonly RegExp[] = [
  /gateway closed \(1006/i,
  /transport close/i,
  /connection loss/i,
  /connection closed/i,
  /gateway not connected/i,
  /no active .* listener/i,
  /socket hang up/i,
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/i,
];

/** Return true for transient gateway/transport failures that callers may retry. */
export function isRecoverableAgentWaitError(error: string | undefined): boolean {
  const message = error?.trim();
  if (!message) {
    return false;
  }
  if (message.includes("gateway timeout")) {
    return false;
  }
  return RECOVERABLE_AGENT_WAIT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function normalizePendingRunIds(runIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const runId of runIds) {
    const normalized = runId.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
  }
  return [...seen];
}

function resolveLatestAssistantReplySnapshot(messages: unknown[]): AssistantReplySnapshot {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(candidate);
    if (!text?.trim()) {
      continue;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = JSON.stringify(candidate);
    } catch {
      fingerprint = text;
    }
    return { text, fingerprint };
  }
  return {};
}

/** Read the latest non-tool assistant message for a session. */
export async function readLatestAssistantReplySnapshot(params: {
  sessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<AssistantReplySnapshot> {
  const history = await (params.callGateway ?? runWaitDeps.callGateway)<{
    messages: Array<unknown>;
  }>({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
  });
  return resolveLatestAssistantReplySnapshot(
    stripToolMessages(Array.isArray(history?.messages) ? history.messages : []),
  );
}

/** Read only the latest assistant text for call sites that do not need fingerprints. */
export async function readLatestAssistantReply(params: {
  sessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<string | undefined> {
  return (
    await readLatestAssistantReplySnapshot({
      sessionKey: params.sessionKey,
      limit: params.limit,
      callGateway: params.callGateway,
    })
  ).text;
}

/** Wait for one agent run through the gateway and normalize timeout/error states. */
export async function waitForAgentRun(params: {
  runId: string;
  timeoutMs: number;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult> {
  const timeoutMs = resolveRunWaitTimeoutMs(params.timeoutMs);
  try {
    const wait = await (params.callGateway ?? runWaitDeps.callGateway)({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs,
      },
      timeoutMs: addTimerTimeoutGraceMs(timeoutMs, 2_000),
    });
    if (wait?.status === "timeout") {
      return normalizeAgentWaitResult("timeout", wait);
    }
    if (wait?.status === "pending") {
      return normalizeAgentWaitResult("pending", wait);
    }
    if (wait?.status === "error") {
      return normalizeAgentWaitResult("error", wait);
    }
    return normalizeAgentWaitResult("ok", wait);
  } catch (err) {
    const error = formatErrorMessage(err);
    return {
      status: error.includes("gateway timeout") ? "timeout" : "error",
      error,
    };
  }
}

/** Wait for a run and return a reply only when it differs from the supplied baseline. */
export async function waitForAgentRunAndReadUpdatedAssistantReply(params: {
  runId: string;
  sessionKey: string;
  timeoutMs: number;
  limit?: number;
  baseline?: AssistantReplySnapshot;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult & { replyText?: string }> {
  const wait = await waitForAgentRun({
    runId: params.runId,
    timeoutMs: params.timeoutMs,
    callGateway: params.callGateway,
  });
  if (wait.status !== "ok") {
    return wait;
  }

  const latestReply = await readLatestAssistantReplySnapshot({
    sessionKey: params.sessionKey,
    limit: params.limit,
    callGateway: params.callGateway,
  });
  const baselineFingerprint = params.baseline?.fingerprint;
  const replyText =
    latestReply.text && (!baselineFingerprint || latestReply.fingerprint !== baselineFingerprint)
      ? latestReply.text
      : undefined;
  return {
    status: "ok",
    replyText,
  };
}

/** Wait until the current and newly spawned pending run IDs are drained or timed out. */
export async function waitForAgentRunsToDrain(params: {
  getPendingRunIds: () => Iterable<string>;
  initialPendingRunIds?: Iterable<string>;
  timeoutMs?: number;
  deadlineAtMs?: number;
  callGateway?: GatewayCaller;
}): Promise<AgentRunsDrainResult> {
  const deadlineAtMs = resolveRunWaitDeadlineAtMs(params);

  // Runs may finish and spawn more runs, so refresh until no pending IDs remain.
  let pendingRunIds = new Set<string>(
    normalizePendingRunIds(params.initialPendingRunIds ?? params.getPendingRunIds()),
  );

  while (pendingRunIds.size > 0 && Date.now() < deadlineAtMs) {
    const remainingMs = Math.max(1, deadlineAtMs - Date.now());
    await Promise.allSettled(
      [...pendingRunIds].map((runId) =>
        waitForAgentRun({
          runId,
          timeoutMs: remainingMs,
          callGateway: params.callGateway,
        }),
      ),
    );
    pendingRunIds = new Set<string>(normalizePendingRunIds(params.getPendingRunIds()));
  }

  return {
    timedOut: pendingRunIds.size > 0,
    pendingRunIds: [...pendingRunIds],
    deadlineAtMs,
  };
}

/** Test-only dependency injection for gateway calls. */
export const testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    runWaitDeps = overrides
      ? {
          ...defaultRunWaitDeps,
          ...overrides,
        }
      : defaultRunWaitDeps;
  },
};
export { testing as __testing };
