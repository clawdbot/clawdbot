import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export function toCodeModeJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
  } catch {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
        return value;
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

const TRUNCATION_GUIDANCE = "Output truncated; rerun with narrower args.";

function truncationMarker(serialized: string, maxBytes: number): unknown {
  const sourceBytes = Buffer.byteLength(serialized, "utf8");
  let prefix = truncateUtf8Prefix(serialized, maxBytes);
  while (true) {
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    const candidate = {
      truncated: true,
      omittedBytes: sourceBytes - prefixBytes,
      guidance: TRUNCATION_GUIDANCE,
      prefix,
    };
    const overflow = jsonUtf8Bytes(candidate) - maxBytes;
    if (overflow <= 0 || prefixBytes === 0) {
      return candidate;
    }
    prefix = truncateUtf8Prefix(prefix, Math.max(0, prefixBytes - overflow));
  }
}

/** Bound one JSON-compatible value, preserving a UTF-8-safe serialized prefix. */
export function boundCodeModeValue(value: unknown, maxBytes: number): unknown {
  const safe = toCodeModeJsonSafe(value);
  const serialized = JSON.stringify(safe) ?? "null";
  return Buffer.byteLength(serialized, "utf8") <= maxBytes
    ? safe
    : truncationMarker(serialized, maxBytes);
}

function boundOutputArray(output: unknown[], maxBytes: number): unknown[] {
  if (jsonUtf8Bytes(output) <= maxBytes) {
    return output;
  }
  return [truncationMarker(JSON.stringify(output), maxBytes - 2)];
}

/** Bound cumulative guest output and the final value under one serialized byte budget. */
export function boundCodeModeResult(params: {
  output: unknown[];
  value?: unknown;
  maxOutputBytes: number;
}): { output: unknown[]; value?: unknown; truncated: boolean } {
  const hasValue = Object.hasOwn(params, "value");
  const safeOutput = params.output.map(toCodeModeJsonSafe);
  const safeValue = hasValue ? toCodeModeJsonSafe(params.value) : undefined;
  const outputBytes = safeOutput.length > 0 ? jsonUtf8Bytes(safeOutput) : 0;
  const valueBytes = hasValue ? jsonUtf8Bytes(safeValue) : 0;
  if (outputBytes + valueBytes <= params.maxOutputBytes) {
    return { output: safeOutput, ...(hasValue ? { value: safeValue } : {}), truncated: false };
  }
  if (safeOutput.length === 0) {
    return {
      output: [],
      ...(hasValue ? { value: boundCodeModeValue(safeValue, params.maxOutputBytes) } : {}),
      truncated: true,
    };
  }

  // Preserve both channels when both overflow: reserve half for the final
  // value, then let short values donate their unused share to guest output.
  const reservedValueBytes = hasValue
    ? Math.min(valueBytes, Math.floor(params.maxOutputBytes / 2))
    : 0;
  const output = boundOutputArray(safeOutput, params.maxOutputBytes - reservedValueBytes);
  if (!hasValue) {
    return { output, truncated: true };
  }
  const remainingBytes = params.maxOutputBytes - jsonUtf8Bytes(output);
  return { output, value: boundCodeModeValue(safeValue, remainingBytes), truncated: true };
}
