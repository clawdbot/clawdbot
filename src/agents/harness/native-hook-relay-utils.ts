import { truncateUtf16Safe, truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import type {
  JsonValue,
  NativeHookRelayEvent,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";

const MAX_NATIVE_HOOK_RELAY_JSON_DEPTH = 64;
const MAX_NATIVE_HOOK_RELAY_JSON_NODES = 20_000;
const MAX_NATIVE_HOOK_RELAY_STRING_LENGTH = 1_000_000;
const MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH = 4_000_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH = 4_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH = 20_000;
const MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS = 50;
const MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS = 50;

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeOptionalPositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function shellQuoteArgs(args: readonly string[]): string {
  return args.map((arg) => shellQuoteArg(arg, process.platform)).join(" ");
}

function shellQuoteArg(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  if (platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function readNativeHookRelayProvider(value: unknown): NativeHookRelayProvider {
  if (value === "codex") {
    return value;
  }
  throw new Error("unsupported native hook relay provider");
}

export function readNativeHookRelayEvent(value: unknown): NativeHookRelayEvent {
  if (
    value === "pre_tool_use" ||
    value === "post_tool_use" ||
    value === "permission_request" ||
    value === "before_agent_finalize"
  ) {
    return value;
  }
  throw new Error("unsupported native hook relay event");
}

export function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`native hook relay ${name} is required`);
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let totalStringLength = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (
      nodes > MAX_NATIVE_HOOK_RELAY_JSON_NODES ||
      current.depth > MAX_NATIVE_HOOK_RELAY_JSON_DEPTH
    ) {
      return false;
    }
    if (current.value === null) {
      continue;
    }
    if (typeof current.value === "string") {
      if (current.value.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
        return false;
      }
      totalStringLength += current.value.length;
      if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "boolean") {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isJsonObject(current.value)) {
      return false;
    }
    try {
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) {
          continue;
        }
        if (key.length > MAX_NATIVE_HOOK_RELAY_STRING_LENGTH) {
          return false;
        }
        totalStringLength += key.length;
        if (totalStringLength > MAX_NATIVE_HOOK_RELAY_TOTAL_STRING_LENGTH) {
          return false;
        }
        if (nodes + stack.length + 1 > MAX_NATIVE_HOOK_RELAY_JSON_NODES) {
          return false;
        }
        stack.push({ value: current.value[key], depth: current.depth + 1 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function snapshotNativeHookRelayPayload(payload: JsonValue): JsonValue {
  return snapshotJsonValue(payload, {
    remainingStringLength: MAX_NATIVE_HOOK_RELAY_HISTORY_TOTAL_STRING_LENGTH,
  });
}

function snapshotJsonValue(value: JsonValue, state: { remainingStringLength: number }): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return snapshotString(value, state);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS)
      .map((item) => snapshotJsonValue(item, state));
    if (value.length > MAX_NATIVE_HOOK_RELAY_HISTORY_ARRAY_ITEMS) {
      items.push("[truncated]");
    }
    return items;
  }
  const snapshot: Record<string, JsonValue> = {};
  const keys = Object.keys(value);
  for (const key of keys.slice(0, MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS)) {
    const item = value[key];
    if (item !== undefined) {
      snapshot[snapshotString(key, state)] = snapshotJsonValue(item, state);
    }
  }
  if (keys.length > MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS) {
    snapshot["[truncated]"] = keys.length - MAX_NATIVE_HOOK_RELAY_HISTORY_OBJECT_KEYS;
  }
  return snapshot;
}

function snapshotString(value: string, state: { remainingStringLength: number }): string {
  if (state.remainingStringLength <= 0) {
    return "[truncated]";
  }
  const limit = Math.min(
    value.length,
    MAX_NATIVE_HOOK_RELAY_HISTORY_STRING_LENGTH,
    state.remainingStringLength,
  );
  if (limit >= value.length) {
    state.remainingStringLength -= limit;
    return value;
  }
  const prefix = truncateUtf16Safe(value, limit);
  // Charge the retained prefix; a safe boundary may back up one code unit.
  state.remainingStringLength -= prefix.length;
  return `${prefix}...[truncated]`;
}

export function truncateText(value: string, maxLength: number): string {
  return truncateWithMarker(value, maxLength, { marker: "...", reserve: 3, trimEnd: false });
}
