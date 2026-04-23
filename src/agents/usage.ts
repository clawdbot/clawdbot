import { asFiniteNumber } from "../shared/number-coercion.js";

export type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  // Common alternates across providers/SDKs.
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Moonshot/Kimi uses cached_tokens for cache read count (explicit caching API).
  cached_tokens?: number;
  // OpenAI Responses reports cached prompt reuse here.
  input_tokens_details?: { cached_tokens?: number };
  // Kimi K2 uses prompt_tokens_details.cached_tokens for automatic prefix caching.
  prompt_tokens_details?: { cached_tokens?: number };
  // Some agents/logs emit alternate naming.
  totalTokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  // llama.cpp-style streamed completion metadata.
  prompt_n?: number;
  predicted_n?: number;
  timings?: {
    prompt_n?: number;
    predicted_n?: number;
  };
};

export type NormalizedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type AssistantUsageSnapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export function makeZeroUsageSnapshot(): AssistantUsageSnapshot {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function hasNonzeroUsage(usage?: NormalizedUsage | null): usage is NormalizedUsage {
  if (!usage) {
    return false;
  }
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
}

const normalizeTokenCount = (value: unknown): number | undefined => {
  const numeric = asFiniteNumber(value);
  if (numeric === undefined) {
    return undefined;
  }
  if (numeric <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(numeric), Number.MAX_SAFE_INTEGER);
};

export function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined {
  if (!raw) {
    return undefined;
  }

  const cacheRead = normalizeTokenCount(
    raw.cacheRead ??
      raw.cache_read ??
      raw.cache_read_input_tokens ??
      raw.cached_tokens ??
      raw.input_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens,
  );

  const rawInputValue =
    raw.input ??
    raw.inputTokens ??
    raw.input_tokens ??
    raw.promptTokens ??
    raw.prompt_tokens ??
    raw.prompt_n ??
    raw.timings?.prompt_n;

  const usesOpenAIStylePromptTotals =
    raw.cached_tokens !== undefined ||
    raw.input_tokens_details?.cached_tokens !== undefined ||
    raw.prompt_tokens_details?.cached_tokens !== undefined;

  // Some providers (pi-ai OpenAI-format) pre-subtract cached_tokens from
  // prompt/input totals upstream, while OpenAI-style prompt/input aliases
  // include cached tokens in the reported prompt total. Normalize both cases
  // to uncached input tokens so downstream prompt-token math does not double-
  // count cache reads.
  const rawInput = asFiniteNumber(rawInputValue);
  const normalizedInput =
    rawInput !== undefined && usesOpenAIStylePromptTotals && cacheRead !== undefined
      ? rawInput - cacheRead
      : rawInput;
  const input = normalizeTokenCount(normalizedInput);
  const output = normalizeTokenCount(
    raw.output ??
      raw.outputTokens ??
      raw.output_tokens ??
      raw.completionTokens ??
      raw.completion_tokens ??
      raw.predicted_n ??
      raw.timings?.predicted_n,
  );
  const cacheWrite = normalizeTokenCount(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );
  const total = normalizeTokenCount(raw.total ?? raw.totalTokens ?? raw.total_tokens);

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

/**
 * Maps normalized usage to OpenAI Chat Completions `usage` fields.
 *
 * `prompt_tokens` is input + cacheRead (cache write is excluded to match the
 * OpenAI-style breakdown used by the compat endpoint).
 *
 * `total_tokens` is the greater of the component sum and aggregate `total` when
 * present, so a partial breakdown cannot discard a valid upstream total.
 */
export function toOpenAiChatCompletionsUsage(usage: NormalizedUsage | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const promptTokens = Math.max(0, input + cacheRead);
  const completionTokens = Math.max(0, output);
  const componentTotal = promptTokens + completionTokens;
  const aggregateRaw = usage?.total;
  const aggregateTotal =
    typeof aggregateRaw === "number" && Number.isFinite(aggregateRaw)
      ? Math.max(0, aggregateRaw)
      : undefined;
  const totalTokens =
    aggregateTotal !== undefined ? Math.max(componentTotal, aggregateTotal) : componentTotal;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export function derivePromptTokens(usage?: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number | undefined {
  if (!usage) {
    return undefined;
  }
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const sum = input + cacheRead + cacheWrite;
  return sum > 0 ? sum : undefined;
}

export function deriveSessionTotalTokens(params: {
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextTokens?: number;
  promptTokens?: number;
}): number | undefined {
  const promptOverride = params.promptTokens;
  const hasPromptOverride =
    typeof promptOverride === "number" && Number.isFinite(promptOverride) && promptOverride > 0;

  const usage = params.usage;
  if (!usage && !hasPromptOverride) {
    return undefined;
  }

  // NOTE: SessionEntry.totalTokens is used as a prompt/context snapshot.
  // It intentionally excludes completion/output tokens.
  const promptTokens = hasPromptOverride
    ? promptOverride
    : derivePromptTokens({
        input: usage?.input,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      });

  if (!(typeof promptTokens === "number") || !Number.isFinite(promptTokens) || promptTokens <= 0) {
    return undefined;
  }

  // Keep this value unclamped; display layers are responsible for capping
  // percentages for terminal output.
  return promptTokens;
}
