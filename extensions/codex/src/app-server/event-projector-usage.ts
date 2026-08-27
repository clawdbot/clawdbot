import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asSafeIntegerInRange,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type JsonObject } from "./protocol.js";

function readTokenCount(record: JsonObject, key: string): number | undefined {
  return asSafeIntegerInRange(record[key], { min: 0 });
}

function readCodexThreadTokenUsage(params: JsonObject): ReturnType<typeof normalizeUsage> {
  const tokenUsage = isJsonObject(params.tokenUsage) ? params.tokenUsage : undefined;
  const last = tokenUsage && isJsonObject(tokenUsage.last) ? tokenUsage.last : undefined;
  return last ? normalizeCodexThreadTokenUsage(last) : undefined;
}

export function readCodexThreadContextSnapshot(params: JsonObject): {
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
  return normalizeCodexTokenUsageBreakdown(record);
}

export function normalizeCodexResponseTokenUsage(
  record: JsonObject,
): ReturnType<typeof normalizeUsage> {
  return normalizeCodexTokenUsageBreakdown(record);
}

function normalizeCodexTokenUsageBreakdown(record: JsonObject): ReturnType<typeof normalizeUsage> {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input, cache reads, and cache writes separately.
  const totalTokens = readTokenCount(record, "totalTokens");
  const inputTokens = readTokenCount(record, "inputTokens");
  const cacheRead = readTokenCount(record, "cachedInputTokens");
  const output = readTokenCount(record, "outputTokens");
  const reasoningTokens = readTokenCount(record, "reasoningOutputTokens");
  const cacheWrite =
    record.cacheWriteInputTokens === undefined
      ? 0
      : readTokenCount(record, "cacheWriteInputTokens");
  const hasCoherentInput =
    inputTokens !== undefined &&
    cacheRead !== undefined &&
    cacheWrite !== undefined &&
    cacheRead + cacheWrite <= inputTokens;
  const hasCoherentContext =
    hasCoherentInput &&
    totalTokens !== undefined &&
    output !== undefined &&
    totalTokens === inputTokens + output;

  const usage = normalizeUsage({
    input: hasCoherentInput ? inputTokens - cacheRead - cacheWrite : undefined,
    output,
    cacheRead,
    cacheWrite,
    reasoningTokens,
    total: totalTokens,
  });
  if (!usage) {
    return undefined;
  }

  return {
    ...usage,
    contextUsage: hasCoherentContext
      ? { state: "available", promptTokens: inputTokens, totalTokens }
      : { state: "unavailable" },
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
