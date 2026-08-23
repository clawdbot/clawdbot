import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asFiniteNumber,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { readNonNegativeInteger } from "./event-projector-values.js";
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
  return normalizeCodexTokenUsageBreakdown(record, "thread");
}

export function normalizeCodexResponseTokenUsage(
  record: JsonObject,
): ReturnType<typeof normalizeUsage> {
  return normalizeCodexTokenUsageBreakdown(record, "response");
}

function normalizeCodexTokenUsageBreakdown(
  record: JsonObject,
  source: "thread" | "response",
): ReturnType<typeof normalizeUsage> {
  // v2 TokenUsageBreakdown. inputTokens includes cached input; OpenClaw usage
  // tracks uncached input, cache reads, and cache writes separately.
  const readCount =
    source === "response"
      ? readTokenCount
      : (value: JsonObject, key: string) => asFiniteNumber(value[key]);
  const totalTokens = readCount(record, "totalTokens");
  const inputTokens = readCount(record, "inputTokens");
  const cacheRead = readCount(record, "cachedInputTokens");
  const output = readCount(record, "outputTokens");
  const reasoningTokens = readCount(record, "reasoningOutputTokens");
  const cacheWrite =
    record.cacheWriteInputTokens === undefined && source === "response"
      ? 0
      : readCount(record, "cacheWriteInputTokens");
  if (
    source === "response" &&
    (totalTokens === undefined ||
      inputTokens === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined ||
      output === undefined ||
      reasoningTokens === undefined ||
      cacheRead + cacheWrite > inputTokens ||
      totalTokens !== inputTokens + output)
  ) {
    return undefined;
  }

  const usage = normalizeUsage({
    input:
      inputTokens === undefined
        ? undefined
        : Math.max(0, inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    output,
    cacheRead,
    cacheWrite,
    reasoningTokens,
    total: totalTokens,
  });
  if (!usage) {
    return undefined;
  }

  // Only exact provider completions own fresh context; thread snapshots may be stale.
  return {
    ...usage,
    contextUsage:
      source === "response" && inputTokens !== undefined && totalTokens !== undefined
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
