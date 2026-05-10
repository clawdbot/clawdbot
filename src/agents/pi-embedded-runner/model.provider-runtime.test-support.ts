import { lowercasePreservingWhitespace } from "../../shared/string-coerce.js";
import type { OpenRouterModelCapabilities } from "./openrouter-model-capabilities.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_LEGACY_BASE_URL = "https://chatgpt.com/backend-api/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_LEGACY_BASE_URL = "https://openrouter.ai/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const XAI_BASE_URL = "https://api.x.ai/v1";
const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
const GOOGLE_GENERATIVE_AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_GEMINI_CLI_BASE_URL = "https://cloudcode-pa.googleapis.com";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_FALLBACK_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type ModelRegistryLike = {
  find: (provider: string, modelId: string) => unknown;
};

type DynamicModelContext = {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistryLike;
};

type ResolvedModelLike = Record<string, unknown>;
type NormalizedTransportLike = {
  api?: string | null;
  baseUrl?: string;
};

type ProviderRuntimeTestMockOptions = {
  getOpenRouterModelCapabilities?: (modelId: string) => OpenRouterModelCapabilities | undefined;
  handledDynamicProviders?: readonly string[];
  loadOpenRouterModelCapabilities?: (modelId: string) => Promise<void>;
};

function findTemplate(
  ctx: { modelRegistry: ModelRegistryLike },
  provider: string,
  templateIds: readonly string[],
) {
  for (const templateId of templateIds) {
    const template = ctx.modelRegistry.find(provider, templateId) as ResolvedModelLike | null;
    if (template) {
      return template;
    }
  }
  return undefined;
}

function cloneTemplate(
  template: ResolvedModelLike | undefined,
  modelId: string,
  patch: ResolvedModelLike,
  fallback: ResolvedModelLike,
) {
  return {
    ...(template ?? fallback),
    id: modelId,
    name: modelId,
    ...patch,
  } as ResolvedModelLike;
}

function isNativeOpenAICodexBaseUrl(baseUrl?: string): boolean {
  return baseUrl === OPENAI_CODEX_BASE_URL || baseUrl === OPENAI_CODEX_LEGACY_BASE_URL;
}

function normalizeOpenRouterBaseUrl(baseUrl?: string): string | undefined {
  const normalized = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENROUTER_BASE_URL || normalized === OPENROUTER_LEGACY_BASE_URL) {
    return OPENROUTER_BASE_URL;
  }
  return undefined;
}

function normalizeDynamicModel(params: { provider: string; model: ResolvedModelLike }) {
  if (params.provider === "openrouter") {
    const baseUrl =
      typeof params.model.baseUrl === "string"
        ? normalizeOpenRouterBaseUrl(params.model.baseUrl)
        : undefined;
    if (baseUrl && baseUrl !== params.model.baseUrl) {
      return { ...params.model, baseUrl };
    }
    return undefined;
  }
  if (params.provider !== "openai-codex") {
    return undefined;
  }
  const baseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
  const useCodexTransport =
    !baseUrl || baseUrl === OPENAI_BASE_URL || isNativeOpenAICodexBaseUrl(baseUrl);
  const nextApi =
    useCodexTransport && (!params.model.api || params.model.api === "openai-responses")
      ? "openai-codex-responses"
      : params.model.api;
  const nextBaseUrl =
    nextApi === "openai-codex-responses" && useCodexTransport ? OPENAI_CODEX_BASE_URL : baseUrl;
  if (nextApi !== params.model.api || nextBaseUrl !== baseUrl) {
    return { ...params.model, api: nextApi, baseUrl: nextBaseUrl };
  }
  return undefined;
}

function normalizeTransport(params: {
  provider: string;
  context: { api?: string | null; baseUrl?: string };
}): NormalizedTransportLike | undefined {
  const isNativeOpenAiTransport =
    params.context.api === "openai-completions" &&
    (params.context.baseUrl === OPENAI_BASE_URL ||
      (params.provider === "openai" && !params.context.baseUrl));
  const isNativeXaiTransport =
    params.context.api === "openai-completions" &&
    (params.context.baseUrl === XAI_BASE_URL ||
      (params.provider === "xai" && !params.context.baseUrl));
  const isNativeOpenAICodexTransport =
    params.provider === "openai-codex" &&
    ((!params.context.api &&
      (!params.context.baseUrl || isNativeOpenAICodexBaseUrl(params.context.baseUrl))) ||
      (params.context.api === "openai-responses" &&
        (!params.context.baseUrl ||
          params.context.baseUrl === OPENAI_BASE_URL ||
          isNativeOpenAICodexBaseUrl(params.context.baseUrl))));
  if (
    params.context.api === "google-generative-ai" &&
    params.context.baseUrl === "https://generativelanguage.googleapis.com"
  ) {
    return {
      api: params.context.api,
      baseUrl: GOOGLE_GENERATIVE_AI_BASE_URL,
    };
  }
  if (isNativeOpenAiTransport) {
    return {
      api: "openai-responses",
      baseUrl: params.context.baseUrl,
    };
  }
  if (isNativeXaiTransport) {
    return {
      api: "openai-responses",
      baseUrl: params.context.baseUrl,
    };
  }
  if (isNativeOpenAICodexTransport) {
    return {
      api: "openai-codex-responses",
      baseUrl: OPENAI_CODEX_BASE_URL,
    };
  }
  const normalizedOpenRouterBaseUrl = normalizeOpenRouterBaseUrl(params.context.baseUrl);
  if (normalizedOpenRouterBaseUrl && normalizedOpenRouterBaseUrl !== params.context.baseUrl) {
    return {
      api: params.context.api,
      baseUrl: normalizedOpenRouterBaseUrl,
    };
  }
  return undefined;
}

function buildDynamicModel(
  params: DynamicModelContext,
  options: Required<
    Pick<
      ProviderRuntimeTestMockOptions,
      "getOpenRouterModelCapabilities" | "loadOpenRouterModelCapabilities"
    >
  >,
) {
  const modelId = params.modelId.trim();
  const lower = lowercasePreservingWhitespace(modelId);
  switch (params.provider) {
    case "openrouter": {
      const capabilities = options.getOpenRouterModelCapabilities(modelId);
      return {
        id: modelId,
        name: capabilities?.name ?? modelId,
        api: "openai-completions" as const,
        provider: "openrouter",
        baseUrl: OPENROUTER_BASE_URL,
        reasoning: capabilities?.reasoning ?? false,
        input: capabilities?.input ?? (["text"] as const),
        ...(capabilities?.supportsTools !== undefined
          ? { compat: { supportsTools: capabilities.supportsTools } }
          : {}),
        cost: capabilities?.cost ?? OPENROUTER_FALLBACK_COST,
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: capabilities?.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
    }
    case "github-copilot": {
      const existing = params.modelRegistry.find("github-copilot", lower);
      if (existing) {
        return undefined;
      }
      const template = findTemplate(params, "github-copilot", ["gpt-5.4"]);
      if (lower === "gpt-5.4" && template) {
        return cloneTemplate(
          template,
          modelId,
          {},
          {
            provider: "github-copilot",
            api: "openai-responses",
            reasoning: false,
            input: ["text", "image"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: 128_000,
            maxTokens: DEFAULT_MAX_TOKENS,
          },
        );
      }
      return {
        id: modelId,
        name: modelId,
        provider: "github-copilot",
        api: lower.includes("claude") ? "anthropic-messages" : "openai-responses",
        reasoning: /^o[13](\b|$)/.test(lower),
        input: ["text", "image"],
        cost: OPENROUTER_FALLBACK_COST,
        contextWindow: 128_000,
        maxTokens: DEFAULT_MAX_TOKENS,
      };
    }
    case "openai-codex": {
      const isLegacyGpt54Alias = lower === "gpt-5.4-codex";
      if (lower === "gpt-5.5") {
        const model = params.modelRegistry.find(
          "openai-codex",
          modelId,
        ) as ResolvedModelLike | null;
        if (model) {
          const modelContextTokens = model.contextTokens;
          const modelContextWindow = model.contextWindow;
          const contextTokens =
            typeof modelContextTokens === "number"
              ? modelContextTokens
              : Math.min(
                  272_000,
                  typeof modelContextWindow === "number" ? modelContextWindow : 272_000,
                );
          return { ...model, contextWindow: 400_000, contextTokens };
        }
        return cloneTemplate(
          undefined,
          modelId,
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            reasoning: true,
            input: ["text", "image"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: 400_000,
            contextTokens: 272_000,
            maxTokens: 128_000,
          },
          {},
        );
      }
      const template =
        lower === "gpt-5.5-pro"
          ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.4-pro", "gpt-5.3-codex"])
          : lower === "gpt-5.4" ||
              isLegacyGpt54Alias ||
              lower === "gpt-5.4-pro" ||
              lower === "gpt-5.4-mini"
            ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"])
            : lower === "gpt-5.3-codex-spark"
              ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"])
              : findTemplate(params, "openai-codex", ["gpt-5.4"]);
      const fallback = {
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: OPENAI_CODEX_BASE_URL,
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_FALLBACK_COST,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_CONTEXT_WINDOW,
      };
      if (lower === "gpt-5.5-pro") {
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            contextTokens: 272_000,
            maxTokens: 128_000,
          },
          fallback,
        );
      }
      if (lower === "gpt-5.4" || isLegacyGpt54Alias) {
        return cloneTemplate(
          template,
          "gpt-5.4",
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
            contextWindow: 1_050_000,
            contextTokens: 272_000,
            maxTokens: 128_000,
          },
          fallback,
        );
      }
      if (lower === "gpt-5.4-pro") {
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_050_000,
            contextTokens: 272_000,
            maxTokens: 128_000,
          },
          fallback,
        );
      }
      if (lower === "gpt-5.4-mini") {
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
            contextWindow: 400_000,
            contextTokens: 272_000,
            maxTokens: 128_000,
          },
          fallback,
        );
      }
      if (lower === "gpt-5.3-codex-spark") {
        return cloneTemplate(
          template,
          modelId,
          {
            provider: "openai-codex",
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            reasoning: true,
            input: ["text"],
            cost: OPENROUTER_FALLBACK_COST,
            contextWindow: 128_000,
            maxTokens: 128_000,
          },
          fallback,
        );
      }
      return undefined;
    }
    case "openai": {
      const templateIds =
        lower === "gpt-5.4"
          ? ["gpt-5.4"]
          : lower === "gpt-5.4-pro"
            ? ["gpt-5.4-pro", "gpt-5.4"]
            : lower === "gpt-5.4-mini"
              ? ["gpt-5.4-mini"]
              : lower === "gpt-5.4-nano"
                ? ["gpt-5.4-nano", "gpt-5.4-mini"]
                : undefined;
      if (!templateIds) {
        return undefined;
      }
      const template = findTemplate(params, "openai", templateIds);
      const patch =
        lower === "gpt-5.4"
          ? {
              provider: "openai",
              api: "openai-responses",
              baseUrl: OPENAI_BASE_URL,
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            }
          : lower === "gpt-5.4-pro"
            ? {
                provider: "openai",
                api: "openai-responses",
                baseUrl: OPENAI_BASE_URL,
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : lower === "gpt-5.4-mini"
              ? {
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: OPENAI_BASE_URL,
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
                  contextWindow: 400_000,
                  maxTokens: 128_000,
                }
              : {
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: OPENAI_BASE_URL,
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
                  contextWindow: 400_000,
                  maxTokens: 128_000,
                };
      return cloneTemplate(template, modelId, patch, {
        provider: "openai",
        api: "openai-responses",
        baseUrl: OPENAI_BASE_URL,
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_FALLBACK_COST,
        contextWindow: patch.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: patch.maxTokens ?? DEFAULT_CONTEXT_WINDOW,
      });
    }
    case "anthropic":
    case "claude-cli": {
      if (lower !== "claude-opus-4-6" && lower !== "claude-sonnet-4-6") {
        return undefined;
      }
      const template = findTemplate(
        params,
        "anthropic",
        lower === "claude-opus-4-6" ? ["claude-opus-4-6"] : ["claude-sonnet-4-6"],
      );
      return cloneTemplate(
        template,
        modelId,
        {
          provider: params.provider,
          api: "anthropic-messages",
          baseUrl: ANTHROPIC_BASE_URL,
          reasoning: true,
        },
        {
          provider: params.provider,
          api: "anthropic-messages",
          baseUrl: ANTHROPIC_BASE_URL,
          reasoning: true,
          input: ["text", "image"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_CONTEXT_WINDOW,
        },
      );
    }
    case "google-antigravity": {
      if (lower !== "claude-opus-4-6-thinking") {
        return undefined;
      }
      return cloneTemplate(
        undefined,
        modelId,
        {
          provider: "google-antigravity",
          api: "google-gemini-cli",
          baseUrl: GOOGLE_GEMINI_CLI_BASE_URL,
          reasoning: true,
          input: ["text", "image"],
        },
        {
          provider: "google-antigravity",
          api: "google-gemini-cli",
          baseUrl: GOOGLE_GEMINI_CLI_BASE_URL,
          reasoning: true,
          input: ["text", "image"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_MAX_TOKENS,
        },
      );
    }
    case "zai": {
      if (lower !== "glm-5") {
        return undefined;
      }
      const template = findTemplate(params, "zai", ["glm-4.7"]);
      return cloneTemplate(
        template,
        modelId,
        {
          provider: "zai",
          api: "openai-completions",
          baseUrl: ZAI_BASE_URL,
          reasoning: true,
        },
        {
          provider: "zai",
          api: "openai-completions",
          baseUrl: ZAI_BASE_URL,
          reasoning: true,
          input: ["text"],
          cost: OPENROUTER_FALLBACK_COST,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_CONTEXT_WINDOW,
        },
      );
    }
    default:
      return undefined;
  }
}

export function createProviderRuntimeTestMock(options: ProviderRuntimeTestMockOptions = {}) {
  const handledDynamicProviders = new Set(
    options.handledDynamicProviders ?? [
      "openrouter",
      "github-copilot",
      "openai-codex",
      "openai",
      "xai",
      "anthropic",
      "google-antigravity",
      "zai",
    ],
  );
  const getOpenRouterModelCapabilities =
    options.getOpenRouterModelCapabilities ?? (() => undefined);
  const loadOpenRouterModelCapabilities =
    options.loadOpenRouterModelCapabilities ?? (async () => {});

  return {
    buildProviderUnknownModelHintWithPlugin: (params: { provider: string }) => {
      switch (params.provider) {
        case "ollama":
          return (
            "Ollama requires authentication to be registered as a provider. " +
            'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
            "See: https://docs.openclaw.ai/providers/ollama"
          );
        case "vllm":
          return (
            "vLLM requires authentication to be registered as a provider. " +
            'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
            "See: https://docs.openclaw.ai/providers/vllm"
          );
        default:
          return undefined;
      }
    },
    resolveProviderRuntimePlugin: ({ provider }: { provider: string }) =>
      handledDynamicProviders.has(provider)
        ? {
            id: provider,
            prepareDynamicModel:
              provider === "openrouter"
                ? async ({ modelId }: { modelId: string }) => {
                    await loadOpenRouterModelCapabilities(modelId);
                  }
                : undefined,
            resolveDynamicModel: (ctx: DynamicModelContext) =>
              buildDynamicModel(ctx, {
                getOpenRouterModelCapabilities,
                loadOpenRouterModelCapabilities,
              }),
            normalizeResolvedModel: (ctx: { provider: string; model: ResolvedModelLike }) =>
              normalizeDynamicModel(ctx),
          }
        : undefined,
    runProviderDynamicModel: (params: {
      provider: string;
      context: { modelId: string; modelRegistry: ModelRegistryLike };
    }) =>
      handledDynamicProviders.has(params.provider)
        ? buildDynamicModel(
            {
              provider: params.provider,
              modelId: params.context.modelId,
              modelRegistry: params.context.modelRegistry,
            },
            {
              getOpenRouterModelCapabilities,
              loadOpenRouterModelCapabilities,
            },
          )
        : undefined,
    shouldPreferProviderRuntimeResolvedModel: (params: {
      provider: string;
      context: { modelId: string };
    }) =>
      params.provider === "openai-codex" &&
      ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro"].includes(
        params.context.modelId.trim().toLowerCase(),
      ),
    prepareProviderDynamicModel: async (params: {
      provider: string;
      context: { modelId: string };
    }) =>
      params.provider === "openrouter"
        ? await loadOpenRouterModelCapabilities(params.context.modelId)
        : undefined,
    normalizeProviderResolvedModelWithPlugin: (params: {
      provider: string;
      context: { model: unknown };
    }) =>
      handledDynamicProviders.has(params.provider)
        ? normalizeDynamicModel({
            provider: params.provider,
            model: params.context.model as ResolvedModelLike,
          })
        : undefined,
    applyProviderResolvedTransportWithPlugin: (params: {
      provider: string;
      config?: unknown;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
      context: { model: unknown };
    }) => {
      const model = params.context.model as ResolvedModelLike;
      const normalized = normalizeTransport({
        provider: params.provider,
        context: {
          api: model.api as string | null | undefined,
          baseUrl: model.baseUrl as string | undefined,
        },
      });
      if (!normalized) {
        return undefined;
      }
      const nextApi = normalized.api ?? model.api;
      const nextBaseUrl = normalized.baseUrl ?? model.baseUrl;
      if (nextApi === model.api && nextBaseUrl === model.baseUrl) {
        return undefined;
      }
      return {
        ...model,
        api: nextApi,
        baseUrl: nextBaseUrl,
      };
    },
    normalizeProviderTransportWithPlugin: (params: {
      provider: string;
      context: { api?: string | null; baseUrl?: string };
    }) => normalizeTransport(params),
  };
}
