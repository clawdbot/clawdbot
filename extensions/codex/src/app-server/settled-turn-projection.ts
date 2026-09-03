import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { JsonValue } from "./protocol.js";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

const MAX_RESPONSE_ITEMS = 200;
const MAX_PROJECTION_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const OPENAI_RESPONSES_CALL_ID_MAX_LENGTH = 64;
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

function readBoundedText(
  value: unknown,
  label: string,
  maxBytes = MAX_TEXT_BYTES,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Codex settled-turn projection found oversized ${label}`);
  }
  return value;
}

function requireBoundedText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES): string {
  const text = readBoundedText(value, label, maxBytes);
  if (!text) {
    throw new Error(`Codex settled-turn projection found empty ${label}`);
  }
  return text;
}

function responseItemBytes(item: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

function requireCallId(value: unknown): string {
  const callId = normalizeOptionalString(value);
  if (!callId || callId.length > 256) {
    throw new Error("Codex settled-turn projection found an invalid tool call id");
  }
  return callId;
}

function createProjectedCallIdResolver(): (id: string) => string {
  // Core's createOpenAIResponsesToolCallIdResolver is not exported through the
  // plugin SDK, so this projection mirrors its rewrite locally. The trigger is
  // deliberately narrower than core's: core rewrites any id failing
  // /^call_[A-Za-z0-9_-]{1,59}$/ and splits call_id|fc_id pairings, while this
  // rewrites on length > 64 only -- the bound OpenAI actually rejects, and the
  // only one this projection can hit (it emits call_id, never an item id).
  // Widening it to core's shape would rewrite ids that replay correctly today
  // (e.g. "call-1"), changing model-visible ids and invalidating prompt caches.
  // Weigh that before swapping in core's resolver if it is ever exported.
  const rewrittenByOriginalId = new Map<string, string>();

  return (id) => {
    const rewritten = rewrittenByOriginalId.get(id);
    if (rewritten) {
      return rewritten;
    }
    if (id.length <= OPENAI_RESPONSES_CALL_ID_MAX_LENGTH) {
      return id;
    }
    const hashSuffix = `_${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
    const maxTailLength = OPENAI_RESPONSES_CALL_ID_MAX_LENGTH - "call_".length;
    const rawTail = id.startsWith("call_") ? id.slice("call_".length) : id;
    const safeTail = rawTail.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/^_+|_+$/gu, "");
    const clippedBase = safeTail.slice(0, Math.max(1, maxTailLength - hashSuffix.length));
    const normalized = `call_${`${clippedBase || "id"}${hashSuffix}`.slice(0, maxTailLength)}`;
    rewrittenByOriginalId.set(id, normalized);
    return normalized;
  };
}

function requireToolName(value: unknown): string {
  const name = normalizeOptionalString(value);
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Codex settled-turn projection found an invalid tool name${name ? `: ${name.slice(0, 64)}` : ""}`,
    );
  }
  return name;
}

function serializeToolArguments(value: unknown): string {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Codex settled-turn projection found invalid JSON tool arguments");
    }
    if (!isRecord(parsed)) {
      throw new Error("Codex settled-turn projection requires object tool arguments");
    }
    return requireBoundedText(value, "tool arguments");
  }
  if (!isRecord(value)) {
    throw new Error("Codex settled-turn projection requires object tool arguments");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Codex settled-turn projection found unserializable tool arguments");
  }
  return requireBoundedText(serialized, "tool arguments");
}

function projectUserMessage(message: Extract<AgentMessage, { role: "user" }>): JsonValue {
  const upstreamUserText = readUpstreamUserText(message);
  if (typeof message.content === "string") {
    const text = upstreamUserText
      ? requireBoundedText(upstreamUserText, "upstream user text", MAX_PROJECTION_BYTES)
      : requireBoundedText(message.content, "user message");
    return { type: "message", role: "user", content: [{ type: "input_text", text }] };
  }
  if (!Array.isArray(message.content)) {
    throw new Error("Codex settled-turn projection found unsupported user content");
  }
  const content: JsonValue[] = [];
  let bytes = responseItemBytes({ type: "message", role: "user", content });
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed user content");
    }
    if (value.type !== "text") {
      throw new Error(`Codex settled-turn projection does not support user content ${value.type}`);
    }
    const text = readBoundedText(value.text, "user text");
    if (text) {
      const part = { type: "input_text", text };
      bytes += responseItemBytes(part) + (content.length > 0 ? 1 : 0);
      if (bytes > MAX_PROJECTION_BYTES) {
        throw new Error("Codex settled-turn projection exceeds the byte limit");
      }
      content.push(part);
    }
  }
  if (content.length === 0) {
    throw new Error("Codex settled-turn projection found an empty user message");
  }
  return { type: "message", role: "user", content };
}

function* projectAssistantMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
  resolveCallId: (id: string) => string,
): Generator<ProjectedResponseItem> {
  const values: unknown =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(values)) {
    throw new Error("Codex settled-turn projection found unsupported assistant content");
  }
  for (const value of values) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed assistant content");
    }
    if (value.type === "text") {
      const text = readBoundedText(value.text, "assistant text");
      if (text) {
        yield {
          item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
        };
      }
      continue;
    }
    if (value.type === "toolCall") {
      const id = resolveCallId(requireCallId(value.id ?? value.toolCallId));
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
    throw new Error(
      `Codex settled-turn projection does not support assistant content ${String(value.type)}`,
    );
  }
}

function projectToolResult(
  message: Extract<AgentMessage, { role: "toolResult" }>,
  resolveCallId: (id: string) => string,
): {
  item: JsonValue;
  result: ProjectedToolReference;
} {
  const id = resolveCallId(requireCallId(message.toolCallId));
  const name = requireToolName(message.toolName);
  if (!Array.isArray(message.content)) {
    throw new Error("Codex settled-turn projection found unsupported tool result content");
  }
  const isErrorValue: unknown = message.isError;
  if (isErrorValue !== undefined && typeof isErrorValue !== "boolean") {
    throw new Error("Codex settled-turn projection found invalid tool result status");
  }
  const isError = isErrorValue === true;
  const parts: string[] = [];
  let bytes = 0;
  const appendText = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8") + (parts.length > 0 ? 1 : 0);
    if (bytes > MAX_TEXT_BYTES) {
      throw new Error("Codex settled-turn projection found oversized tool result output");
    }
    parts.push(text);
  };
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed tool result content");
    }
    if (value.type === "image") {
      const mimeType = normalizeOptionalString(value.mimeType) ?? "unknown type";
      // The finalizer selects by text capability. Preserve image evidence as
      // metadata without embedding an executable or oversized multimodal payload.
      appendText(`[Image tool result: ${mimeType}]`);
      continue;
    }
    if (value.type !== "text" && value.type !== "toolResult") {
      throw new Error("Codex settled-turn projection found malformed tool result content");
    }
    const text =
      value.type === "text"
        ? readBoundedText(value.text, "tool result text")
        : readBoundedText(value.content ?? value.text, "tool result text");
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
    "tool result output",
    isError ? MAX_TEXT_BYTES + Buffer.byteLength(TOOL_ERROR_STATUS_PREFIX, "utf8") : MAX_TEXT_BYTES,
  );
  return {
    result: { id, name },
    item: { type: "function_call_output", call_id: id, output },
  };
}

function* projectMessage(
  message: AgentMessage,
  resolveCallId: (id: string) => string,
): Generator<ProjectedResponseItem> {
  if (message.role === "user") {
    yield { item: projectUserMessage(message) };
  } else if (message.role === "assistant") {
    yield* projectAssistantMessage(message, resolveCallId);
  } else if (message.role === "toolResult") {
    yield projectToolResult(message, resolveCallId);
  } else {
    throw new Error(`Codex settled-turn projection does not support role ${message.role}`);
  }
}

/** Consumes complete evidence or rejects at the existing limits, never truncating its history. */
export function projectSettledCodexMessages(messages: Iterable<AgentMessage>): JsonValue[] {
  const items: JsonValue[] = [];
  const calls = new Map<string, string>();
  const results = new Set<string>();
  const resolveCallId = createProjectedCallIdResolver();
  let bytes = 0;
  for (const message of messages) {
    for (const { item, call, result } of projectMessage(message, resolveCallId)) {
      if (call) {
        if (calls.has(call.id)) {
          throw new Error("Codex settled-turn projection found a duplicate tool call");
        }
        calls.set(call.id, call.name);
      }
      if (result) {
        if (calls.get(result.id) !== result.name || results.has(result.id)) {
          throw new Error("Codex settled-turn projection found an ambiguous tool transcript");
        }
        results.add(result.id);
      }
      if (items.length === MAX_RESPONSE_ITEMS) {
        throw new Error("Codex settled-turn projection exceeds the item limit");
      }
      bytes += responseItemBytes(item);
      if (bytes > MAX_PROJECTION_BYTES) {
        throw new Error("Codex settled-turn projection exceeds the byte limit");
      }
      items.push(item);
    }
  }
  if (calls.size !== results.size) {
    throw new Error("Codex settled-turn projection found an incomplete tool transcript");
  }
  if (results.size === 0) {
    throw new Error("Codex settled-turn projection found no completed tool result");
  }
  return items;
}
