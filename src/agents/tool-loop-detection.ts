/**
 * Tool-call loop detection.
 *
 * Watches recent tool history for repeated no-progress patterns and circuit-breaker thresholds.
 */
import { stableStringify } from "@openclaw/normalization-core";
import {
  normalizeNullableString as nonEmptyStringField,
  normalizeOptionalString as normalizeRunId,
} from "@openclaw/normalization-core/string-coerce";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import type { SessionState, ToolCallRecord } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPlainObject } from "../utils.js";
import { isMessagingToolSendAction } from "./embedded-agent-messaging.js";
import {
  buildArgumentChurnWarning,
  getToolArgumentChurnStreak,
} from "./tool-loop-argument-churn.js";
import { isKnownPollToolCall } from "./tool-loop-call-kind.js";
import { getNoProgressStreak } from "./tool-loop-no-progress.js";
import { TOOL_LOOP_WARNING_THRESHOLD } from "./tool-loop-thresholds.js";
import { hashWriteMutationTarget, isWriteNoProgressOutcome } from "./tool-loop-write-outcome.js";

const log = createSubsystemLogger("agents/loop-detection");

type LoopDetectorKind =
  | "generic_repeat"
  | "argument_churn"
  | "unknown_tool_repeat"
  | "known_poll_no_progress"
  | "global_circuit_breaker"
  | "ping_pong";

type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: LoopDetectorKind;
      count: number;
      message: string;
      pairedToolName?: string;
      warningKey?: string;
      livenessSignal?: "argument_churn";
    };

const TOOL_CALL_HISTORY_SIZE = 30;
export const UNKNOWN_TOOL_THRESHOLD = 10;
const CRITICAL_THRESHOLD = 20;
const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

type ToolLoopDetectionScope = { runId?: string; cwd?: string };

function selectHistoryForScope(
  history: readonly ToolCallRecord[],
  scope?: ToolLoopDetectionScope,
): ToolCallRecord[] {
  const runId = normalizeRunId(scope?.runId);
  return history.filter((record) => normalizeRunId(record.runId) === runId);
}

/**
 * Hash a tool call for pattern matching.
 * Uses tool name + deterministic JSON serialization digest of params.
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${sha256Hex(stableStringify(params))}`;
}

function digestToolOutcome(value: unknown): string {
  // Canonical IDs retain valid envelope syntax; malformed markers and JSON field
  // boundaries remain meaningful. Literal/copied envelopes share this syntax rule;
  // it grants no trust and never changes arguments or delivered content.
  const canonicalMarkerId = "0000000000000000";
  const serialized = stableStringify(value, (text) =>
    text.replace(
      /(<<<EXTERNAL_UNTRUSTED_CONTENT id=(\\*)")([a-f0-9]{16})(\2">>>(?:(?!<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT)[\s\S])*<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\2")\3(\2">>>)/g,
      // Repeated JSON encoding produces 2^n - 1 backslashes before marker quotes.
      (match, start: string, escapes: string, _id: string, middle: string, end: string) =>
        (escapes.length & (escapes.length + 1)) !== 0 ||
        [...middle.matchAll(/(?<!\\)\\*"/g)].some(
          (quote) => quote[0].length % (escapes.length + 1) !== 0,
        )
          ? match
          : start + canonicalMarkerId + middle + canonicalMarkerId + end,
    ),
  );
  return sha256Hex(serialized);
}

function extractTextContent(result: unknown): string {
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .filter(
      (entry): entry is { type: string; text: string } =>
        isPlainObject(entry) && typeof entry.type === "string" && typeof entry.text === "string",
    )
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function formatErrorForHash(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return `${error}`;
  }
  return stableStringify(error);
}

function extractUnknownToolName(error: unknown): string | undefined {
  const raw = formatErrorForHash(error).trim();
  if (!raw) {
    return undefined;
  }
  const match =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_.-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_.-]+)["']?\s+(?:not found|is not available)/i);
  const toolName = match?.[1]?.trim();
  return toolName ? toolName.toLowerCase() : undefined;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hashExecToolOutcome(details: Record<string, unknown>, text: string): string | undefined {
  const status = stringField(details.status);
  if (!status) {
    return undefined;
  }

  if (status === "running") {
    return digestToolOutcome({
      status,
      tail: stringField(details.tail) ?? "",
    });
  }

  if (status === "completed" || status === "failed") {
    return digestToolOutcome({
      status,
      exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
      timedOut: details.timedOut === true,
      output: nonEmptyStringField(details.aggregated) ?? text,
    });
  }

  if (status === "approval-pending" || status === "approval-unavailable") {
    return digestToolOutcome({
      status,
      reason: stringField(details.reason),
      host: stringField(details.host),
      command: stringField(details.command) ?? "",
      warningText: stringField(details.warningText) ?? "",
    });
  }

  return undefined;
}

// Delivery results carry fresh per-call ids (messageId/runId) in details and text, so
// hashing them defeats no-progress loop blocking (#89090). Hash only id-stripped facts
// for outbound-message actions; other `message` actions keep full hashing (real progress).
const SEND_LIKE_MESSAGE_ACTIONS = new Set([
  "send",
  "broadcast",
  "reply",
  "thread-reply",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
  "sticker",
  "poll",
]);
// Denylist of per-call volatile delivery ids/timestamps stripped before hashing. Must
// cover the id/timestamp fields a channel's delivery result can carry; a new channel
// emitting a volatile field name outside this set silently regresses its loop blocking.
const VOLATILE_SEND_RESULT_KEYS = new Set([
  "messageId",
  "message_id",
  "messageIds",
  "platformMessageId",
  "platformMessageIds",
  "fileId",
  "file_id",
  "fileKey",
  "pollId",
  "poll_id",
  "receipt",
  "runId",
  "idempotencyKey",
  "ts",
  "timestamp",
  "sentAt",
  "deliveredAt",
  "createdAt",
]);

// A message object's own `id` is its volatile per-send id; a bare `id` elsewhere
// (route/conversation) is a stable fact, so only strip `id` on the message object.
function isMessageDeliveryObject(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (typeof value.direction === "string" ||
      typeof value.senderId === "string" ||
      typeof value.accountId === "string" ||
      isPlainObject(value.conversation))
  );
}

function stripVolatileSendIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatileSendIds);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const dropMessageObjectId = isMessageDeliveryObject(value);
  const stripped: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (VOLATILE_SEND_RESULT_KEYS.has(key) || (key === "id" && dropMessageObjectId)) {
      continue;
    }
    stripped[key] = stripVolatileSendIds(nested);
  }
  return stripped;
}

function isVolatileSendResult(toolName: string, params: unknown): boolean {
  if (toolName === "sessions_send") {
    return true;
  }
  const args = isPlainObject(params) ? params : {};
  if (toolName === "message") {
    return typeof args.action === "string" && SEND_LIKE_MESSAGE_ACTIONS.has(args.action);
  }
  // Provider-docked send tools (telegram/discord/...) return the same volatile-id shape.
  // SEND_LIKE_MESSAGE_ACTIONS stays broader than the terminal-send set on purpose:
  // broadcast/reply/sticker/poll carry volatile ids but are not terminal sends.
  return isMessagingToolSendAction(toolName, args);
}

// Only the loop detector's own veto must not reset the streak; other blocked results
// (plugin/approval vetoes) keep a hash so repeated identical denials still escalate.
function isLoopVetoResult(details: Record<string, unknown>): boolean {
  return details.status === "blocked" && details.deniedReason === "tool-loop";
}

function hashToolOutcome(
  toolName: string,
  params: unknown,
  result: unknown,
  error: unknown,
): Pick<ToolCallRecord, "outcomeKind" | "resultHash" | "noProgress" | "unknownToolName"> {
  if (error !== undefined) {
    const unknownToolName = extractUnknownToolName(error);
    return {
      resultHash: `error:${digestToolOutcome(formatErrorForHash(error))}`,
      noProgress: true,
      unknownToolName,
    };
  }
  if (!isPlainObject(result)) {
    return { resultHash: result === undefined ? undefined : digestToolOutcome(result) };
  }

  const details = isPlainObject(result.details) ? result.details : {};
  const text = extractTextContent(result);
  // A loop veto extends the prior no-progress streak but is not a real tool outcome.
  // Keep it typed so it cannot reset the streak or collide with plugin/approval denials.
  if (isLoopVetoResult(details)) {
    return { outcomeKind: "tool-loop-veto" };
  }
  if (toolName === "exec") {
    const execHash = hashExecToolOutcome(details, text);
    if (execHash) {
      const exitCode = details.exitCode;
      const output = nonEmptyStringField(details.aggregated) ?? text;
      // Normal nonzero exits append this footer even when the command emitted nothing.
      const terminalFailure =
        (details.status === "completed" || details.status === "failed") &&
        typeof exitCode === "number" &&
        Number.isFinite(exitCode) &&
        exitCode !== 0 &&
        details.timedOut !== true &&
        output !== "" &&
        output !== `(Command exited with code ${exitCode})`;
      return terminalFailure
        ? { resultHash: execHash, outcomeKind: "terminal-exec-failure" }
        : { resultHash: execHash };
    }
  }
  if (toolName === "write" && isWriteNoProgressOutcome(details)) {
    return { resultHash: digestToolOutcome({ status: "unchanged" }), noProgress: true };
  }
  if (toolName === "write" && details.changed === true) {
    return {
      resultHash: digestStable({ details, text }),
      outcomeKind: "write-mutation",
    };
  }
  if (isKnownPollToolCall(toolName, params) && toolName === "process" && isPlainObject(params)) {
    const action = params.action;
    if (action === "poll") {
      return {
        resultHash: digestToolOutcome({
          action,
          status: details.status,
          exitCode: details.exitCode ?? null,
          exitSignal: details.exitSignal ?? null,
          aggregated: details.aggregated ?? null,
          text,
        }),
      };
    }
    if (action === "log") {
      return {
        resultHash: digestToolOutcome({
          action,
          status: details.status,
          totalLines: details.totalLines ?? null,
          totalChars: details.totalChars ?? null,
          truncated: details.truncated ?? null,
          exitCode: details.exitCode ?? null,
          exitSignal: details.exitSignal ?? null,
          text,
        }),
      };
    }
  }

  if (isVolatileSendResult(toolName, params)) {
    return { resultHash: digestToolOutcome(stripVolatileSendIds(details)) };
  }

  return {
    resultHash: digestToolOutcome({
      details,
      text,
    }),
  };
}

function getUnknownToolRepeatStreak(
  history: Array<{ toolName: string; unknownToolName?: string }>,
  toolName: string,
): { count: number; unknownToolName?: string } {
  let streak = 0;
  let repeatedUnknownToolName: string | undefined;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || !record.unknownToolName) {
      break;
    }
    if (!repeatedUnknownToolName) {
      repeatedUnknownToolName = record.unknownToolName;
      streak = 1;
      continue;
    }
    if (record.unknownToolName !== repeatedUnknownToolName) {
      break;
    }
    streak += 1;
  }

  return { count: streak, unknownToolName: repeatedUnknownToolName };
}

function getPingPongStreak(
  history: readonly ToolCallRecord[],
  currentSignature: string,
): {
  count: number;
  pairedToolName?: string;
  pairedSignature?: string;
  noProgressEvidence: boolean;
} {
  const last = history.at(-1);
  if (!last) {
    return { count: 0, noProgressEvidence: false };
  }

  let otherSignature: string | undefined;
  let otherToolName: string | undefined;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash;
      otherToolName = call.toolName;
      break;
    }
  }

  if (!otherSignature || !otherToolName) {
    return { count: 0, noProgressEvidence: false };
  }

  let alternatingTailCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature;
    if (call.argsHash !== expected) {
      break;
    }
    alternatingTailCount += 1;
  }

  if (alternatingTailCount < 2) {
    return { count: 0, noProgressEvidence: false };
  }

  const expectedCurrentSignature = otherSignature;
  if (currentSignature !== expectedCurrentSignature) {
    return { count: 0, noProgressEvidence: false };
  }

  const tailStart = Math.max(0, history.length - alternatingTailCount);
  let firstHashA: string | undefined;
  let firstHashB: string | undefined;
  let noProgressEvidence = true;
  for (let i = tailStart; i < history.length; i += 1) {
    const call = history[i];
    if (!call) {
      continue;
    }
    if (!call.resultHash) {
      noProgressEvidence = false;
      break;
    }
    if (call.argsHash === last.argsHash) {
      if (!firstHashA) {
        firstHashA = call.resultHash;
      } else if (firstHashA !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    if (call.argsHash === otherSignature) {
      if (!firstHashB) {
        firstHashB = call.resultHash;
      } else if (firstHashB !== call.resultHash) {
        noProgressEvidence = false;
        break;
      }
      continue;
    }
    noProgressEvidence = false;
    break;
  }

  // Need repeated stable outcomes on both sides before treating ping-pong as no-progress.
  if (!firstHashA || !firstHashB) {
    noProgressEvidence = false;
  }

  return {
    count: alternatingTailCount + 1,
    pairedToolName: last.toolName,
    pairedSignature: last.argsHash,
    noProgressEvidence,
  };
}

function canonicalPairKey(signatureA: string, signatureB: string): string {
  return [signatureA, signatureB].toSorted().join("|");
}

/**
 * Detect if an agent is stuck in a repetitive tool call loop.
 * Checks if the same tool+params combination has been called excessively.
 */
export function detectToolCallLoop(
  state: SessionState,
  toolName: string,
  params: unknown,
  config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): LoopDetectionResult {
  if (!config?.enabled) {
    return { stuck: false };
  }
  const history = selectHistoryForScope(state.toolCallHistory ?? [], scope);
  const currentHash = hashToolCall(toolName, params);
  const unknownToolStreak = getUnknownToolRepeatStreak(history, toolName);
  const noProgress = getNoProgressStreak(history, toolName, currentHash);
  const noProgressStreak = noProgress.count;
  const argumentChurn = getToolArgumentChurnStreak(history, {
    toolName,
    argsHash: currentHash,
    mutationTargetHash: hashWriteMutationTarget(toolName, params, scope?.cwd),
    timestamp: Date.now(),
  });
  const knownPollTool = isKnownPollToolCall(toolName, params);
  const pingPong = getPingPongStreak(history, currentHash);
  const argumentChurnLivenessSignal =
    argumentChurn.count >= TOOL_LOOP_WARNING_THRESHOLD ? ("argument_churn" as const) : undefined;

  if (unknownToolStreak.count >= UNKNOWN_TOOL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "unknown_tool_repeat",
      count: unknownToolStreak.count,
      message: `CRITICAL: attempted unavailable tool ${unknownToolStreak.unknownToolName ?? toolName} ${unknownToolStreak.count} times. Stop retrying that missing tool and answer without it.`,
      warningKey: `unknown-tool:${toolName}:${unknownToolStreak.unknownToolName ?? "unknown"}`,
    };
  }

  if (noProgressStreak >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
    log.error(
      `Global circuit breaker triggered: ${toolName} repeated ${noProgressStreak} times with no progress`,
    );
    return {
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker to prevent runaway loops.`,
      warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  if (knownPollTool && noProgressStreak >= CRITICAL_THRESHOLD) {
    log.error(`Critical polling loop detected: ${toolName} repeated ${noProgressStreak} times`);
    return {
      stuck: true,
      level: "critical",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. This appears to be a stuck polling loop. Session execution blocked to prevent resource waste.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  if (knownPollTool && noProgressStreak >= TOOL_LOOP_WARNING_THRESHOLD) {
    log.warn(`Polling loop warning: ${toolName} repeated ${noProgressStreak} times`);
    return {
      stuck: true,
      level: "warning",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `WARNING: You have called ${toolName} ${noProgressStreak} times with identical arguments and no progress. Stop polling and either (1) increase wait time between checks, or (2) report the task as failed if the process is stuck.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
      ...(argumentChurnLivenessSignal ? { livenessSignal: argumentChurnLivenessSignal } : {}),
    };
  }

  const pingPongWarningKey = pingPong.pairedSignature
    ? `pingpong:${canonicalPairKey(currentHash, pingPong.pairedSignature)}`
    : `pingpong:${toolName}:${currentHash}`;

  if (pingPong.count >= CRITICAL_THRESHOLD && pingPong.noProgressEvidence) {
    log.error(
      `Critical ping-pong loop detected: alternating calls count=${pingPong.count} currentTool=${toolName}`,
    );
    return {
      stuck: true,
      level: "critical",
      detector: "ping_pong",
      count: pingPong.count,
      message: `CRITICAL: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls) with no progress. This appears to be a stuck ping-pong loop. Session execution blocked to prevent resource waste.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
    };
  }

  if (pingPong.count >= TOOL_LOOP_WARNING_THRESHOLD) {
    log.warn(
      `Ping-pong loop warning: alternating calls count=${pingPong.count} currentTool=${toolName}`,
    );
    return {
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      count: pingPong.count,
      message: `WARNING: You are alternating between repeated tool-call patterns (${pingPong.count} consecutive calls). This looks like a ping-pong loop; stop retrying and report the task as failed.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: pingPongWarningKey,
      ...(argumentChurnLivenessSignal ? { livenessSignal: argumentChurnLivenessSignal } : {}),
    };
  }

  // Generic detector: warn on repeated identical calls, then block only after
  // outcomes prove the calls are not making progress.
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === currentHash,
  ).length;
  if (!knownPollTool && noProgressStreak >= CRITICAL_THRESHOLD) {
    log.error(`Critical generic loop detected: ${toolName} repeated ${noProgressStreak} times`);
    return {
      stuck: true,
      level: "critical",
      detector: "generic_repeat",
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical outcomes ${noProgressStreak} times. Session execution blocked to prevent runaway loops.`,
      warningKey: `generic:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  if (argumentChurn.count >= TOOL_LOOP_WARNING_THRESHOLD) {
    log.warn(`Argument churn warning: ${toolName} cycled through stable argument patterns`);
    return buildArgumentChurnWarning(toolName, argumentChurn);
  }

  if (!knownPollTool && recentCount >= TOOL_LOOP_WARNING_THRESHOLD) {
    log.warn(`Loop warning: ${toolName} called ${recentCount} times with identical arguments`);
    return {
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: recentCount,
      message: `WARNING: You have called ${toolName} ${recentCount} times with identical arguments. If this is not making progress, stop retrying and report the task as failed.`,
      warningKey: `generic:${toolName}:${currentHash}`,
    };
  }

  return { stuck: false };
}

/**
 * Record a tool call in the session's history for loop detection.
 * Maintains sliding window of last N calls.
 */
export function recordToolCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
  _config?: ToolLoopDetectionConfig,
  scope?: ToolLoopDetectionScope,
): void {
  const runId = normalizeRunId(scope?.runId);
  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    mutationTargetHash: hashWriteMutationTarget(toolName, params, scope?.cwd),
    toolCallId,
    ...(runId && { runId }),
    timestamp: Date.now(),
  });

  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - TOOL_CALL_HISTORY_SIZE);
  }
}

/**
 * Record a completed tool call outcome so loop detection can identify no-progress repeats.
 */
export function recordToolCallOutcome(
  state: SessionState,
  params: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    result?: unknown;
    error?: unknown;
    config?: ToolLoopDetectionConfig;
    runId?: string;
    cwd?: string;
  },
): ToolCallRecord | undefined {
  const runId = normalizeRunId(params.runId);
  const outcome = hashToolOutcome(params.toolName, params.toolParams, params.result, params.error);
  if (!outcome.resultHash && !outcome.outcomeKind) {
    return undefined;
  }

  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  const argsHash = hashToolCall(params.toolName, params.toolParams);
  let matched = false;
  let recordedOutcome: ToolCallRecord | undefined;
  for (let i = state.toolCallHistory.length - 1; i >= 0; i -= 1) {
    const call = state.toolCallHistory[i];
    if (!call) {
      continue;
    }
    if (normalizeRunId(call.runId) !== runId) {
      continue;
    }
    if (params.toolCallId && call.toolCallId !== params.toolCallId) {
      continue;
    }
    if (call.toolName !== params.toolName || call.argsHash !== argsHash) {
      continue;
    }
    if (call.resultHash !== undefined || call.outcomeKind !== undefined) {
      continue;
    }
    call.outcomeKind = outcome.outcomeKind;
    call.resultHash = outcome.resultHash;
    if (outcome.noProgress) {
      call.noProgress = true;
    } else {
      delete call.noProgress;
    }
    call.unknownToolName = outcome.unknownToolName;
    matched = true;
    recordedOutcome = call;
    break;
  }

  if (!matched) {
    const record: ToolCallRecord = {
      toolName: params.toolName,
      argsHash,
      mutationTargetHash: hashWriteMutationTarget(params.toolName, params.toolParams, params.cwd),
      toolCallId: params.toolCallId,
      ...(runId && { runId }),
      outcomeKind: outcome.outcomeKind,
      resultHash: outcome.resultHash,
      ...(outcome.noProgress ? { noProgress: true as const } : {}),
      unknownToolName: outcome.unknownToolName,
      timestamp: Date.now(),
    };
    state.toolCallHistory.push(record);
    recordedOutcome = record;
  }

  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - TOOL_CALL_HISTORY_SIZE);
  }
  return recordedOutcome;
}
