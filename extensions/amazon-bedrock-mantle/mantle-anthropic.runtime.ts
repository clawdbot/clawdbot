import Anthropic from "@anthropic-ai/sdk";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamAnthropic } from "@mariozechner/pi-ai/anthropic";

const MANTLE_ANTHROPIC_BETA = "fine-grained-tool-streaming-2025-05-14";
type AnthropicOptions = ConstructorParameters<typeof Anthropic>[0];

export function resolveMantleAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/anthropic")) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed.slice(0, -"/v1".length)}/anthropic`;
  }
  return `${trimmed}/anthropic`;
}

function requiresDefaultSampling(modelId: string): boolean {
  return modelId.includes("claude-opus-4-7");
}

function mergeHeaders(
  ...headerSources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return merged;
}

function buildMantleAnthropicBaseOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  apiKey: string,
) {
  return {
    temperature: requiresDefaultSampling(model.id) ? undefined : options?.temperature,
    maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32_000),
    signal: options?.signal,
    apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    onPayload: options?.onPayload,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
  };
}

function adjustMaxTokensForThinking(
  baseMaxTokens: number,
  modelMaxTokens: number,
  reasoningLevel: NonNullable<SimpleStreamOptions["reasoning"]>,
  customBudgets?: SimpleStreamOptions["thinkingBudgets"],
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 16384,
  } as const;
  const budgets = { ...defaultBudgets, ...customBudgets };
  const minOutputTokens = 1024;
  let thinkingBudget = budgets[reasoningLevel];
  const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }
  return { maxTokens, thinkingBudget };
}

export function createMantleAnthropicStreamFn(deps?: {
  createClient?: (options: AnthropicOptions) => Anthropic;
  stream?: typeof streamAnthropic;
}): StreamFn {
  return (model, context, options) => {
    const apiKey = options?.apiKey ?? "";
    const createClient = deps?.createClient ?? ((clientOptions) => new Anthropic(clientOptions));
    const stream = deps?.stream ?? streamAnthropic;
    const client = createClient({
      apiKey: null,
      authToken: apiKey,
      baseURL: resolveMantleAnthropicBaseUrl(model.baseUrl),
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": MANTLE_ANTHROPIC_BETA,
        },
        model.headers,
        options?.headers,
      ),
    });
    const base = buildMantleAnthropicBaseOptions(model, options, apiKey);
    if (!options?.reasoning || requiresDefaultSampling(model.id)) {
      return stream(model as Model<"anthropic-messages">, context, {
        ...base,
        client,
        thinkingEnabled: false,
      });
    }

    const adjusted = adjustMaxTokensForThinking(
      base.maxTokens || 0,
      model.maxTokens,
      options.reasoning,
      options.thinkingBudgets,
    );
    return stream(model as Model<"anthropic-messages">, context, {
      ...base,
      client,
      maxTokens: adjusted.maxTokens,
      thinkingEnabled: true,
      thinkingBudgetTokens: adjusted.thinkingBudget,
    });
  };
}
