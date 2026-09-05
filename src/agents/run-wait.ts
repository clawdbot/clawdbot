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
import { hasRetryableConnectionErrorCode } from "../infra/retryable-network-errors.js";
import { normalizeBlockedLivenessWaitStatus } from "../shared/agent-liveness.js";
import {
  isOpenClawMessageToolMirrorAssistantMessage,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../shared/transcript-only-openclaw-assistant.js";
import {
  buildAgentRunTerminalOutcomeFromWaitResult,
  type AgentRunTerminalOutcome,
} from "./agent-run-terminal-outcome.js";
import { normalizeAgentRunTerminalReceipt } from "./agent-run-terminal-receipt.js";
import { normalizeAgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.js";
import {
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
} from "./run-timeout-attribution.js";
import type { AgentWaitResult } from "./run-wait.types.js";
import { extractStoredAssistantText, stripToolMessages } from "./tools/chat-history-text.js";

export type { AgentWaitResult };

type GatewayCaller = typeof callGateway;

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

/** Summary returned after waiting for a dynamic set of pending runs to drain. */
type AgentRunsDrainResult = {
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
  terminalReply?: unknown;
  terminalReceipt?: unknown;
};

function normalizeAgentWaitResult(
  status: AgentWaitResult["status"],
  runId: string,
  wait?: RawAgentWaitResponse,
): AgentWaitResult {
  const receipt = normalizeAgentRunTerminalReceipt(wait?.terminalReceipt);
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
    terminalReply: normalizeAgentRunTerminalReplySnapshot(wait?.terminalReply),
    sourceReplyDelivered:
      receipt?.runId === runId && receipt.sourceReplyDelivered === true ? true : undefined,
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
];

/** Return true for transient gateway/transport failures that callers may retry. */
function isRecoverableAgentWaitError(error: string | undefined): boolean {
  const message = error?.trim();
  if (!message) {
    return false;
  }
  if (message.includes("gateway timeout") || message.includes("gateway request timeout")) {
    return false;
  }
  return (
    hasRetryableConnectionErrorCode(message) ||
    RECOVERABLE_AGENT_WAIT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
  );
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

function isAssistantReplyTranscriptArtifact(message: unknown): boolean {
  return (
    isTranscriptOnlyOpenClawAssistantMessage(message) ||
    isOpenClawMessageToolMirrorAssistantMessage(message) ||
    isInterSessionInputMessage(message)
  );
}

function isInterSessionInputMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const provenance = (message as { provenance?: unknown }).provenance;
  return (
    Boolean(provenance) &&
    typeof provenance === "object" &&
    !Array.isArray(provenance) &&
    (provenance as { kind?: unknown }).kind === "inter_session"
  );
}

/** Read the latest model-authored assistant text from session history. */
export async function readLatestAssistantReply(params: {
  sessionKey: string;
  agentId?: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<string | undefined> {
  const history = await (params.callGateway ?? callGateway)<{ messages: unknown[] }>({
    method: "chat.history",
    params: {
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      limit: params.limit ?? 50,
    },
  });
  const messages = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isAssistantReplyTranscriptArtifact(message)) {
      continue;
    }
    const text = extractStoredAssistantText(message);
    if (text?.trim()) {
      return text;
    }
  }
  return undefined;
}

/** Wait for one agent run through the gateway and normalize timeout/error states. */
export async function waitForAgentRun(params: {
  runId: string;
  timeoutMs: number;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult> {
  const timeoutMs = resolveRunWaitTimeoutMs(params.timeoutMs);
  try {
    const wait = await (params.callGateway ?? callGateway)({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs,
      },
      timeoutMs: addTimerTimeoutGraceMs(timeoutMs, 2_000),
    });
    if (wait?.status === "timeout") {
      return normalizeAgentWaitResult("timeout", params.runId, wait);
    }
    if (wait?.status === "pending") {
      return normalizeAgentWaitResult("pending", params.runId, wait);
    }
    if (wait?.status === "error") {
      return normalizeAgentWaitResult("error", params.runId, wait);
    }
    return normalizeAgentWaitResult("ok", params.runId, wait);
  } catch (err) {
    const error = formatErrorMessage(err);
    return {
      status:
        error.includes("gateway timeout") || error.includes("gateway request timeout")
          ? "timeout"
          : "error",
      error,
      ...(isRecoverableAgentWaitError(error) ? { retryableTransportError: true as const } : {}),
    };
  }
}

/** Read the completed run's reply without inferring delivery from display history. */
export async function waitForAgentRunReply(params: {
  runId: string;
  timeoutMs: number;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult & { replyText?: string }> {
  const wait = await waitForAgentRun(params);
  return wait.status === "ok" && wait.terminalReply?.disposition === "visible"
    ? { ...wait, replyText: wait.terminalReply.text }
    : wait;
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
