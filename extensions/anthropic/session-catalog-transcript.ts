import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_TRANSCRIPT_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_LENGTH = 1_000_000;

export type ClaudeTranscriptItem = {
  type: string;
  text?: string;
  content?: unknown;
  timestamp?: string;
  model?: string;
  uuid?: string;
  truncated?: true;
};

function transcriptItemType(role: string, content: unknown): string {
  if (!Array.isArray(content)) {
    return role === "user" ? "userMessage" : "agentMessage";
  }
  const types = content.flatMap((block) =>
    isRecord(block) && typeof block.type === "string" ? [block.type] : [],
  );
  if (types.length > 0 && types.every((type) => type === "tool_result")) {
    return "toolResult";
  }
  if (types.length > 0 && types.every((type) => type === "tool_use")) {
    return "toolCall";
  }
  if (types.length > 0 && types.every((type) => type === "thinking")) {
    return "reasoning";
  }
  return role === "user" ? "userMessage" : "agentMessage";
}

export function collectTranscriptText(value: unknown, fragments: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      fragments.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTranscriptText(item, fragments);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["text", "thinking", "content", "input"]) {
    if (key in value) {
      collectTranscriptText(value[key], fragments);
    }
  }
}

export function parseTranscriptLine(
  line: Buffer,
  optionalString: (value: unknown, maxLength?: number) => string | undefined,
): ClaudeTranscriptItem | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.isSidechain === true || !isRecord(raw.message)) {
    return undefined;
  }
  const role = raw.message.role;
  if ((role !== "user" && role !== "assistant") || raw.type !== role) {
    return undefined;
  }
  const content = raw.message.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    return undefined;
  }
  const fragments: string[] = [];
  collectTranscriptText(content, fragments);
  const text = [...new Set(fragments)].join("\n\n");
  const item: ClaudeTranscriptItem = {
    type: transcriptItemType(role, content),
    ...(text ? { text } : {}),
    content,
    ...(optionalString(raw.timestamp, 128)
      ? { timestamp: optionalString(raw.timestamp, 128) }
      : {}),
    ...(optionalString(raw.message.model, 256)
      ? { model: optionalString(raw.message.model, 256) }
      : {}),
    ...(optionalString(raw.uuid, 256) ? { uuid: optionalString(raw.uuid, 256) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_TRANSCRIPT_ITEM_BYTES) {
    return item;
  }
  return {
    type: item.type,
    text: `${truncateUtf16Safe(text, MAX_TRANSCRIPT_TEXT_LENGTH)}\n\n[oversized Claude item truncated]`,
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.uuid ? { uuid: item.uuid } : {}),
    truncated: true,
  };
}
