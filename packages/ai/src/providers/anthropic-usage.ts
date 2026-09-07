import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { Usage } from "../types.js";

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

type AnthropicBilledUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
};

export function readAnthropicUsageTokenCount(value: unknown): number | undefined {
  return asNonNegativeFiniteNumber(value);
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

function readAnthropicCompactionBilledUsage(iterations: unknown): AnthropicBilledUsage | undefined {
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return undefined;
  }
  let sawCompaction = false;
  const billed: AnthropicBilledUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
  };
  for (const iteration of iterations) {
    if (!iteration || typeof iteration !== "object" || Array.isArray(iteration)) {
      return undefined;
    }
    const record = iteration as AnthropicUsagePayload & { type?: unknown };
    const input = readAnthropicUsageTokenCount(record.input_tokens);
    const output = readAnthropicUsageTokenCount(record.output_tokens);
    const cacheRead = readAnthropicUsageTokenCount(record.cache_read_input_tokens);
    const cacheWrite = readAnthropicUsageTokenCount(record.cache_creation_input_tokens);
    if (
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined
    ) {
      return undefined;
    }
    sawCompaction ||= record.type === "compaction";
    billed.input += input;
    billed.output += output;
    billed.cacheRead += cacheRead;
    billed.cacheWrite += cacheWrite;
    billed.cacheWrite1h += readAnthropicCacheWriteUsage(record).cacheWrite1h ?? 0;
  }
  return sawCompaction ? billed : undefined;
}

/** Record independent billing buckets without treating zero placeholders as context proof. */
export function applyAnthropicMessageStartUsage(
  target: Usage,
  payload: AnthropicUsagePayload,
): AnthropicPromptUsageSnapshot | undefined {
  const promptUsage = readAnthropicPromptUsageSnapshot(payload);
  const promptTokens = promptUsage
    ? promptUsage.input + promptUsage.cacheRead + promptUsage.cacheWrite
    : 0;
  const inputTokens = readAnthropicUsageTokenCount(payload.input_tokens);
  if (inputTokens !== undefined) {
    target.input = inputTokens;
  }
  const outputTokens = readAnthropicUsageTokenCount(payload.output_tokens);
  if (outputTokens !== undefined) {
    target.output = outputTokens;
  }
  const cacheReadTokens =
    payload.cache_read_input_tokens == null
      ? 0
      : readAnthropicUsageTokenCount(payload.cache_read_input_tokens);
  if (cacheReadTokens !== undefined) {
    target.cacheRead = cacheReadTokens;
  }
  const cacheWriteTokens =
    payload.cache_creation_input_tokens == null
      ? 0
      : readAnthropicUsageTokenCount(payload.cache_creation_input_tokens);
  if (cacheWriteTokens !== undefined) {
    target.cacheWrite = cacheWriteTokens;
  }
  const { cacheWrite1h } = readAnthropicCacheWriteUsage(payload);
  if (cacheWrite1h !== undefined) {
    target.cacheWrite1h = cacheWrite1h;
  }
  target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
  if (promptTokens > 0 && outputTokens !== undefined) {
    target.contextUsage = {
      state: "available",
      promptTokens,
      totalTokens: promptTokens + target.output,
    };
  }
  return promptTokens > 0 ? promptUsage : undefined;
}

/** Keep billing and context distinct; omitted usage preserves the last snapshot. */
export function applyAnthropicMessageDeltaUsage(
  target: Usage,
  usage: AnthropicUsagePayload | undefined,
  messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined,
): void {
  if (!usage) {
    return;
  }
  const billedIterations = readAnthropicCompactionBilledUsage(usage.iterations);
  const inputTokens = readAnthropicUsageTokenCount(usage.input_tokens);
  const outputTokens = readAnthropicUsageTokenCount(usage.output_tokens);
  const cacheReadTokens = readAnthropicUsageTokenCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = readAnthropicUsageTokenCount(usage.cache_creation_input_tokens);
  const resolved: Partial<AnthropicBilledUsage> = billedIterations ?? {
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    cacheWrite1h: readAnthropicCacheWriteUsage(usage).cacheWrite1h,
  };
  if (resolved.input !== undefined) {
    target.input = resolved.input;
  }
  if (resolved.output !== undefined) {
    target.output = resolved.output;
  }
  // Match the SDK accumulator: absent or null cache counters preserve prior values.
  if (resolved.cacheRead !== undefined) {
    target.cacheRead = resolved.cacheRead;
  }
  if (resolved.cacheWrite !== undefined) {
    target.cacheWrite = resolved.cacheWrite;
  }
  if (resolved.cacheWrite1h !== undefined) {
    target.cacheWrite1h = resolved.cacheWrite1h;
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
    outputTokens !== undefined &&
    (messageStartPromptUsage !== undefined ||
      ((cacheReadTokens !== undefined || cacheWriteTokens !== undefined) &&
        readAnthropicPromptUsageSnapshot(usage) !== undefined))
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
