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

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function utf8Prefix(buffer: Buffer, byteLength: number): { bytes: number; text: string } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = Math.min(byteLength, buffer.byteLength);
  while (bytes > 0) {
    try {
      return { bytes, text: decoder.decode(buffer.subarray(0, bytes)) };
    } catch {
      bytes -= 1;
    }
  }
  return { bytes: 0, text: "" };
}

function truncationMarker(serialized: string, maxBytes: number): unknown {
  const source = Buffer.from(serialized, "utf8");
  let low = 0;
  let high = source.byteLength;
  let best = {
    truncated: true,
    omittedBytes: source.byteLength,
    guidance: TRUNCATION_GUIDANCE,
    prefix: "",
  };
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidatePrefix = utf8Prefix(source, midpoint);
    const candidate = {
      truncated: true,
      omittedBytes: source.byteLength - candidatePrefix.bytes,
      guidance: TRUNCATION_GUIDANCE,
      prefix: candidatePrefix.text,
    };
    if (jsonByteLength(candidate) <= maxBytes) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
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
  const safe = output.map(toCodeModeJsonSafe);
  if (jsonByteLength(safe) <= maxBytes) {
    return safe;
  }
  return [truncationMarker(JSON.stringify(safe), maxBytes - 2)];
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
  const outputBytes = safeOutput.length > 0 ? jsonByteLength(safeOutput) : 0;
  const valueBytes = hasValue ? jsonByteLength(safeValue) : 0;
  if (outputBytes + valueBytes <= params.maxOutputBytes) {
    return { output: safeOutput, ...(hasValue ? { value: safeValue } : {}), truncated: false };
  }
  if (!hasValue) {
    return { output: boundOutputArray(safeOutput, params.maxOutputBytes), truncated: true };
  }
  if (safeOutput.length === 0) {
    return {
      output: [],
      value: boundCodeModeValue(safeValue, params.maxOutputBytes),
      truncated: true,
    };
  }

  // Preserve both channels when both overflow: reserve half for the final
  // value, then let short values donate their unused share to guest output.
  const reservedValueBytes = Math.min(valueBytes, Math.floor(params.maxOutputBytes / 2));
  const output = boundOutputArray(safeOutput, params.maxOutputBytes - reservedValueBytes);
  const remainingBytes = params.maxOutputBytes - jsonByteLength(output);
  return { output, value: boundCodeModeValue(safeValue, remainingBytes), truncated: true };
}
