// QA Lab source is mounted into package acceptance without the local-only QA Channel SDK.
// Keep its in-memory bus protocol self-contained; parity tests guard the shared semantics.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaBusConversation, QaBusToolCall } from "./runtime-api.js";

type QaTargetParts = {
  chatType: QaBusConversation["kind"];
  conversationId: string;
  threadId?: string;
};

export function parseQaTarget(raw: string): QaTargetParts {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error("qa-channel target is required");
  }
  const prefixed = /^(thread|channel|group|dm):(.*)$/u.exec(normalized);
  if (!prefixed && /^(thread|channel|group|dm):/iu.test(normalized)) {
    throw new Error(`qa-channel target prefixes must be lowercase: ${normalized}`);
  }
  const prefix = prefixed?.[1];
  const rest = prefixed?.[2]?.trim();
  if (prefix === "thread") {
    if (!rest) {
      throw new Error(`invalid qa-channel thread target: ${normalized}`);
    }
    const slashIndex = rest.indexOf("/");
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      throw new Error(`invalid qa-channel thread target: ${normalized}`);
    }
    const conversationId = rest.slice(0, slashIndex).trim();
    const threadId = rest.slice(slashIndex + 1).trim();
    if (!conversationId || !threadId) {
      throw new Error(`invalid qa-channel thread target: ${normalized}`);
    }
    return {
      chatType: "channel",
      conversationId,
      threadId,
    };
  }
  if (prefix) {
    if (!rest) {
      throw new Error(`invalid qa-channel ${prefix} target: ${normalized}`);
    }
    return {
      chatType: prefix === "dm" ? "direct" : prefix === "group" ? "group" : "channel",
      conversationId: rest,
    };
  }
  return {
    chatType: "direct",
    conversationId: normalized,
  };
}

const TOOL_CALL_MAX_COUNT = 50;
const TOOL_CALL_MAX_DEPTH = 4;
const TOOL_CALL_MAX_ARRAY_LENGTH = 20;
const TOOL_CALL_MAX_OBJECT_KEYS = 40;
const TOOL_CALL_REDACTED = "[redacted]";
const TOOL_CALL_SENSITIVE_KEY_RE =
  /authorization|cookie|credential|password|secret|token|api[-_]?key|access[-_]?key|private[-_]?key/iu;

function sanitizeToolCallValue(value: unknown, depth: number, key?: string): unknown {
  if (key && TOOL_CALL_SENSITIVE_KEY_RE.test(key)) {
    return TOOL_CALL_REDACTED;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
  }
  if (typeof value === "string") {
    return TOOL_CALL_REDACTED;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= TOOL_CALL_MAX_DEPTH) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, TOOL_CALL_MAX_ARRAY_LENGTH).map((entry) => {
      return sanitizeToolCallValue(entry, depth + 1);
    });
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, TOOL_CALL_MAX_OBJECT_KEYS)
        .flatMap(([entryKey, entryValue]) => {
          const sanitized = sanitizeToolCallValue(entryValue, depth + 1, entryKey);
          return sanitized === undefined ? [] : [[entryKey, sanitized]];
        }),
    );
  }
  return undefined;
}

function sanitizeToolCallArguments(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sanitized = sanitizeToolCallValue(value, 0);
  return isRecord(sanitized) ? sanitized : undefined;
}

export function sanitizeQaBusToolCalls(value: unknown): QaBusToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sanitized = value.slice(0, TOOL_CALL_MAX_COUNT).flatMap((toolCall) => {
    if (!isRecord(toolCall)) {
      return [];
    }
    const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
    if (!name) {
      return [];
    }
    const args = sanitizeToolCallArguments(toolCall.arguments);
    return [
      {
        name,
        ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
      },
    ];
  });
  return sanitized.length > 0 ? sanitized : undefined;
}
