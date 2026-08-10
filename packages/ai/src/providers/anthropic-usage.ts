import type { Usage } from "../types.js";
import {
  bindCachedInputObservation,
  cachedInputObservationFromRawUsage,
} from "../usage-observation.js";

type AnthropicUsagePayload = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: unknown;
  output_tokens_details?: {
    thinking_tokens?: unknown;
  } | null;
  iterations?: unknown;
};

const ANTHROPIC_USAGE_BUCKET_ORDER = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoningTokens",
  "total",
] as const;

function recordAnthropicObservedUsage(
  target: Usage,
  buckets: ReadonlyArray<(typeof ANTHROPIC_USAGE_BUCKET_ORDER)[number]>,
): void {
  const observed = new Set(target.tokenCountsObserved ?? []);
  for (const bucket of buckets) {
    observed.add(bucket);
  }
  if (
    (["input", "output", "cacheRead", "cacheWrite"] as const).every((bucket) =>
      observed.has(bucket),
    )
  ) {
    observed.add("total");
  }
  if (observed.size === 0) {
    return;
  }
  delete target.tokenCountsOrigin;
  target.tokenCountsObserved = ANTHROPIC_USAGE_BUCKET_ORDER.filter((bucket) =>
    observed.has(bucket),
  );
}

function revokeAnthropicObservedUsage(
  target: Usage,
  buckets: ReadonlyArray<(typeof ANTHROPIC_USAGE_BUCKET_ORDER)[number]>,
): void {
  if (!target.tokenCountsObserved) {
    return;
  }
  const revoked = new Set(buckets);
  if (buckets.some((bucket) => bucket !== "reasoningTokens")) {
    revoked.add("total");
  }
  const observed = target.tokenCountsObserved.filter((bucket) => !revoked.has(bucket));
  if (observed.length > 0) {
    target.tokenCountsObserved = observed;
  } else {
    target.tokenCountsObserved = [];
  }
}

export type AnthropicCacheWriteUsage = {
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

export type AnthropicPromptUsageSnapshot = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
};

export type AnthropicIterationUsageSnapshot = {
  contextPromptTokens: number;
  totalTokens: number;
};

export type AnthropicIterationUsageResult =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "valid"; usage: AnthropicIterationUsageSnapshot };

export function readAnthropicUsageTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function readAnthropicCacheWriteUsage(
  usage: AnthropicUsagePayload,
): AnthropicCacheWriteUsage {
  if (!usage.cache_creation || typeof usage.cache_creation !== "object") {
    return {};
  }
  const cacheCreation = usage.cache_creation as Record<string, unknown>;
  const cacheWrite5m = readAnthropicUsageTokenCount(cacheCreation.ephemeral_5m_input_tokens);
  const cacheWrite1h = readAnthropicUsageTokenCount(cacheCreation.ephemeral_1h_input_tokens);
  return {
    ...(cacheWrite5m !== undefined ? { cacheWrite5m } : {}),
    ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
  };
}

export function readAnthropicPromptUsageSnapshot(
  usage: AnthropicUsagePayload,
): AnthropicPromptUsageSnapshot | undefined {
  const input = readAnthropicUsageTokenCount(usage.input_tokens);
  const cacheRead = readAnthropicUsageTokenCount(usage.cache_read_input_tokens);
  const cacheWrite = readAnthropicUsageTokenCount(usage.cache_creation_input_tokens);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, cacheRead, cacheWrite };
}

export function readLastAnthropicIterationUsage(
  usage: AnthropicUsagePayload,
): AnthropicIterationUsageResult {
  if (usage.iterations == null) {
    return { state: "absent" };
  }
  if (!Array.isArray(usage.iterations) || usage.iterations.length === 0) {
    return { state: "invalid" };
  }
  // Anthropic documents the final iteration as the true context window.
  // Top-level cache fields remain cumulative billing totals across iterations.
  const iteration = usage.iterations.at(-1);
  if (!iteration || typeof iteration !== "object" || Array.isArray(iteration)) {
    return { state: "invalid" };
  }
  const record = iteration as AnthropicUsagePayload;
  const input = readAnthropicUsageTokenCount(record.input_tokens);
  const cacheRead = readAnthropicUsageTokenCount(record.cache_read_input_tokens);
  const cacheWrite = readAnthropicUsageTokenCount(record.cache_creation_input_tokens);
  const outputTokens = readAnthropicUsageTokenCount(record.output_tokens);
  if (
    input === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    outputTokens === undefined
  ) {
    return { state: "invalid" };
  }
  const contextPromptTokens = input + cacheRead + cacheWrite;
  return {
    state: "valid",
    usage: {
      contextPromptTokens,
      totalTokens: contextPromptTokens + outputTokens,
    },
  };
}

/** Seed prompt billing facts without treating provisional output as terminal authority. */
export function applyAnthropicMessageStartUsage(
  target: Usage,
  payload: AnthropicUsagePayload,
): AnthropicPromptUsageSnapshot | undefined {
  bindCachedInputObservation(target, cachedInputObservationFromRawUsage(payload));
  const promptUsage = readAnthropicPromptUsageSnapshot(payload);
  const inputTokens = readAnthropicUsageTokenCount(payload.input_tokens);
  const outputTokens = readAnthropicUsageTokenCount(payload.output_tokens);
  const cacheReadTokens = readAnthropicUsageTokenCount(payload.cache_read_input_tokens);
  const cacheWriteTokens = readAnthropicUsageTokenCount(payload.cache_creation_input_tokens);
  recordAnthropicObservedUsage(target, [
    ...(inputTokens !== undefined ? (["input"] as const) : []),
    ...(cacheReadTokens !== undefined ? (["cacheRead"] as const) : []),
    ...(cacheWriteTokens !== undefined ? (["cacheWrite"] as const) : []),
  ]);
  if (inputTokens !== undefined) {
    target.input = inputTokens;
  }
  if (outputTokens !== undefined) {
    target.output = outputTokens;
  }
  if (cacheReadTokens !== undefined) {
    target.cacheRead = cacheReadTokens;
  }
  if (cacheWriteTokens !== undefined) {
    target.cacheWrite = cacheWriteTokens;
  }
  const { cacheWrite1h } = readAnthropicCacheWriteUsage(payload);
  if (cacheWrite1h !== undefined) {
    target.cacheWrite1h = cacheWrite1h;
  }
  target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
  return promptUsage;
}

/** Keep cumulative billing separate from the final server-side iteration context. */
export function applyAnthropicMessageDeltaUsage(
  target: Usage,
  payload: AnthropicUsagePayload | undefined,
  messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined,
): void {
  const usage = payload ?? {};
  if (Object.hasOwn(usage, "cache_read_input_tokens")) {
    bindCachedInputObservation(target, cachedInputObservationFromRawUsage(usage));
  }
  const inputTokens = readAnthropicUsageTokenCount(usage.input_tokens);
  const outputTokens = readAnthropicUsageTokenCount(usage.output_tokens);
  const cacheReadTokens = readAnthropicUsageTokenCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = readAnthropicUsageTokenCount(usage.cache_creation_input_tokens);
  const reasoningTokens = readAnthropicUsageTokenCount(
    usage.output_tokens_details?.thinking_tokens,
  );
  const observed: NonNullable<Usage["tokenCountsObserved"]> = [];
  let coreUsageConflict = false;
  if (inputTokens !== undefined) {
    if (inputTokens < target.input) {
      revokeAnthropicObservedUsage(target, ["input"]);
      coreUsageConflict = true;
    } else {
      target.input = inputTokens;
      observed.push("input");
    }
  }
  if (outputTokens !== undefined) {
    if (outputTokens < target.output) {
      revokeAnthropicObservedUsage(target, ["output"]);
      coreUsageConflict = true;
    } else {
      target.output = outputTokens;
      observed.push("output");
    }
  }
  // Match the SDK accumulator: absent or null cache counters preserve prior values.
  if (cacheReadTokens !== undefined) {
    if (cacheReadTokens < target.cacheRead) {
      revokeAnthropicObservedUsage(target, ["cacheRead"]);
      coreUsageConflict = true;
    } else {
      target.cacheRead = cacheReadTokens;
      observed.push("cacheRead");
    }
  }
  if (cacheWriteTokens !== undefined) {
    if (cacheWriteTokens < target.cacheWrite) {
      revokeAnthropicObservedUsage(target, ["cacheWrite"]);
      coreUsageConflict = true;
    } else {
      target.cacheWrite = cacheWriteTokens;
      observed.push("cacheWrite");
    }
  }
  if (reasoningTokens !== undefined) {
    const priorReasoningTokens = target.reasoningTokens;
    const outputAuthoritative =
      observed.includes("output") || target.tokenCountsObserved?.includes("output") === true;
    if (
      !outputAuthoritative ||
      reasoningTokens > target.output ||
      (priorReasoningTokens !== undefined && reasoningTokens < priorReasoningTokens)
    ) {
      revokeAnthropicObservedUsage(target, ["reasoningTokens"]);
    } else {
      target.reasoningTokens = reasoningTokens;
      observed.push("reasoningTokens");
    }
  }
  recordAnthropicObservedUsage(target, observed);
  const { cacheWrite1h } = readAnthropicCacheWriteUsage(usage);
  if (cacheWrite1h !== undefined) {
    target.cacheWrite1h = cacheWrite1h;
  }
  target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
  const iterationUsage = readLastAnthropicIterationUsage(usage);
  if (iterationUsage.state === "valid") {
    target.contextUsage = {
      state: "available",
      promptTokens: iterationUsage.usage.contextPromptTokens,
      totalTokens: iterationUsage.usage.totalTokens,
    };
  } else if (iterationUsage.state === "invalid") {
    target.contextUsage = { state: "unavailable" };
  } else if (
    !coreUsageConflict &&
    outputTokens !== undefined &&
    observed.includes("output") &&
    (messageStartPromptUsage !== undefined ||
      (inputTokens !== undefined &&
        cacheReadTokens !== undefined &&
        cacheWriteTokens !== undefined))
  ) {
    const promptTokens = target.input + target.cacheRead + target.cacheWrite;
    target.contextUsage = {
      state: "available",
      promptTokens,
      totalTokens: promptTokens + target.output,
    };
  } else {
    target.contextUsage = { state: "unavailable" };
  }
}
