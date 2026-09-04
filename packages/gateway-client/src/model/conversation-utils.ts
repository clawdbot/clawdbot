import {
  ControlModelCommandError,
  type ControlModelCommandCategory,
} from "./conversation-types.js";
import type { ControlModelConnectionSnapshot } from "./model.js";

export function record(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // SAFETY: the runtime checks exclude null and arrays before treating this object as a record.
    return value as Record<string, unknown>;
  }
  return null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (seen.has(value)) {
    return "[cycle]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }
  // SAFETY: the primitive and array branches above leave only plain object-like values.
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key], seen)}`)
    .join(",")}}`;
}

export function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

export function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    // SAFETY: cached clones are inserted from the same generic input graph.
    return existing as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) {
      clone.push(cloneAndFreeze(item, seen));
    }
    // SAFETY: the clone preserves the recursively frozen array shape of T.
    return Object.freeze(clone) as T;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = cloneAndFreeze(item, seen);
  }
  // SAFETY: the clone preserves the recursively frozen object shape of T.
  return Object.freeze(clone) as T;
}

export function normalizeGatewayError(error: unknown, command: string): ControlModelCommandError {
  if (error instanceof ControlModelCommandError) {
    return error;
  }
  const source = record(error);
  const details = record(source?.details);
  const rawCode = text(source?.code) ?? text(source?.gatewayCode) ?? "CONTROL_MODEL_REQUEST_FAILED";
  const code = rawCode.slice(0, 80);
  const lowerCode = rawCode.toLowerCase();
  const lowerReason = (text(details?.reason) ?? "").toLowerCase();
  const lower = `${lowerCode} ${lowerReason}`.trim();
  const message = (
    text(error instanceof Error ? error.message : source?.message) ?? "Gateway request failed"
  ).slice(0, 240);
  let category: ControlModelCommandCategory = "malformed";
  const isAbortException =
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError";
  if (
    isAbortException ||
    (error instanceof Error && error.name === "AbortError") ||
    lowerCode === "aborterror"
  ) {
    category = "aborted";
  } else if (lower.includes("forbidden") || lower.includes("unauthorized")) {
    category = "forbidden";
  } else if (lower.includes("invalid")) {
    category = "invalid-input";
  } else if (lower.includes("not_found") || lower.includes("not-found")) {
    category = "not-found";
  } else if (lower.includes("timeout") || lower.includes("deadline_exceeded")) {
    category = "timeout";
  } else if (lower.includes("abort") || lower.includes("cancel")) {
    category = "aborted";
  } else if (
    lower.includes("conflict") ||
    lower.includes("already_resolved") ||
    lower.includes("stale")
  ) {
    category = "conflict";
  } else if (lower.includes("disconnected")) {
    category = "disconnected";
  } else if (lower.includes("unavailable")) {
    category = "retryable";
  } else if (source?.retryable === true) {
    category = "retryable";
  }
  const retryAfterMs = safeInteger(source?.retryAfterMs ?? details?.retryAfterMs);
  return new ControlModelCommandError({
    category,
    code,
    message,
    command,
    retryable:
      source?.retryable === true ||
      category === "timeout" ||
      category === "retryable" ||
      category === "disconnected",
    ...(retryAfterMs !== null && retryAfterMs >= 0 ? { retryAfterMs } : {}),
  });
}

export function localError(
  category: ControlModelCommandCategory,
  command: string,
  message: string,
  code = category.toUpperCase(),
): ControlModelCommandError {
  return new ControlModelCommandError({ category, command, code, message });
}

export function connectionError(
  command: string,
  connection: ControlModelConnectionSnapshot,
): ControlModelCommandError {
  return new ControlModelCommandError({
    category: "disconnected",
    command,
    code:
      connection.status === "connecting" || connection.status === "reconnecting"
        ? "NOT_READY"
        : "UNAVAILABLE",
    message: "Gateway connection is not ready",
    retryable: true,
  });
}

const TOOL_VALUE_TRUNCATION_MARKER = Object.freeze({
  kind: "truncated",
  reason: "max-progress-bytes",
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateStringToSerializedBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 2) {
    return "";
  }
  let result = "";
  let bytes = 2;
  for (const character of value) {
    const encodedCharacter = JSON.stringify(character).slice(1, -1);
    const characterBytes = byteLength(encodedCharacter);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function boundedValue(
  value: unknown,
  maxBytes: number,
): { value: unknown; bytes: number; truncated: boolean } {
  const limit = Math.max(0, maxBytes);
  const encoded = stableStringify(value);
  const bytes = byteLength(encoded);
  if (bytes <= limit) {
    return { value, bytes, truncated: false };
  }
  if (typeof value === "string") {
    const truncated = truncateStringToSerializedBytes(value, limit);
    return {
      value: truncated,
      bytes: Math.min(limit, byteLength(JSON.stringify(truncated))),
      truncated: true,
    };
  }
  return {
    value: TOOL_VALUE_TRUNCATION_MARKER,
    bytes: Math.min(limit, byteLength(stableStringify(TOOL_VALUE_TRUNCATION_MARKER))),
    truncated: true,
  };
}

export function normalizeStatus(value: unknown): string {
  return text(value)?.toLowerCase() ?? "unknown";
}
