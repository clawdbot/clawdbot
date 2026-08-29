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

function boundErrorString(error: string, maxBytes: number): string {
  if (jsonUtf8Bytes(error) <= maxBytes) {
    return error;
  }
  let low = 0;
  let high = Math.min(Buffer.byteLength(error, "utf8"), maxBytes);
  // Escaped characters cost more in JSON than in UTF-8; removing the serialized
  // overflow from the raw prefix can erase the entire diagnostic.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${truncateUtf8Prefix(error, middle)} [error truncated]`;
    if (jsonUtf8Bytes(candidate) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${truncateUtf8Prefix(error, low)} [error truncated]`;
}

type CodeModeResultInput = {
  output: unknown[];
  value?: unknown;
  error?: string;
  maxOutputBytes: number;
};
type BoundedCodeModeResult = {
  output: unknown[];
  value?: unknown;
  error?: string;
  truncated: boolean;
  outputTruncated?: boolean;
};

/** Bound guest output, the final value, and failure text under one serialized byte budget. */
export function boundCodeModeResult(
  params: CodeModeResultInput & { error: string },
): BoundedCodeModeResult & { error: string };
export function boundCodeModeResult(params: CodeModeResultInput): BoundedCodeModeResult;
export function boundCodeModeResult(params: CodeModeResultInput): BoundedCodeModeResult {
  const hasValue = Object.hasOwn(params, "value");
  const safeOutput = params.output.map(toCodeModeJsonSafe);
  const safeValue = hasValue ? toCodeModeJsonSafe(params.value) : undefined;
  const outputBytes = safeOutput.length > 0 ? jsonUtf8Bytes(safeOutput) : 0;
  const valueBytes = hasValue ? jsonUtf8Bytes(safeValue) : 0;
  const errorBytes = params.error === undefined ? 0 : jsonUtf8Bytes(params.error);
  const error = params.error === undefined ? {} : { error: params.error };
  if (outputBytes + valueBytes + errorBytes <= params.maxOutputBytes) {
    return {
      output: safeOutput,
      ...(hasValue ? { value: safeValue } : {}),
      ...error,
      truncated: false,
    };
  }
  // Failure text stays a string, so callers and the model retain the original
  // cause even when output competes for space. Short channels donate their share.
  if (error.error !== undefined) {
    const reservedOutputBytes = Math.min(
      outputBytes + valueBytes,
      Math.floor(params.maxOutputBytes / 2),
    );
    error.error = boundErrorString(error.error, params.maxOutputBytes - reservedOutputBytes);
  }
  const maxOutputBytes =
    params.maxOutputBytes - (error.error === undefined ? 0 : jsonUtf8Bytes(error.error));
  if (safeOutput.length === 0) {
    return {
      output: [],
      ...(hasValue ? { value: boundCodeModeValue(safeValue, maxOutputBytes) } : {}),
      ...error,
      truncated: true,
    };
  }

  // Preserve both channels when both overflow: reserve half for the final
  // value, then let short values donate their unused share to guest output.
  const reservedValueBytes = hasValue ? Math.min(valueBytes, Math.floor(maxOutputBytes / 2)) : 0;
  const output = boundOutputArray(safeOutput, maxOutputBytes - reservedValueBytes);
  const outputTruncated = output !== safeOutput;
  if (!hasValue) {
    return { output, ...error, truncated: true, outputTruncated };
  }
  const remainingBytes = maxOutputBytes - jsonUtf8Bytes(output);
  return {
    output,
    value: boundCodeModeValue(safeValue, remainingBytes),
    ...error,
    truncated: true,
    outputTruncated,
  };
}
