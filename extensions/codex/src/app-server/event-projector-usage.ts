import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readNonNegativeInteger, readNumber } from "./event-projector-values.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

function readTokenCount(record: JsonObject, key: string): number | undefined {
  const value = readNonNegativeInteger(record, key);
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

export function readCodexThreadTokenUsage(params: JsonObject): ReturnType<typeof normalizeUsage> {
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
  return last ? normalizeCodexThreadTokenUsage(last) : undefined;
}

export function normalizeCodexThreadTokenUsage(
  record: JsonObject,
): ReturnType<typeof normalizeUsage> {
  // Thread usage preserves per-response accounting on older app servers, but
  // its `last` snapshot is not guaranteed to describe the final response.
  const inputTokens = readNumber(record, "inputTokens");
  const cacheRead = readNumber(record, "cachedInputTokens");
  const input =
    inputTokens !== undefined && cacheRead !== undefined
      ? Math.max(0, inputTokens - cacheRead)
      : inputTokens;
  const usage = normalizeUsage({
    input,
    output: readNumber(record, "outputTokens"),
    cacheRead,
    total: readNumber(record, "totalTokens"),
  });
  return usage ? { ...usage, contextUsage: { state: "unavailable" } } : undefined;
}

export function normalizeCodexResponseTokenUsage(
  record: JsonObject,
): ReturnType<typeof normalizeUsage> {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input and cache reads separately.
  const totalTokens = readTokenCount(record, "totalTokens");
  const inputTokens = readTokenCount(record, "inputTokens");
  const cacheRead = readTokenCount(record, "cachedInputTokens");
  const output = readTokenCount(record, "outputTokens");
  const reasoningOutput = readTokenCount(record, "reasoningOutputTokens");
  const rawCacheWrite = record.cacheWriteInputTokens;
  const cacheWrite =
    rawCacheWrite === undefined ? 0 : readTokenCount(record, "cacheWriteInputTokens");
  if (
    totalTokens === undefined ||
    inputTokens === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    output === undefined ||
    reasoningOutput === undefined ||
    cacheRead + cacheWrite > inputTokens ||
    totalTokens !== inputTokens + output
  ) {
    return undefined;
  }

  const usage = normalizeUsage({
    input: inputTokens - cacheRead - cacheWrite,
    output,
    cacheRead,
    cacheWrite,
    total: totalTokens,
  });
  if (!usage) {
    return undefined;
  }

  // `rawResponse/completed` is exact for one provider response. The projector
  // replaces this snapshot on every response so the final one owns freshness.
  return {
    ...usage,
    contextUsage: {
      state: "available",
      promptTokens: inputTokens,
      totalTokens,
    },
  };
}
