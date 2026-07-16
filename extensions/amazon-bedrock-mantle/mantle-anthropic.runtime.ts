/**
 * Anthropic Messages stream adapter for Bedrock Mantle. It rewrites Mantle
 * endpoints to Anthropic-compatible URLs and adjusts thinking-token budgets.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  stream,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "openclaw/plugin-sdk/llm";
import {
  requiresClaudeDefaultSampling,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildGuardedModelFetch } from "openclaw/plugin-sdk/provider-transport-runtime";

const MANTLE_ANTHROPIC_BETA = "fine-grained-tool-streaming-2025-05-14";
type AnthropicOptions = ConstructorParameters<typeof Anthropic>[0];
type MantleAnthropicStream = typeof stream;

/** Resolve the Anthropic-compatible Mantle base URL from a provider base URL. */
function resolveMantleAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/anthropic")) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed.slice(0, -"/v1".length)}/anthropic`;
  }
  return `${trimmed}/anthropic`;
}

function isClaudeSonnet5Model(model: Model): boolean {
  return resolveClaudeSonnet5ModelIdentity(model) !== undefined;
}

function requiresDefaultSampling(model: Model): boolean {
  return requiresClaudeDefaultSampling(model);
}

function isClaudeMythosPreviewModel(model: Model): boolean {
  return [model.id, model.name, model.params?.canonicalModelId]
    .filter((value): value is string => typeof value === "string")
    .some((value) =>
      /(?:^|-)claude-mythos-preview(?=$|[^a-z0-9])/.test(
        value
          .trim()
          .toLowerCase()
          .replace(/[\s_.:]+/g, "-"),
      ),
    );
}

function isClaudeMythos5Model(model: Model): boolean {
  return resolveClaudeMythos5ModelIdentity(model) !== undefined;
}

function requiresClaudeMythosAdaptiveThinking(model: Model): boolean {
  return isClaudeMythos5Model(model) || isClaudeMythosPreviewModel(model);
}

function resolveMantleReasoning(
  model: Model,
  options: SimpleStreamOptions | undefined,
): NonNullable<SimpleStreamOptions["reasoning"]> | undefined {
  if (model.id.includes("claude-opus-4-7")) {
    return undefined;
  }
  const sonnet5 = isClaudeSonnet5Model(model);
  const mythosPreview = isClaudeMythosPreviewModel(model);
  const mandatoryMythos = isClaudeMythos5Model(model) || mythosPreview;
  const reasoning = options?.reasoning ?? (mandatoryMythos || sonnet5 ? "high" : undefined);
  if (sonnet5) {
    return reasoning === "off" || reasoning === "minimal" ? "low" : reasoning;
  }
  if (!mandatoryMythos) {
    return reasoning;
  }
  if (reasoning === "off" || reasoning === "minimal") {
    return "low";
  }
  return mythosPreview && (reasoning === "xhigh" || reasoning === "max") ? "high" : reasoning;
}

function mapSonnet5Effort(
  reasoning: NonNullable<SimpleStreamOptions["reasoning"]>,
): "low" | "medium" | "high" | "xhigh" | "max" {
  if (reasoning === "minimal" || reasoning === "low") {
    return "low";
  }
  if (reasoning === "medium" || reasoning === "xhigh" || reasoning === "max") {
    return reasoning;
  }
  return "high";
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
  model: Model,
  options: SimpleStreamOptions | undefined,
  apiKey: string,
) {
  return {
    ...(requiresDefaultSampling(model) ? {} : { temperature: options?.temperature }),
    maxTokens:
      options?.maxTokens ||
      (isClaudeSonnet5Model(model) || isClaudeMythos5Model(model)
        ? model.maxTokens
        : Math.min(model.maxTokens, 32_000)),
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
  reasoningLevel: ThinkingLevel,
  customBudgets?: SimpleStreamOptions["thinkingBudgets"],
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 16384,
    max: 16384,
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

/** Create the Mantle Anthropic Messages stream function. */
export function createMantleAnthropicStreamFn(deps?: {
  createClient?: (options: AnthropicOptions) => Anthropic;
  stream?: MantleAnthropicStream;
}): StreamFn {
  return (model, context, options) => {
    const apiKey = options?.apiKey ?? "";
    const createClient = deps?.createClient ?? ((clientOptions) => new Anthropic(clientOptions));
    const streamFn = deps?.stream ?? stream;
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
      fetch: buildGuardedModelFetch(model),
    });
    const base = buildMantleAnthropicBaseOptions(model, options, apiKey);
    // Plugin package deps can give this plugin a distinct physical SDK copy.
    // The client API is the same, but the SDK class private field makes types nominal.
    const streamClient = client as unknown as Anthropic;
    const reasoning = resolveMantleReasoning(model, options);
    const sonnet5 = isClaudeSonnet5Model(model);
    const mythos5 = isClaudeMythos5Model(model);
    if (!reasoning || reasoning === "off") {
      return streamFn(model as Model<"anthropic-messages">, context, {
        ...base,
        client: streamClient,
        thinkingEnabled: false,
      });
    }

    if (sonnet5 || mythos5) {
      return streamFn(model as Model<"anthropic-messages">, context, {
        ...base,
        client: streamClient,
        thinkingEnabled: true,
        effort: sonnet5 ? mapSonnet5Effort(reasoning) : reasoning,
      });
    }

    const adjusted = adjustMaxTokensForThinking(
      base.maxTokens || 0,
      model.maxTokens,
      reasoning,
      options?.thinkingBudgets,
    );
    const adaptiveThinking = requiresClaudeMythosAdaptiveThinking(model);
    const thinkingEnabled = adaptiveThinking || adjusted.thinkingBudget >= 1024;
    return streamFn(model as Model<"anthropic-messages">, context, {
      ...base,
      client: streamClient,
      maxTokens: adjusted.maxTokens,
      thinkingEnabled,
      ...(adaptiveThinking
        ? { effort: reasoning }
        : thinkingEnabled
          ? { thinkingBudgetTokens: adjusted.thinkingBudget }
          : {}),
    });
  };
}
