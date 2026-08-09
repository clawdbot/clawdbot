import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readNonNegativeInteger, readNumber, readString } from "./event-projector-values.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

function readTokenCount(record: JsonObject, key: string): number | undefined {
  const value = readNonNegativeInteger(record, key);
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function readCodexThreadTokenUsage(params: JsonObject): ReturnType<typeof normalizeUsage> {
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
  return last ? normalizeCodexThreadTokenUsage(last) : undefined;
}

function readCodexThreadContextSnapshot(params: JsonObject): {
  activeContextTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputTokens?: number;
  modelContextWindow?: number;
  outputTokens?: number;
  promptTokens?: number;
  reasoningOutputTokens?: number;
} {
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
  const modelContextWindow = tokenUsage
    ? readTokenCount(tokenUsage, "modelContextWindow")
    : undefined;
  // `last.totalTokens` is the provider-backed active-context base; `tokenUsage.total` is billing.
  const activeContextTokens = last ? readTokenCount(last, "totalTokens") : undefined;
  const inputTokens = last ? readTokenCount(last, "inputTokens") : undefined;
  const cachedInputTokens = last ? readTokenCount(last, "cachedInputTokens") : undefined;
  const cacheWriteInputTokens = last ? readTokenCount(last, "cacheWriteInputTokens") : undefined;
  const outputTokens = last ? readTokenCount(last, "outputTokens") : undefined;
  const reasoningOutputTokens = last ? readTokenCount(last, "reasoningOutputTokens") : undefined;
  return {
    ...(activeContextTokens !== undefined ? { activeContextTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(modelContextWindow && modelContextWindow > 0 ? { modelContextWindow } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

export function projectCodexThreadUsageUpdate(
  params: JsonObject,
  currentUsage: ReturnType<typeof normalizeUsage>,
  applyUsage: (usage: ReturnType<typeof normalizeUsage>) => void,
  emitContext: (context: ReturnType<typeof readCodexThreadContextSnapshot>) => void,
): void {
  applyUsage(readCodexThreadTokenUsage(params) ?? currentUsage);
  const context = readCodexThreadContextSnapshot(params);
  if (Object.keys(context).length > 0) {
    emitContext(context);
  }
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

export class CodexResponseCompletionProjection {
  // Replayed notifications keep one upstream response equal to one model iteration.
  private readonly responseIds = new Set<string>();
  usage: ReturnType<typeof normalizeUsage>;

  get modelIterations(): number {
    return this.responseIds.size;
  }

  clear(): void {
    this.usage = undefined;
  }

  record(params: JsonObject): void {
    const responseId = readString(params, "responseId");
    if (responseId) {
      this.responseIds.add(responseId);
    }
    const usage = isJsonObject(params.usage) ? params.usage : undefined;
    // Every provider completion replaces the prior response snapshot. A final
    // response with missing or malformed usage must leave freshness unknown.
    this.usage = usage ? normalizeCodexResponseTokenUsage(usage) : undefined;
  }
}
