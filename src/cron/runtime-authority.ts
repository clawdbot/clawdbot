import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../utils.js";

const CRON_RUNTIME_AUTHORITY_MAX_BYTES = 64 * 1024;
const CRON_RUNTIME_AUTHORITY_MAX_ID_LENGTH = 128;
const CRON_RUNTIME_AUTHORITY_MAX_DEPTH = 16;
const CRON_RUNTIME_AUTHORITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const CRON_RUNTIME_AUTHORITY_KEYS = new Set(["version", "runtimeId", "namespace", "payload"]);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CronRuntimeAuthority = Readonly<{
  version: 1;
  /** Concrete harness runtime that alone may consume this opaque authority. */
  runtimeId: string;
  /** Runtime-owned payload discriminator; core never interprets its value. */
  namespace: string;
  payload: Readonly<Record<string, unknown>>;
}>;

function normalizeAuthorityId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized &&
    normalized.length <= CRON_RUNTIME_AUTHORITY_MAX_ID_LENGTH &&
    CRON_RUNTIME_AUTHORITY_ID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function cloneJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): JsonValue | undefined {
  if (depth > CRON_RUNTIME_AUTHORITY_MAX_DEPTH) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const cloned = cloneJsonValue(item, seen, depth + 1);
      if (cloned === undefined) {
        return undefined;
      }
      result.push(cloned);
    }
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  // A null prototype preserves hostile-but-valid JSON keys such as `__proto__`
  // as data instead of invoking an object-literal prototype setter.
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(value)) {
    const cloned = cloneJsonValue(item, seen, depth + 1);
    if (cloned === undefined) {
      return undefined;
    }
    result[key] = cloned;
  }
  seen.delete(value);
  return result;
}

function cloneJsonObject(value: unknown): Record<string, JsonValue> | undefined {
  if (!isRecord(value) || Array.isArray(value)) {
    return undefined;
  }
  const cloned = cloneJsonValue(value, new WeakSet(), 0);
  return isRecord(cloned) && !Array.isArray(cloned)
    ? (cloned as Record<string, JsonValue>)
    : undefined;
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (value && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}

/** Validates the private persisted transport without learning runtime-owned payload semantics. */
export function normalizeCronRuntimeAuthority(value: unknown): CronRuntimeAuthority | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !CRON_RUNTIME_AUTHORITY_KEYS.has(key)) ||
    !Object.hasOwn(value, "runtimeId") ||
    !Object.hasOwn(value, "namespace") ||
    !Object.hasOwn(value, "payload")
  ) {
    return undefined;
  }
  const runtimeId = normalizeAuthorityId(value.runtimeId);
  const namespace = normalizeAuthorityId(value.namespace);
  const payload = cloneJsonObject(value.payload);
  if (!runtimeId || !namespace || !payload) {
    return undefined;
  }
  const normalized = {
    version: 1,
    runtimeId,
    namespace,
    payload: deepFreezeJson(payload) as Readonly<Record<string, unknown>>,
  } as const;
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > CRON_RUNTIME_AUTHORITY_MAX_BYTES) {
    return undefined;
  }
  return Object.freeze(normalized);
}

export function cloneCronRuntimeAuthority(
  value: CronRuntimeAuthority,
): CronRuntimeAuthority | undefined {
  return normalizeCronRuntimeAuthority(value);
}
