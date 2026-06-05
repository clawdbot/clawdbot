// Subagent formatting helpers expose compact durations and status text.
export { formatDurationCompact } from "../infra/format-time/format-duration.ts";

/** Formats token counts using compact k/m suffixes for subagent summaries. */
export function formatTokenShort(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const n = Math.floor(value);
  if (n < 1_000) {
    return `${n}`;
  }
  if (n < 10_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (n < 1_000_000) {
    const thousands = Math.round(n / 1_000);
    // Rounding can reach 1000 (e.g. 999_500 -> 1000); fall through to the
    // million branch instead of emitting an out-of-scheme "1000k".
    if (thousands < 1_000) {
      return `${thousands}k`;
    }
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** Truncates a single-line display string without preserving trailing whitespace. */
export function truncateLine(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trimEnd()}...`;
}

export type TokenUsageLike = {
  totalTokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
};

/** Resolves total token usage, falling back to input+output when no explicit total exists. */
export function resolveTotalTokens(entry?: TokenUsageLike) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  if (typeof entry.totalTokens === "number" && Number.isFinite(entry.totalTokens)) {
    return entry.totalTokens;
  }
  const input = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
  const output = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
  const total = input + output;
  return total > 0 ? total : undefined;
}

/** Resolves finite input/output token usage and the derived total. */
export function resolveIoTokens(entry?: TokenUsageLike) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const input =
    typeof entry.inputTokens === "number" && Number.isFinite(entry.inputTokens)
      ? entry.inputTokens
      : 0;
  const output =
    typeof entry.outputTokens === "number" && Number.isFinite(entry.outputTokens)
      ? entry.outputTokens
      : 0;
  const total = input + output;
  if (total <= 0) {
    return undefined;
  }
  return { input, output, total };
}

/** Formats token usage for compact subagent list/detail displays. */
export function formatTokenUsageDisplay(entry?: TokenUsageLike) {
  const io = resolveIoTokens(entry);
  const promptCache = resolveTotalTokens(entry);
  const parts: string[] = [];
  if (io) {
    const input = formatTokenShort(io.input) ?? "0";
    const output = formatTokenShort(io.output) ?? "0";
    parts.push(`tokens ${formatTokenShort(io.total)} (in ${input} / out ${output})`);
  } else if (typeof promptCache === "number" && promptCache > 0) {
    parts.push(`tokens ${formatTokenShort(promptCache)} prompt/cache`);
  }
  if (typeof promptCache === "number" && io && promptCache > io.total) {
    parts.push(`prompt/cache ${formatTokenShort(promptCache)}`);
  }
  return parts.join(", ");
}
