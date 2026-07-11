// Simple provider option helpers normalize lightweight provider configuration.
import type {
  Model,
  SimpleStreamOptions,
  StreamOptions,
  ThinkingBudgets,
  ThinkingLevel,
} from "../types.js";

type FirstEventStreamOptions = {
  firstEventTimeoutMs?: number;
  onFirstEventTimeout?: (reason: Error) => void;
};

export function buildBaseOptions(
  model: Model,
  options?: SimpleStreamOptions,
  apiKey?: string,
): StreamOptions & FirstEventStreamOptions {
  void model;
  const firstEventOptions = options as FirstEventStreamOptions | undefined;
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    stop: options?.stop,
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    transport: options?.transport,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    promptCacheKey: options?.promptCacheKey,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    timeoutMs: options?.timeoutMs,
    firstEventTimeoutMs: firstEventOptions?.firstEventTimeoutMs,
    onFirstEventTimeout: firstEventOptions?.onFirstEventTimeout,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
  };
}

export function clampReasoning(effort: ThinkingLevel): Exclude<ThinkingLevel, "xhigh">;
export function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh"> | undefined;
export function clampReasoning(
  effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh"> | undefined {
  return effort === "xhigh" ? "high" : effort;
}

export function adjustMaxTokensForThinking(
  // Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: Required<ThinkingBudgets> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    max: 32768,
  };
  const budgets = { ...defaultBudgets, ...customBudgets };

  const minOutputTokens = 1024;
  const level = clampReasoning(reasoningLevel);
  let thinkingBudget = budgets[level];
  const maxTokens =
    baseMaxTokens === undefined
      ? modelMaxTokens
      : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }

  return { maxTokens, thinkingBudget };
}
