import { Buffer } from "node:buffer";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonValue } from "./protocol.js";
import { readUpstreamUserText } from "./upstream-prompt-provenance.js";

const MAX_RESPONSE_ITEMS = 200;
const MAX_PROJECTION_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;
const TOOL_ERROR_STATUS_PREFIX = "[Tool result status: error]\n";

type ProjectedToolReference = { id: string; name: string };
type ProjectedMessageGroup = {
  items: JsonValue[];
  calls: ProjectedToolReference[];
  results: ProjectedToolReference[];
  bytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

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
  const callId = readNonEmptyString(value);
  if (!callId || callId.length > 256) {
    throw new Error("Codex settled-turn projection found an invalid tool call id");
  }
  return callId;
}

function requireToolName(value: unknown): string {
  const name = readNonEmptyString(value);
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error("Codex settled-turn projection found an invalid tool name");
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

function projectUserMessage(message: AgentMessage): JsonValue[] {
  const record = message as unknown as Record<string, unknown>;
  const upstreamUserText = readUpstreamUserText(message);
  if (upstreamUserText && typeof record.content === "string") {
    return [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: requireBoundedText(upstreamUserText, "upstream user text") },
        ],
      },
    ];
  }
  if (typeof record.content === "string") {
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: requireBoundedText(record.content, "user message") }],
      },
    ];
  }
  if (!Array.isArray(record.content)) {
    throw new Error("Codex settled-turn projection found unsupported user content");
  }
  const content: JsonValue[] = [];
  for (const value of record.content) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed user content");
    }
    if (value.type === "text") {
      const text = readBoundedText(value.text, "user text");
      if (text) {
        content.push({ type: "input_text", text });
      }
      continue;
    }
    throw new Error(
      `Codex settled-turn projection does not support user content ${String(value.type)}`,
    );
  }
  if (content.length === 0) {
    throw new Error("Codex settled-turn projection found an empty user message");
  }
  return [{ type: "message", role: "user", content }];
}

function projectAssistantMessage(message: Record<string, unknown>): {
  items: JsonValue[];
  calls: ProjectedToolReference[];
} {
  const values =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(values)) {
    throw new Error("Codex settled-turn projection found unsupported assistant content");
  }
  const items: JsonValue[] = [];
  const calls: ProjectedToolReference[] = [];
  for (const value of values) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed assistant content");
    }
    if (value.type === "text") {
      const text = readBoundedText(value.text, "assistant text");
      if (text) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      continue;
    }
    if (value.type === "toolCall") {
      const id = requireCallId(value.id ?? value.toolCallId);
      const name = requireToolName(value.name ?? value.toolName);
      calls.push({ id, name });
      items.push({
        type: "function_call",
        call_id: id,
        name,
        arguments: serializeToolArguments(value.arguments ?? value.input),
      });
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
  return { items, calls };
}

function projectToolResult(message: Record<string, unknown>): {
  item: JsonValue;
  result: ProjectedToolReference;
} {
  const id = requireCallId(message.toolCallId);
  const name = requireToolName(message.toolName);
  if (!Array.isArray(message.content)) {
    throw new Error("Codex settled-turn projection found unsupported tool result content");
  }
  if (message.isError !== undefined && typeof message.isError !== "boolean") {
    throw new Error("Codex settled-turn projection found invalid tool result status");
  }
  const isError = message.isError === true;
  const parts: string[] = [];
  for (const value of message.content) {
    if (!isRecord(value)) {
      throw new Error("Codex settled-turn projection found malformed tool result content");
    }
    if (value.type === "image") {
      const mimeType = readNonEmptyString(value.mimeType) ?? "unknown type";
      // The finalizer selects by text capability. Preserve image evidence as
      // metadata without embedding an executable or oversized multimodal payload.
      parts.push(`[Image tool result: ${mimeType}]`);
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
      parts.push(text);
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

function projectMessage(message: AgentMessage): ProjectedMessageGroup | undefined {
  const record = message as unknown as Record<string, unknown>;
  let items: JsonValue[];
  let calls: ProjectedToolReference[] = [];
  let results: ProjectedToolReference[] = [];
  if (message.role === "user") {
    items = projectUserMessage(message);
  } else if (message.role === "assistant") {
    const projected = projectAssistantMessage(record);
    items = projected.items;
    calls = projected.calls;
  } else if (message.role === "toolResult") {
    const projected = projectToolResult(record);
    items = [projected.item];
    results = [projected.result];
  } else {
    throw new Error(`Codex settled-turn projection does not support role ${message.role}`);
  }
  if (items.length === 0) {
    return undefined;
  }
  return {
    items,
    calls,
    results,
    bytes: items.reduce<number>((total, item) => total + responseItemBytes(item), 0),
  };
}

function validateExactlyPairedCalls(groups: readonly ProjectedMessageGroup[]): number {
  const calls = new Map<string, { name: string; groupIndex: number }>();
  const results = new Set<string>();
  let resultCount = 0;
  for (const [groupIndex, group] of groups.entries()) {
    for (const call of group.calls) {
      if (calls.has(call.id)) {
        throw new Error("Codex settled-turn projection found a duplicate tool call");
      }
      calls.set(call.id, { name: call.name, groupIndex });
    }
    for (const result of group.results) {
      const call = calls.get(result.id);
      if (
        !call ||
        call.groupIndex >= groupIndex ||
        call.name !== result.name ||
        results.has(result.id)
      ) {
        throw new Error("Codex settled-turn projection found an ambiguous tool transcript");
      }
      results.add(result.id);
      resultCount += 1;
    }
  }
  if (calls.size !== results.size) {
    throw new Error("Codex settled-turn projection found an incomplete tool transcript");
  }
  return resultCount;
}

/** Projects the complete frozen transcript or rejects it without truncation or tail dropping. */
export function projectSettledCodexMessages(messages: readonly AgentMessage[]): JsonValue[] {
  const groups = messages.flatMap((message) => {
    const projected = projectMessage(message);
    return projected ? [projected] : [];
  });
  if (validateExactlyPairedCalls(groups) === 0) {
    throw new Error("Codex settled-turn projection found no completed tool result");
  }
  const items = groups.flatMap((group) => group.items);
  if (items.length > MAX_RESPONSE_ITEMS) {
    throw new Error("Codex settled-turn projection exceeds the item limit");
  }
  const bytes = groups.reduce((total, group) => total + group.bytes, 0);
  if (bytes > MAX_PROJECTION_BYTES) {
    throw new Error("Codex settled-turn projection exceeds the byte limit");
  }
  return items;
}
