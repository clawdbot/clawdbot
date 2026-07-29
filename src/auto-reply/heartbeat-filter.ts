import { expectDefined } from "@openclaw/normalization-core";
// Transcript filter for removing heartbeat-only prompt/ack artifacts.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "./heartbeat-tool-response.js";
import {
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  HEARTBEAT_TRANSCRIPT_PROMPT,
  resolveHeartbeatPromptForResponseTool,
  stripHeartbeatToken,
} from "./heartbeat.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "./reply/delivery-hints.js";

const HEARTBEAT_TASK_PROMPT_PREFIX =
  "Run the following periodic tasks (only those due based on their intervals):";
const HEARTBEAT_TASK_PROMPT_ACK = "After completing all due tasks, reply HEARTBEAT_OK.";
const TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "functionCall",
  "toolUse",
  "tool_call",
  "function_call",
  "tool_use",
]);
const TOOL_RESULT_BLOCK_TYPES = new Set([
  "toolResult",
  "tool_result",
  "tool_result_error",
  "function_call_output",
]);
type HeartbeatTranscriptMessage = { role: string; content?: unknown };

function readNestedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  const direct = readString(value);
  if (direct) {
    return direct;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value.name);
}

function collectToolCallBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && TOOL_CALL_BLOCK_TYPES.has(readString(block.type) ?? ""),
  );
}

function collectToolResultBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Record<string, unknown> =>
      isRecord(block) && TOOL_RESULT_BLOCK_TYPES.has(readString(block.type) ?? ""),
  );
}

function readToolCallName(block: Record<string, unknown>): string | undefined {
  return readString(block.name) ?? readNestedString(block, "function");
}

function collectToolCallIds(block: Record<string, unknown>): string[] {
  const ids = [
    readString(block.call_id),
    readString(block.tool_call_id),
    readString(block.toolCallId),
    readString(block.tool_use_id),
    readString(block.toolUseId),
    readString(block.id),
  ].filter((id): id is string => Boolean(id));
  return uniqueStrings(ids);
}

function readNestedToolCallArguments(record: Record<string, unknown>): unknown {
  const value = record.function;
  if (!isRecord(value)) {
    return undefined;
  }
  return value.arguments ?? value.args ?? value.input;
}

function readToolCallArguments(block: Record<string, unknown>): unknown {
  return block.arguments ?? block.args ?? block.input ?? readNestedToolCallArguments(block);
}

function parseToolCallArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isVisibleHeartbeatResponseToolCall(block: Record<string, unknown>): boolean {
  const args = parseToolCallArguments(readToolCallArguments(block));
  if (!args) {
    return false;
  }
  return args.notify === true || args.notify === "true";
}

function collectVisibleHeartbeatResponseToolCalls(message: {
  role: string;
  content?: unknown;
}): Array<Record<string, unknown>> {
  if (message.role !== "assistant") {
    return [];
  }
  return [...collectMessageToolCalls(message), ...collectToolCallBlocks(message.content)].filter(
    (block) =>
      readToolCallName(block) === HEARTBEAT_RESPONSE_TOOL_NAME &&
      isVisibleHeartbeatResponseToolCall(block),
  );
}

function collectMessageToolCalls(message: { role: string; content?: unknown }) {
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter((call): call is Record<string, unknown> => isRecord(call));
}

function hasAssistantToolCall(message: { role: string; content?: unknown }): boolean {
  return (
    message.role === "assistant" &&
    (collectMessageToolCalls(message).length > 0 ||
      collectToolCallBlocks(message.content).length > 0)
  );
}

function isRemovableHeartbeatResponseToolCall(message: {
  role: string;
  content?: unknown;
}): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  for (const call of collectMessageToolCalls(message)) {
    const name = readToolCallName(call);
    if (name === HEARTBEAT_RESPONSE_TOOL_NAME && !isVisibleHeartbeatResponseToolCall(call)) {
      return true;
    }
  }
  return collectToolCallBlocks(message.content).some(
    (block) =>
      readToolCallName(block) === HEARTBEAT_RESPONSE_TOOL_NAME &&
      !isVisibleHeartbeatResponseToolCall(block),
  );
}

function hasVisibleHeartbeatResponseToolCall(message: {
  role: string;
  content?: unknown;
}): boolean {
  return collectVisibleHeartbeatResponseToolCalls(message).length > 0;
}

function isEmbeddedToolResultOnlyContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) => isRecord(block) && TOOL_RESULT_BLOCK_TYPES.has(readString(block.type) ?? ""),
    )
  );
}

function isToolResultMessage(message: { role: string; content?: unknown }): boolean {
  return (
    message.role === "toolResult" ||
    message.role === "tool" ||
    (message.role === "user" && isEmbeddedToolResultOnlyContent(message.content))
  );
}

function isFailedToolResultRecord(record: Record<string, unknown>): boolean {
  return (
    record.isError === true ||
    record.is_error === true ||
    readString(record.type) === "tool_result_error"
  );
}

function hasSuccessfulToolResultMessage(message: { role: string; content?: unknown }): boolean {
  const resultBlocks = collectToolResultBlocks(message.content);
  if (resultBlocks.length > 0) {
    return resultBlocks.some((block) => !isFailedToolResultRecord(block));
  }
  if (!isToolResultMessage(message)) {
    return false;
  }
  return !isFailedToolResultRecord(message as Record<string, unknown>);
}

function collectSuccessfulToolResultCallIds(message: {
  role: string;
  content?: unknown;
}): string[] {
  const record = message as Record<string, unknown>;
  const resultBlocks = collectToolResultBlocks(message.content);
  const ids: string[] = [];
  if (resultBlocks.length === 0) {
    if (!isFailedToolResultRecord(record)) {
      ids.push(
        ...[
          readString(record.toolCallId),
          readString(record.tool_call_id),
          readString(record.toolUseId),
          readString(record.tool_use_id),
          readString(record.call_id),
          readString(record.id),
        ].filter((id): id is string => Boolean(id)),
      );
    }
  } else {
    for (const block of resultBlocks) {
      if (isFailedToolResultRecord(block)) {
        continue;
      }
      ids.push(...collectToolCallIds(block));
    }
  }
  return uniqueStrings(ids);
}

export function isRealNonHeartbeatUserMessage(
  message: { role: string; content?: unknown },
  heartbeatPrompt?: string,
): boolean {
  return (
    message.role === "user" &&
    !isEmbeddedToolResultOnlyContent(message.content) &&
    !isHeartbeatUserMessage(message, heartbeatPrompt)
  );
}

function matchesHeartbeatPromptText(text: string, prompt: string | undefined): boolean {
  const normalized = prompt?.trim();
  return Boolean(normalized) && (text === normalized || text.startsWith(`${normalized}\n`));
}

function resolveMessageText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  let text = "";
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      hasNonTextContent = true;
      continue;
    }
    if (block.type !== "text" && block.type !== "input_text" && block.type !== "output_text") {
      hasNonTextContent = true;
      continue;
    }
    const blockText = (block as { text?: unknown }).text;
    if (typeof blockText !== "string") {
      hasNonTextContent = true;
      continue;
    }
    text += blockText;
  }
  return { text, hasNonTextContent };
}

/** Return whether a user message is an internal heartbeat prompt. */
export function isHeartbeatUserMessage(
  message: { role: string; content?: unknown },
  heartbeatPrompt?: string,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalizedHeartbeatPrompt = heartbeatPrompt?.trim();
  if (trimmed === HEARTBEAT_TRANSCRIPT_PROMPT) {
    return true;
  }
  if (
    MESSAGE_TOOL_DELIVERY_HINTS.some((prefix) => trimmed.startsWith(prefix)) &&
    trimmed.endsWith(HEARTBEAT_TRANSCRIPT_PROMPT)
  ) {
    return true;
  }
  if (matchesHeartbeatPromptText(trimmed, normalizedHeartbeatPrompt)) {
    return true;
  }
  if (matchesHeartbeatPromptText(trimmed, HEARTBEAT_RESPONSE_TOOL_PROMPT)) {
    return true;
  }
  if (
    normalizedHeartbeatPrompt &&
    matchesHeartbeatPromptText(
      trimmed,
      resolveHeartbeatPromptForResponseTool(normalizedHeartbeatPrompt),
    )
  ) {
    return true;
  }
  return (
    trimmed.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX) && trimmed.includes(HEARTBEAT_TASK_PROMPT_ACK)
  );
}

/** Return whether an assistant message is only a heartbeat acknowledgement. */
export function isHeartbeatOkResponse(
  message: { role: string; content?: unknown },
  ackMaxChars?: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (hasAssistantToolCall(message)) {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  return stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars: ackMaxChars }).shouldSkip;
}

function advancePastAdjacentToolResults(
  messages: HeartbeatTranscriptMessage[],
  startIndex: number,
): number {
  let index = startIndex;
  while (index < messages.length) {
    const message = messages.at(index);
    if (!message || !isToolResultMessage(message)) {
      break;
    }
    index++;
  }
  return index;
}

function isToolResultCompletionCandidate(message: { role: string; content?: unknown }): boolean {
  return isToolResultMessage(message) || collectToolResultBlocks(message.content).length > 0;
}

function hasCompletedVisibleHeartbeatResponseToolCall(
  messages: HeartbeatTranscriptMessage[],
  index: number,
): boolean {
  const message = messages.at(index);
  if (!message) {
    return false;
  }
  const visibleCalls = collectVisibleHeartbeatResponseToolCalls(message);
  if (visibleCalls.length === 0) {
    return false;
  }
  const callIds = new Set(visibleCalls.flatMap((call) => collectToolCallIds(call)));
  for (const result of messages.slice(index + 1)) {
    if (!isToolResultCompletionCandidate(result)) {
      break;
    }
    if (!hasSuccessfulToolResultMessage(result)) {
      continue;
    }
    if (callIds.size === 0) {
      return true;
    }
    for (const resultId of collectSuccessfulToolResultCallIds(result)) {
      if (callIds.has(resultId)) {
        return true;
      }
    }
  }
  return false;
}

function resolveHeartbeatArtifactSpanEnd(
  messages: HeartbeatTranscriptMessage[],
  startIndex: number,
  ackMaxChars?: number,
  heartbeatPrompt?: string,
): number | undefined {
  let index = startIndex + 1;
  let sawTerminalHeartbeatArtifact = false;
  let sawNonTerminalAssistantOutput = false;

  while (index < messages.length) {
    const message = messages.at(index);
    if (!message) {
      break;
    }
    if (isRealNonHeartbeatUserMessage(message, heartbeatPrompt)) {
      break;
    }
    if (isHeartbeatUserMessage(message, heartbeatPrompt)) {
      break;
    }
    if (isHeartbeatOkResponse(message, ackMaxChars)) {
      sawTerminalHeartbeatArtifact = true;
      index = advancePastAdjacentToolResults(messages, index + 1);
      continue;
    }
    if (hasVisibleHeartbeatResponseToolCall(message)) {
      if (hasCompletedVisibleHeartbeatResponseToolCall(messages, index)) {
        return undefined;
      }
      index++;
      continue;
    }
    if (isRemovableHeartbeatResponseToolCall(message)) {
      sawTerminalHeartbeatArtifact = true;
      index = advancePastAdjacentToolResults(messages, index + 1);
      continue;
    }
    if (sawTerminalHeartbeatArtifact) {
      index++;
      continue;
    }
    if (isToolResultMessage(message) || hasAssistantToolCall(message)) {
      index++;
      continue;
    }
    if (message.role === "assistant") {
      sawNonTerminalAssistantOutput = true;
      index++;
      continue;
    }
    return undefined;
  }

  if (sawNonTerminalAssistantOutput && !sawTerminalHeartbeatArtifact) {
    return undefined;
  }
  return index;
}

/** Remove heartbeat-only prompt, ack, and silent tool artifacts from a transcript. */
export function filterHeartbeatTranscriptArtifacts<T extends { role: string; content?: unknown }>(
  messages: T[],
  ackMaxChars?: number,
  heartbeatPrompt?: string,
): T[] {
  if (messages.length === 0) {
    return messages;
  }

  const result: T[] = [];
  let i = 0;
  while (i < messages.length) {
    if (
      !isHeartbeatUserMessage(expectDefined(messages[i], "messages entry at i"), heartbeatPrompt)
    ) {
      result.push(expectDefined(messages[i], "messages entry at i"));
      i++;
      continue;
    }

    const next = resolveHeartbeatArtifactSpanEnd(messages, i, ackMaxChars, heartbeatPrompt);
    if (next === undefined) {
      result.push(expectDefined(messages[i], "messages entry at i"));
      i++;
      continue;
    }

    i = next;
  }

  return result;
}
