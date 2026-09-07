// Subagent formatting helpers expose compact durations and status text.
import { formatCompactTokenCount } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Formats token counts using compact k/m suffixes for subagent summaries. */
function formatTokenShort(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const n = Math.floor(value);
  return formatCompactTokenCount(n, {
    thousandsPrecision: n >= 10_000 ? 0 : 1,
    trimTrailingZero: true,
  });
}

/** Truncates a single-line display string without preserving trailing whitespace. */
export function truncateLine(value: string, maxLength: number) {
  const limit = Math.max(0, Math.floor(maxLength));
  const trimmed = value.trimEnd();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  const marker = "...";
  if (limit <= marker.length) {
    return marker.slice(0, limit);
  }
  return `${truncateUtf16Safe(trimmed, limit - marker.length).trimEnd()}${marker}`;
}

type TokenUsageLike = {
  totalTokens?: unknown;
  totalTokensFresh?: unknown;
  totalTokensVersion?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
};

/** Resolves total token usage, falling back to input+output when no explicit total exists. */
export function resolveTotalTokens(entry?: TokenUsageLike) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  if (
    typeof entry.totalTokens === "number" &&
    Number.isFinite(entry.totalTokens) &&
    entry.totalTokensFresh === true &&
    entry.totalTokensVersion === 1
  ) {
    return entry.totalTokens;
  }
  const input = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
  const output = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
  const total = input + output;
  return total > 0 ? total : undefined;
}

/** Resolves finite input/output token usage and the derived total. */
function resolveIoTokens(entry?: TokenUsageLike) {
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
