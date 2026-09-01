import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { toolResultFitsBudget, type ToolResultBudget } from "./tool-result-limits.js";
import { renderToolSearchControlText } from "./tool-search-control-result.js";

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

function fitJsonPrefix<T>(text: string, maxBytes: number, project: (prefix: string) => T): T {
  let low = 0;
  let high = Math.min(Buffer.byteLength(text, "utf8"), maxBytes);
  // JSON escaping makes serialized bytes cost more than raw prefix bytes.
  // Measure the complete projection so fitting cannot erase a useful prefix.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonUtf8Bytes(project(truncateUtf8Prefix(text, middle))) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return project(truncateUtf8Prefix(text, low));
}

function truncationMarker(source: CodeModeJsonSource, maxBytes: number) {
  const originalBytes = sourceBytes(source);
  return fitJsonPrefix(source.json, maxBytes, (prefix) => ({
    truncated: true,
    omittedBytes: originalBytes - Buffer.byteLength(prefix, "utf8"),
    guidance: TRUNCATION_GUIDANCE,
    prefix,
  }));
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
  return jsonUtf8Bytes(error) <= maxBytes
    ? error
    : fitJsonPrefix(error, maxBytes, (prefix) => `${prefix} [error truncated]`);
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

  constructor(
    private readonly maxBytes: number,
    private readonly modelBudget?: ToolResultBudget,
  ) {}

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
    return this.takeResult({}, params);
  }

  takeResult<T extends object>(
    metadata: T,
    params: TerminalChannels & { error: string },
    networkContent?: boolean,
  ): T & DeliveredChannels & { error: string };
  takeResult<T extends object>(
    metadata: T,
    params?: TerminalChannels,
    networkContent?: boolean,
  ): T & DeliveredChannels;
  takeResult<T extends object>(
    metadata: T,
    params: TerminalChannels = {},
    networkContent = false,
  ): T & DeliveredChannels {
    const fits = (candidate: ReturnType<CodeModeOutputState["project"]>) => {
      const rendered = renderToolSearchControlText(
        JSON.stringify({ ...metadata, ...candidate.channels }, null, 2),
        networkContent,
      );
      return !rendered.truncated && toolResultFitsBudget(rendered.text, this.modelBudget);
    };
    let projection = this.project(params, this.maxBytes);
    if ((this.modelBudget || networkContent) && !fits(projection)) {
      let low = 0;
      let high = this.maxBytes - 1;
      let best: typeof projection | undefined;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = this.project(params, middle);
        if (fits(candidate)) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (!best) {
        throw new Error(
          "Model tool-result budget cannot fit Code Mode status; use a larger model context.",
        );
      }
      projection = best;
    }
    const prior = this.delivered;
    const { channels, receipt } = projection;
    // Trial projections never acknowledge delivery. Charge the cumulative output
    // before suppressing earlier entries or an unchanged replacement summary.
    this.delivered = receipt;
    const output =
      receipt.kind === "entries"
        ? channels.output.slice(prior.kind === "entries" ? prior.count : 0)
        : prior.kind === "summary" &&
            prior.originalBytes === receipt.originalBytes &&
            prior.prefixBytes === receipt.prefixBytes
          ? []
          : channels.output;
    return { ...metadata, ...channels, output };
  }

  private project(
    params: TerminalChannels,
    maxBytes: number,
  ): { channels: DeliveredChannels; receipt: DeliveryReceipt } {
    const { count, source } = this.source;
    const outputBytes = count === 0 ? 0 : sourceBytes(source);
    const valueBytes = params.value === undefined ? 0 : sourceBytes(params.value);
    // Short channels donate their unused share; diagnostics retain their leading cause.
    const error =
      params.error === undefined
        ? undefined
        : boundCodeModeError(
            params.error,
            maxBytes - Math.min(outputBytes + valueBytes, Math.floor(maxBytes / 2)),
          );
    const remaining = maxBytes - (error === undefined ? 0 : jsonUtf8Bytes(error));
    const outputAllowance = remaining - Math.min(valueBytes, Math.floor(remaining / 2));
    let output: unknown[];
    let chargedOutputBytes: number;
    let receipt: DeliveryReceipt;
    if (outputBytes <= outputAllowance) {
      // A retained prefix has originalBytes > maxBytes and cannot fit this allowance.
      // SAFETY: Complete output sources encode normalized arrays, never guest metadata.
      const entries = JSON.parse(source.json) as unknown[];
      output = entries;
      chargedOutputBytes = outputBytes;
      receipt = { kind: "entries", count };
    } else {
      const marker = truncationMarker(source, outputAllowance - 2);
      const prefixBytes = Buffer.byteLength(marker.prefix, "utf8");
      output = [marker];
      chargedOutputBytes = jsonUtf8Bytes([marker]);
      receipt = { kind: "summary", originalBytes: outputBytes, prefixBytes };
    }
    return {
      receipt,
      channels: {
        output,
        ...(params.value === undefined
          ? {}
          : { value: projectValue(params.value, remaining - chargedOutputBytes) }),
        ...(error === undefined ? {} : { error }),
      },
    };
  }
}
