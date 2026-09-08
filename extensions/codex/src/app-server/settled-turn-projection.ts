import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CodexHistoryRejection } from "./history-rejection.js";
import type { JsonValue } from "./protocol.js";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

const MAX_RESPONSE_ITEMS = 200;
const MAX_PROJECTION_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
// Projected names replay as function_call history items, which Codex
// thread/inject_items deserializes as free-form strings (ResponseItem::FunctionCall).
// Codex records MCP and connector calls under dotted namespaced ids
// ("codex_apps.slack.slack_send"), so "." must stay projectable or any turn
// that used such a tool can never finalize.
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/u;
const TOOL_ERROR_STATUS_PREFIX = "[Tool result status: error]\n";

type ProjectedToolReference = { id: string; name: string };
type ProjectedResponseItem = {
  item: JsonValue;
  call?: ProjectedToolReference;
  result?: ProjectedToolReference;
};

function readBoundedText(value: unknown, maxBytes = MAX_TEXT_BYTES): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new CodexHistoryRejection("field_limit");
  }
  return value;
}

function requireBoundedText(value: unknown, maxBytes = MAX_TEXT_BYTES): string {
  const text = readBoundedText(value, maxBytes);
  if (!text) {
    throw new CodexHistoryRejection("invalid_content");
  }
  return text;
}

function responseItemBytes(item: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

function requireCallId(value: unknown): string {
  const callId = normalizeOptionalString(value);
  if (!callId || callId.length > 256) {
    throw new CodexHistoryRejection("invalid_content");
  }
  return callId;
}

function requireToolName(value: unknown): string {
  const name = normalizeOptionalString(value);
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw new CodexHistoryRejection("invalid_content");
  }
  return name;
}

function serializeToolArguments(value: unknown): string {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (!isRecord(parsed)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    return requireBoundedText(value);
  }
  if (!isRecord(value)) {
    throw new CodexHistoryRejection("invalid_content");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CodexHistoryRejection("invalid_content");
  }
  return requireBoundedText(serialized);
}

function projectUserMessage(message: Extract<AgentMessage, { role: "user" }>): JsonValue {
  const upstreamUserText = readUpstreamUserText(message);
  if (typeof message.content === "string") {
    const text = upstreamUserText
      ? requireBoundedText(upstreamUserText, MAX_PROJECTION_BYTES)
      : requireBoundedText(message.content);
    return { type: "message", role: "user", content: [{ type: "input_text", text }] };
  }
  if (!Array.isArray(message.content)) {
    throw new CodexHistoryRejection("unsupported_content");
  }
  const content: JsonValue[] = [];
  let bytes = responseItemBytes({ type: "message", role: "user", content });
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (value.type !== "text") {
      throw new CodexHistoryRejection(
        value.type === "image" ? "unsupported_user_image" : "unsupported_content",
      );
    }
    const text = readBoundedText(value.text);
    if (text) {
      const part = { type: "input_text", text };
      bytes += responseItemBytes(part) + (content.length > 0 ? 1 : 0);
      if (bytes > MAX_PROJECTION_BYTES) {
        throw new CodexHistoryRejection("byte_limit");
      }
      content.push(part);
    }
  }
  if (content.length === 0) {
    throw new CodexHistoryRejection("invalid_content");
  }
  return { type: "message", role: "user", content };
}

function* projectAssistantMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
): Generator<ProjectedResponseItem> {
  const values: unknown =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(values)) {
    throw new CodexHistoryRejection("unsupported_content");
  }
  for (const value of values) {
    if (!isRecord(value)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (value.type === "text") {
      const text = readBoundedText(value.text);
      if (text) {
        yield {
          item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
        };
      }
      continue;
    }
    if (value.type === "toolCall") {
      const id = requireCallId(value.id ?? value.toolCallId);
      const name = requireToolName(value.name ?? value.toolName);
      yield {
        call: { id, name },
        item: {
          type: "function_call",
          call_id: id,
          name,
          arguments: serializeToolArguments(value.arguments ?? value.input),
        },
      };
      continue;
    }
    if (value.type === "thinking" || value.type === "reasoning") {
      // Private/non-visible reasoning is deliberately outside the application transcript.
      continue;
    }
    throw new CodexHistoryRejection("unsupported_content");
  }
}

function projectToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): {
  item: JsonValue;
  result: ProjectedToolReference;
} {
  const id = requireCallId(message.toolCallId);
  const name = requireToolName(message.toolName);
  if (!Array.isArray(message.content)) {
    throw new CodexHistoryRejection("unsupported_content");
  }
  const isErrorValue: unknown = message.isError;
  if (isErrorValue !== undefined && typeof isErrorValue !== "boolean") {
    throw new CodexHistoryRejection("invalid_content");
  }
  const isError = isErrorValue === true;
  const parts: string[] = [];
  let bytes = 0;
  const appendText = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8") + (parts.length > 0 ? 1 : 0);
    if (bytes > MAX_TEXT_BYTES) {
      throw new CodexHistoryRejection("field_limit");
    }
    parts.push(text);
  };
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new CodexHistoryRejection("invalid_content");
    }
    if (value.type === "image") {
      const mimeType = normalizeOptionalString(value.mimeType) ?? "unknown type";
      // The finalizer selects by text capability. Preserve image evidence as
      // metadata without embedding an executable or oversized multimodal payload.
      appendText(`[Image tool result: ${mimeType}]`);
      continue;
    }
    if (value.type !== "text" && value.type !== "toolResult") {
      throw new CodexHistoryRejection("invalid_content");
    }
    const text =
      value.type === "text"
        ? readBoundedText(value.text)
        : readBoundedText(value.content ?? value.text);
    if (text) {
      appendText(text);
    }
  }
  const resultText =
    parts.join("\n") ||
    (isError ? "Tool failed without textual output." : "Tool completed without textual output.");
  // Codex function-call output has no status field. Preserve failure truth in
  // the text boundary so the final answer cannot reinterpret errors as success.
  const output = requireBoundedText(
    isError ? `${TOOL_ERROR_STATUS_PREFIX}${resultText}` : resultText,
    isError ? MAX_TEXT_BYTES + Buffer.byteLength(TOOL_ERROR_STATUS_PREFIX, "utf8") : MAX_TEXT_BYTES,
  );
  return {
    result: { id, name },
    item: { type: "function_call_output", call_id: id, output },
  };
}

function* projectMessage(message: AgentMessage): Generator<ProjectedResponseItem> {
  if (message.role === "user") {
    yield { item: projectUserMessage(message) };
  } else if (message.role === "assistant") {
    yield* projectAssistantMessage(message);
  } else if (message.role === "toolResult") {
    yield projectToolResult(message);
  } else {
    throw new CodexHistoryRejection("unsupported_content");
  }
}

/** Consumes complete evidence or rejects at the existing limits, never truncating its history. */
export function projectSettledCodexMessages(messages: Iterable<AgentMessage>): JsonValue[] {
  const items: JsonValue[] = [];
  const calls = new Map<string, string>();
  const results = new Set<string>();
  let bytes = 0;
  for (const message of messages) {
    for (const { item, call, result } of projectMessage(message)) {
      if (call) {
        if (calls.has(call.id)) {
          throw new CodexHistoryRejection("invalid_pairing");
        }
        calls.set(call.id, call.name);
      }
      if (result) {
        if (calls.get(result.id) !== result.name || results.has(result.id)) {
          throw new CodexHistoryRejection("invalid_pairing");
        }
        results.add(result.id);
      }
      if (items.length === MAX_RESPONSE_ITEMS) {
        throw new CodexHistoryRejection("item_limit");
      }
      bytes += responseItemBytes(item);
      if (bytes > MAX_PROJECTION_BYTES) {
        throw new CodexHistoryRejection("byte_limit");
      }
      items.push(item);
    }
  }
  if (calls.size !== results.size) {
    throw new CodexHistoryRejection("incomplete_pairing");
  }
  if (results.size === 0) {
    throw new CodexHistoryRejection("incomplete_pairing");
  }
  return items;
}
