/**
 * Minimal TOML inline serializer for CLI config overrides.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : `"${escapeTomlString(key)}"`;
}

/** Serialize a supported value into TOML inline syntax. */
export function serializeTomlInlineValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${escapeTomlString(value)}"`;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeTomlInlineValue(entry)).join(", ")}]`;
  }
  if (isRecord(value)) {
    // Inline table key ordering follows Object.entries input order, which callers
    // control when deterministic override output matters.
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${formatTomlKey(key)} = ${serializeTomlInlineValue(entry)}`)
      .join(", ")} }`;
  }
  throw new Error(`Unsupported TOML inline value: ${String(value)}`);
}

/** Format one CLI config override as `key=value`. */
export function formatTomlConfigOverride(key: string, value: unknown): string {
  return `${key}=${serializeTomlInlineValue(value)}`;
}
