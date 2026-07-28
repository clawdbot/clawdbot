/**
 * Canonical mapping for terminal OpenAI Responses events.
 *
 * `response.completed` and `response.incomplete` are both terminal and both carry usage, so every
 * Responses path — the package-side stream processor and the agent-side transport — finalizes
 * through the helpers here. Keeping one owner prevents the two from drifting on token buckets,
 * service-tier pricing, or future terminal-event semantics.
 */
import type OpenAI from "openai";
import type { StopReason, Usage } from "../types.js";

/** Terminal usage payload, modeled structurally so untyped callers can pass raw records. */
export type ResponsesTerminalUsagePayload = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  input_tokens_details?: {
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
  } | null;
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
};

function readCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Split a terminal usage payload into the priced buckets.
 *
 * OpenAI includes cache reads and writes in `input_tokens`, so both are subtracted out of the
 * billable input bucket. `total_tokens` comes from the payload, but never below the sum of the
 * split buckets: proxies routinely omit it (reporting 0 would understate the turn), and a payload
 * whose `cached_tokens` exceeds `input_tokens` clamps the input bucket, leaving the reported total
 * short of what the buckets actually price.
 */
export function mapResponsesTerminalUsage(
  usage: ResponsesTerminalUsagePayload | undefined | null,
): Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"> | undefined {
  if (!usage) {
    return undefined;
  }
  const cacheRead = readCount(usage.input_tokens_details?.cached_tokens);
  const cacheWrite = readCount(usage.input_tokens_details?.cache_write_tokens);
  const input = Math.max(0, readCount(usage.input_tokens) - cacheRead - cacheWrite);
  const output = readCount(usage.output_tokens);
  const bucketTotal = input + output + cacheRead + cacheWrite;
  const totalTokens = Math.max(bucketTotal, readCount(usage.total_tokens));
  return { input, output, cacheRead, cacheWrite, totalTokens };
}

/** Reasoning tokens are reported by the agent path only; the package path does not track them. */
export function readResponsesReasoningTokens(
  usage: ResponsesTerminalUsagePayload | undefined | null,
): number | undefined {
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens;
  return typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
    ? reasoningTokens
    : undefined;
}

function mapResponsesTerminalStopReason(
  status: OpenAI.Responses.ResponseStatus | undefined,
): StopReason {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    // These two are wonky ...
    case "in_progress":
    case "queued":
      return "stop";
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled stop reason: ${String(exhaustive)}`);
    }
  }
}

/**
 * Resolve the terminal stop reason, including the two overrides every Responses path shares: a
 * content-filtered turn is a provider error rather than a truncated answer, and a turn that
 * produced tool calls reports `toolUse` instead of a plain stop.
 */
export function resolveResponsesTerminalStopReason(params: {
  status: OpenAI.Responses.ResponseStatus | undefined;
  incompleteReason?: string;
  hasToolCall: boolean;
}): { stopReason: StopReason; errorMessage?: string } {
  if (params.status === "incomplete" && params.incompleteReason === "content_filter") {
    return { stopReason: "error", errorMessage: "Provider incomplete_reason: content_filter" };
  }
  const stopReason = mapResponsesTerminalStopReason(params.status);
  if (stopReason === "stop" && params.hasToolCall) {
    return { stopReason: "toolUse" };
  }
  return { stopReason };
}
