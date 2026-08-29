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

export type CodeModeJsonSource =
  | { kind: "complete"; json: string }
  | { kind: "prefix"; json: string; originalBytes: number };

export type CodeModeOutputSource = { count: number; source: CodeModeJsonSource };

export const EMPTY_CODE_MODE_OUTPUT: CodeModeOutputSource = {
  count: 0,
  source: { kind: "complete", json: "[]" },
};

function sourceBytes(source: CodeModeJsonSource): number {
  return source.kind === "prefix" ? source.originalBytes : Buffer.byteLength(source.json, "utf8");
}

function retainSource(json: string, originalBytes: number, maxBytes: number): CodeModeJsonSource {
  return originalBytes <= maxBytes
    ? { kind: "complete", json }
    : { kind: "prefix", json: truncateUtf8Prefix(json, maxBytes), originalBytes };
}

/** Capture after guest conversion, before any public projection discards source facts. */
export function captureCodeModeValue(value: unknown, maxBytes: number): CodeModeJsonSource {
  const json = JSON.stringify(toCodeModeJsonSafe(value)) ?? "null";
  return retainSource(json, Buffer.byteLength(json, "utf8"), maxBytes);
}

export function captureCodeModeOutput(output: unknown[], maxBytes: number): CodeModeOutputSource {
  if (output.length === 0) {
    return EMPTY_CODE_MODE_OUTPUT;
  }
  const json = JSON.stringify(output.map(toCodeModeJsonSafe));
  return {
    count: output.length,
    source: retainSource(json, Buffer.byteLength(json, "utf8"), maxBytes),
  };
}

const TRUNCATION_GUIDANCE = "Output truncated; rerun with narrower args.";

function truncationMarker(source: CodeModeJsonSource, maxBytes: number) {
  const originalBytes = sourceBytes(source);
  let prefix = truncateUtf8Prefix(source.json, maxBytes);
  while (true) {
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    const candidate = {
      truncated: true,
      omittedBytes: originalBytes - prefixBytes,
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

function projectValue(source: CodeModeJsonSource, maxBytes: number): unknown {
  return source.kind === "complete" && sourceBytes(source) <= maxBytes
    ? (JSON.parse(source.json) as unknown)
    : truncationMarker(source, maxBytes);
}

/** Nested bridge markers are ordinary guest data when later emitted or returned. */
export function boundCodeModeValue(value: unknown, maxBytes: number): unknown {
  return projectValue(captureCodeModeValue(value, maxBytes), maxBytes);
}

export function boundCodeModeError(error: string, maxBytes: number): string {
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

type DeliveryReceipt =
  | { kind: "entries"; count: number }
  | { kind: "summary"; originalBytes: number; prefixBytes: number };
type TerminalChannels = { value?: CodeModeJsonSource; error?: string };
type DeliveredChannels = { output: unknown[]; value?: unknown; error?: string };

/** One bounded cumulative source and delivery receipt, shared across every worker leg. */
export class CodeModeOutputState {
  source: CodeModeOutputSource = EMPTY_CODE_MODE_OUTPUT;
  private delivered: DeliveryReceipt = { kind: "entries", count: 0 };

  constructor(private readonly maxBytes: number) {}

  append(leg: CodeModeOutputSource): void {
    if (leg.count === 0) {
      return;
    }
    if (this.source.count === 0) {
      this.source = leg;
      return;
    }
    const previous = this.source.source;
    const originalBytes = sourceBytes(previous) + sourceBytes(leg.source) - 1;
    // Nonempty array concatenation removes two brackets and adds one comma.
    // A missing earlier suffix forbids appending any later prefix after that hole.
    const json =
      previous.kind === "prefix"
        ? previous.json
        : previous.json.slice(0, -1) + "," + leg.source.json.slice(1);
    this.source = {
      count: this.source.count + leg.count,
      source: retainSource(json, originalBytes, this.maxBytes),
    };
  }

  take(params: TerminalChannels & { error: string }): DeliveredChannels & { error: string };
  take(params?: TerminalChannels): DeliveredChannels;
  take(params: TerminalChannels = {}): DeliveredChannels {
    const { count, source } = this.source;
    const outputBytes = count === 0 ? 0 : sourceBytes(source);
    const valueBytes = params.value === undefined ? 0 : sourceBytes(params.value);
    // Short channels donate their unused share; diagnostics retain their leading cause.
    const error =
      params.error === undefined
        ? undefined
        : boundCodeModeError(
            params.error,
            this.maxBytes - Math.min(outputBytes + valueBytes, Math.floor(this.maxBytes / 2)),
          );
    const remaining = this.maxBytes - (error === undefined ? 0 : jsonUtf8Bytes(error));
    const outputAllowance = remaining - Math.min(valueBytes, Math.floor(remaining / 2));
    let output: unknown[];
    let chargedOutputBytes: number;
    if (outputBytes <= outputAllowance) {
      // A retained prefix has originalBytes > maxBytes and cannot fit this allowance.
      // SAFETY: Complete output sources encode normalized arrays, never guest metadata.
      const entries = JSON.parse(source.json) as unknown[];
      output = entries.slice(this.delivered.kind === "entries" ? this.delivered.count : count);
      chargedOutputBytes = outputBytes;
      this.delivered = { kind: "entries", count };
    } else {
      const marker = truncationMarker(source, outputAllowance - 2);
      const prefixBytes = Buffer.byteLength(marker.prefix, "utf8");
      const prior = this.delivered;
      output =
        prior.kind === "summary" &&
        prior.originalBytes === outputBytes &&
        prior.prefixBytes === prefixBytes
          ? []
          : [marker];
      chargedOutputBytes = jsonUtf8Bytes([marker]);
      this.delivered = { kind: "summary", originalBytes: outputBytes, prefixBytes };
    }
    // Allocate from the full cumulative projection before suppressing prior delivery.
    return {
      output,
      ...(params.value === undefined
        ? {}
        : { value: projectValue(params.value, remaining - chargedOutputBytes) }),
      ...(error === undefined ? {} : { error }),
    };
  }
}
