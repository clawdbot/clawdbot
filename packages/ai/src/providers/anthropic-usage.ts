type AnthropicUsagePayload = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: unknown;
  iterations?: unknown;
};

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
  const cacheRead =
    usage.cache_read_input_tokens == null
      ? 0
      : readAnthropicUsageTokenCount(usage.cache_read_input_tokens);
  const cacheWrite =
    usage.cache_creation_input_tokens == null
      ? 0
      : readAnthropicUsageTokenCount(usage.cache_creation_input_tokens);
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
