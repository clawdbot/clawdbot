import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../code-mode-control-tools.js";
import {
  getTranscriptMessageRole as getMessageRole,
  isIntermediateAssistantTranscriptMessage,
  isMeaningfulTranscriptMessage,
  readTerminalSourceReplyDeliveryMirror,
} from "../embedded-agent-runner/message-visibility.js";
import {
  AGENT_RUN_RESTART_ABORT_ERROR,
  AGENT_RUN_RESTART_ABORT_ERROR_CODE,
} from "../run-termination.js";
import { isAgentToolReplaySafe } from "../tool-replay-safety.js";

function readDeliveredTerminalSourceReplyToolCallId(
  messages: readonly unknown[],
  expectedSourceTurnId: string | undefined,
): string | undefined {
  if (!expectedSourceTurnId) {
    return undefined;
  }
  for (const message of messages.toReversed()) {
    if (getMessageRole(message) !== "assistant") {
      continue;
    }
    const mirror = readTerminalSourceReplyDeliveryMirror(message);
    if (mirror?.sourceTurnId === expectedSourceTurnId) {
      return mirror.toolCallId;
    }
  }
  return undefined;
}

function readCodeModeWaitCall(
  message: unknown,
): { runId: string; toolCallId?: string } | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    getMessageRole(message) !== "assistant" ||
    (message as { stopReason?: unknown }).stopReason !== "toolUse"
  ) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const supportedTypes = new Set(["text", "thinking", "toolCall", "toolUse", "tool_use"]);
  if (
    content.some(
      (block) =>
        !block ||
        typeof block !== "object" ||
        !supportedTypes.has(String((block as { type?: unknown }).type)) ||
        ((block as { type?: unknown }).type === "text" &&
          Boolean(normalizeOptionalString((block as { text?: unknown }).text))),
    )
  ) {
    return undefined;
  }
  const toolCalls = content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return type === "toolCall" || type === "toolUse" || type === "tool_use";
  });
  if (toolCalls.length !== 1) {
    return undefined;
  }
  const block = toolCalls[0] as Record<string, unknown>;
  if (normalizeOptionalString((block as { name?: unknown }).name) !== CODE_MODE_WAIT_TOOL_NAME) {
    return undefined;
  }
  const args = (block as { arguments?: unknown }).arguments ?? (block as { input?: unknown }).input;
  const runId =
    args && typeof args === "object"
      ? normalizeOptionalString((args as { runId?: unknown }).runId)
      : undefined;
  if (!runId) {
    return undefined;
  }
  const toolCallId = normalizeOptionalString(block.id);
  return { runId, ...(toolCallId ? { toolCallId } : {}) };
}

function isResumableTailMessage(message: unknown): boolean {
  const role = getMessageRole(message);
  return role === "user" || role === "tool" || role === "toolResult";
}

function isPendingAssistantToolCall(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return false;
  }
  if (normalizeOptionalString((message as { stopReason?: unknown }).stopReason) !== "toolUse") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasToolCall = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = normalizeOptionalString((block as { type?: unknown }).type);
    if (type === "toolCall" || type === "toolUse" || type === "tool_use") {
      hasToolCall = true;
      continue;
    }
    if (type === "thinking") {
      continue;
    }
    if (type === "text" && !normalizeOptionalString((block as { text?: unknown }).text)) {
      continue;
    }
    return false;
  }
  return hasToolCall;
}

type DanglingToolCallClassification =
  | { kind: "none" }
  | { kind: "code-mode" }
  | { kind: "resumable"; forceRestartSafeTools: boolean };

// A dangling call may have committed before its result persisted, so anything
// outside the audited replay-safe allowlist keeps the restart-safe tool
// restriction: the continuation can inspect and report, but never silently
// re-execute the ambiguous side effect. Name-only classification is enough
// here because the concrete tool instance is gone with the old process.
function classifyDanglingToolCalls(content: unknown): DanglingToolCallClassification | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  let allReplaySafe = true;
  let hasToolCall = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const type = normalizeOptionalString((block as { type?: unknown }).type);
    if (type !== "toolCall" && type !== "toolUse" && type !== "tool_use") {
      continue;
    }
    const name = normalizeOptionalString((block as { name?: unknown }).name);
    if (name === CODE_MODE_EXEC_TOOL_NAME || name === CODE_MODE_WAIT_TOOL_NAME) {
      return { kind: "code-mode" };
    }
    if (!isAgentToolReplaySafe({ name })) {
      allReplaySafe = false;
    }
    hasToolCall = true;
  }
  return hasToolCall
    ? { kind: "resumable", forceRestartSafeTools: !allReplaySafe }
    : { kind: "none" };
}

// Unlike isPendingAssistantToolCall, visible text beside the call is fine —
// the tail is not replayed, only continued past. Code Mode control calls are
// excluded so their replay-safe checkpoint gating stays authoritative.
function readResumablePendingToolCallTail(
  message: unknown,
): { forceRestartSafeTools: boolean } | undefined {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return undefined;
  }
  if (normalizeOptionalString((message as { stopReason?: unknown }).stopReason) !== "toolUse") {
    return undefined;
  }
  const classified = classifyDanglingToolCalls((message as { content?: unknown }).content);
  return classified?.kind === "resumable"
    ? { forceRestartSafeTools: classified.forceRestartSafeTools }
    : undefined;
}

function readCodeModeCheckpoint(
  message: unknown,
): { replaySafe: boolean; runId?: string } | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = getMessageRole(message);
  if (role !== "tool" && role !== "toolResult") {
    return undefined;
  }
  const toolName = normalizeOptionalString((message as { toolName?: unknown }).toolName);
  if (toolName !== CODE_MODE_EXEC_TOOL_NAME && toolName !== CODE_MODE_WAIT_TOOL_NAME) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlock = content.find(
    (block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text",
  ) as { text?: unknown } | undefined;
  const text = normalizeOptionalString(textBlock?.text);
  if (!text) {
    return undefined;
  }
  try {
    const result = JSON.parse(text) as {
      status?: unknown;
      replaySafe?: unknown;
      runId?: unknown;
    };
    if (result.status === "completed" || result.status === "failed") {
      return { replaySafe: result.replaySafe === true };
    }
    const runId = normalizeOptionalString(result.runId);
    return result.status === "waiting" && runId
      ? { replaySafe: result.replaySafe === true, runId }
      : undefined;
  } catch {
    return undefined;
  }
}

export function hasReplaySafeCodeModeCheckpointInCurrentTurn(
  messages: readonly unknown[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (getMessageRole(message) === "user") {
      return false;
    }
    if (readCodeModeCheckpoint(message)?.replaySafe === true) {
      return true;
    }
  }
  return false;
}

// Upgrade-window compat: tails persisted before transports preserved the abort
// reason carry no `errorCode`, and the old process can write one while shutting
// down for the very upgrade that starts the new one. Read those by their abort
// text so that run still resumes. Coded tails never consult this set, so a
// coded non-restart abort stays excluded. Remove once no pre-`errorCode`
// transcript can reach restart recovery.
const LEGACY_RESTART_ABORT_ERROR_MESSAGES = new Set([
  "Request was aborted",
  "This operation was aborted",
  AGENT_RUN_RESTART_ABORT_ERROR,
]);
const CODE_MODE_RESTART_ABORT_ERROR = "code mode execution aborted";

function isRestartAbortAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "assistant") {
    return false;
  }
  const stopReason = normalizeOptionalString((message as { stopReason?: unknown }).stopReason);
  // Every row that reaches restart recovery was mid-run when the process went
  // down, so an "aborted" tail is that interruption whatever detail the
  // transport persisted with it ("Worker inference aborted.", a provider cancel
  // message, or nothing).
  if (stopReason === "aborted") {
    return true;
  }
  if (stopReason !== "error") {
    return false;
  }
  // An "error" tail only means the restart when the transport carried the
  // gateway's own abort code through (transports copy the reason's `code` into
  // `errorCode`). A provider failure or a first-stream-event timeout carries a
  // different code and stays unresumable.
  const errorCode = normalizeOptionalString((message as { errorCode?: unknown }).errorCode);
  if (errorCode !== undefined) {
    return errorCode === AGENT_RUN_RESTART_ABORT_ERROR_CODE;
  }
  const errorMessage = normalizeOptionalString(
    (message as { errorMessage?: unknown }).errorMessage,
  );
  return errorMessage !== undefined && LEGACY_RESTART_ABORT_ERROR_MESSAGES.has(errorMessage);
}

export function isRestartAbortTailArtifact(message: unknown): boolean {
  if (!isRestartAbortAssistantMessage(message)) {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.length === 0;
}

function isRestartAbortedWaitFailure(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (
    normalizeOptionalString(record.toolName) !== CODE_MODE_WAIT_TOOL_NAME ||
    record.isError !== true
  ) {
    return false;
  }
  const details = record.details;
  if (
    !details ||
    typeof details !== "object" ||
    (details as { status?: unknown }).status !== "failed"
  ) {
    return false;
  }
  const content = record.content;
  const contentText = Array.isArray(content)
    ? content
        .filter(
          (block) =>
            block && typeof block === "object" && (block as { type?: unknown }).type === "text",
        )
        .map((block) => normalizeOptionalString((block as { text?: unknown }).text) ?? "")
        .join("\n")
    : "";
  const errorText =
    normalizeOptionalString((details as { error?: unknown }).error) ??
    normalizeOptionalString(contentText);
  const code = normalizeOptionalString((details as { code?: unknown }).code);
  if (code === "aborted") {
    // Current Code Mode wait aborts use the runtime's explicit abort code and
    // message. Recovery already owns the restart boundary, so this exact pair
    // is lifecycle noise rather than a provider or tool failure.
    return errorText === CODE_MODE_RESTART_ABORT_ERROR;
  }
  if (code !== "internal_error") {
    return false;
  }
  return /^(?:(?:Abort)?Error:\s*)?(?:The|This) operation was aborted\.?$/u.test(errorText ?? "");
}

function isRestartAbortedWaitResultArtifact(message: unknown, waitMessage: unknown): boolean {
  if (!isRestartAbortedWaitFailure(message)) {
    return false;
  }
  const toolCallId = normalizeOptionalString((message as Record<string, unknown>).toolCallId);
  const waitCall = readCodeModeWaitCall(waitMessage);
  return Boolean(toolCallId && waitCall?.toolCallId === toolCallId);
}

function requiresRestartSafeToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object" || getMessageRole(message) !== "toolResult") {
    return false;
  }
  const record = message as Record<string, unknown>;
  const details = record.details;
  if (!details || typeof details !== "object") {
    return false;
  }
  const status = details as { reason?: unknown; status?: unknown };
  return status.reason === "missing_tool_result" || status.status === "approval-pending";
}

type MainSessionResumePolicy =
  | {
      action: "complete";
      reason: "delivered-terminal" | "delivered-terminal-receipt";
      toolCallId: string;
    }
  | { action: "complete"; reason: "handled-silent" }
  | {
      action: "resume";
      forceRestartSafeTools: boolean;
      forceCodeModeTools?: true;
    };

export function resolveMainSessionResumePolicy(
  messages: unknown[],
  forceRestartSafeTools = false,
  expectedSourceTurnId?: string,
  beforeAgentReplyState?: SessionEntry["restartRecoveryBeforeAgentReplyState"],
  deliveryReceiptState?: SessionEntry["restartRecoveryDeliveryReceiptState"],
  deliveryToolCallId?: string,
): MainSessionResumePolicy {
  const mirroredToolCallId = readDeliveredTerminalSourceReplyToolCallId(
    messages,
    expectedSourceTurnId,
  );
  if (mirroredToolCallId) {
    return { action: "complete", reason: "delivered-terminal", toolCallId: mirroredToolCallId };
  }
  if (deliveryReceiptState === "delivered-terminal") {
    return deliveryToolCallId
      ? {
          action: "complete",
          reason: "delivered-terminal-receipt",
          toolCallId: deliveryToolCallId,
        }
      : { action: "resume", forceRestartSafeTools: true };
  }
  if (deliveryReceiptState === "terminal-pending") {
    return { action: "resume", forceRestartSafeTools: true };
  }
  if (beforeAgentReplyState === "handled-silent") {
    return { action: "complete", reason: "handled-silent" };
  }
  if (beforeAgentReplyState === "pending") {
    return { action: "resume", forceRestartSafeTools: true };
  }
  if (beforeAgentReplyState === "handled-reply") {
    return { action: "resume", forceRestartSafeTools: true };
  }
  if (beforeAgentReplyState === "handled-unrecoverable") {
    return { action: "resume", forceRestartSafeTools: true };
  }
  // Progress can commit after the recovery mark while the old run is winding
  // down. It is not a terminal turn boundary; preserve it in the transcript
  // while classifying the actual user/tool/assistant boundary beneath it.
  const meaningfulMessages = messages
    .toReversed()
    .filter(
      (message) =>
        isMeaningfulTranscriptMessage(message) &&
        !isIntermediateAssistantTranscriptMessage(message),
    );
  // A restart abort tail without tool calls is lifecycle noise whether or not
  // partial streamed text was persisted with it; the partial output stays in
  // the transcript for the continuation, and the message beneath decides
  // resume safety. Persisted dangling tool calls instead classify like a
  // pending toolUse tail so ambiguous side effects stay restricted.
  if (isRestartAbortAssistantMessage(meaningfulMessages[0])) {
    const dangling = classifyDanglingToolCalls(
      (meaningfulMessages[0] as { content?: unknown }).content,
    );
    if (dangling?.kind === "resumable") {
      return { action: "resume", forceRestartSafeTools: dangling.forceRestartSafeTools };
    }
    if (dangling?.kind === "none") {
      meaningfulMessages.shift();
    }
  }
  if (isRestartAbortedWaitResultArtifact(meaningfulMessages[0], meaningfulMessages[1])) {
    meaningfulMessages.shift();
  }
  const lastMeaningful = meaningfulMessages[0];
  if (forceRestartSafeTools && isPendingAssistantToolCall(lastMeaningful)) {
    return { action: "resume", forceRestartSafeTools: true };
  }
  if (isRestartAbortedWaitFailure(lastMeaningful)) {
    return { action: "resume", forceRestartSafeTools: true };
  }
  const waitCall = readCodeModeWaitCall(lastMeaningful);
  if (waitCall) {
    const checkpoint = readCodeModeCheckpoint(meaningfulMessages[1]);
    return checkpoint?.replaySafe === true && checkpoint.runId === waitCall.runId
      ? { action: "resume", forceRestartSafeTools: true, forceCodeModeTools: true }
      : { action: "resume", forceRestartSafeTools: true };
  }
  const tailCheckpoint = readCodeModeCheckpoint(lastMeaningful);
  if (tailCheckpoint) {
    return tailCheckpoint.replaySafe
      ? { action: "resume", forceRestartSafeTools: true, forceCodeModeTools: true }
      : { action: "resume", forceRestartSafeTools: true };
  }
  // A tool call interrupted mid-execution resumes like the manual re-send the
  // failure notice used to demand: the dangling call is dropped from the next
  // provider payload and the continuation prompt lets the model re-decide.
  // Code Mode control calls keep the stricter checkpoint gating above.
  const pendingToolCallTail = readResumablePendingToolCallTail(lastMeaningful);
  if (pendingToolCallTail) {
    return { action: "resume", forceRestartSafeTools: pendingToolCallTail.forceRestartSafeTools };
  }
  const danglingControlCalls =
    lastMeaningful && typeof lastMeaningful === "object"
      ? classifyDanglingToolCalls((lastMeaningful as { content?: unknown }).content)
      : undefined;
  if (danglingControlCalls?.kind === "code-mode") {
    // Without an exact replay-safe checkpoint, Code Mode controls stay unavailable.
    // The model can inspect the transcript under the ordinary restart-safe restriction.
    return { action: "resume", forceRestartSafeTools: true };
  }
  if (!lastMeaningful || !isResumableTailMessage(lastMeaningful)) {
    return { action: "resume", forceRestartSafeTools: false };
  }
  if (requiresRestartSafeToolResult(lastMeaningful)) {
    return { action: "resume", forceRestartSafeTools: true };
  }
  // A later tool result can hide the checkpoint at the transcript tail; keep
  // the interrupted turn restricted without borrowing an earlier turn's state.
  const forceCodeModeTools = hasReplaySafeCodeModeCheckpointInCurrentTurn(messages);
  return {
    action: "resume",
    forceRestartSafeTools: forceCodeModeTools,
    ...(forceCodeModeTools ? { forceCodeModeTools: true } : {}),
  };
}
