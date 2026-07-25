// Openrouter plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  type ProviderReplayPolicy,
  type ProviderReplayPolicyContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildProviderReplayFamilyHooks,
  DEFAULT_CONTEXT_TOKENS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream-family";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildOpenRouterImageGenerationProvider } from "./image-generation-provider.js";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { isOpenRouterMistralModelId, normalizeOpenRouterApiModelId } from "./models.js";
import { buildOpenRouterMusicGenerationProvider } from "./music-generation-provider.js";
import { createOpenRouterOAuthAuthMethod } from "./oauth.js";
import { applyOpenrouterConfig, OPENROUTER_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildOpenrouterLiveProvider,
  buildOpenrouterProvider,
  isOpenRouterProxyReasoningUnsupportedModel,
  normalizeOpenRouterBaseUrl,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";
import { resolveOpenRouterExtraParamsForTransport } from "./provider-routing.js";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";
import { wrapOpenRouterProviderStream } from "./stream.js";
import { resolveOpenRouterThinkingProfile } from "./thinking-policy.js";
import { fetchOpenRouterUsage } from "./usage.js";
import {
  buildOpenRouterVideoGenerationProvider,
  listOpenRouterVideoModelCatalog,
} from "./video-generation-provider.js";

const PROVIDER_ID = "openrouter";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_FUSION_MODEL_ID = "openrouter/fusion";
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "deepseek/",
  "moonshot/",
  "moonshotai/",
  "zai/",
] as const;
const MAX_PROMPT_MODEL_ID_DISPLAY_CHARS = 256;

type OpenRouterFusionPromptContext = {
  config?: {
    agents?: {
      defaults?: {
        params?: Record<string, unknown>;
        models?: Record<string, { params?: Record<string, unknown> }>;
      };
      list?: Array<{ id?: string; params?: Record<string, unknown> }>;
    };
  };
  agentId?: string;
  modelId: string;
};

type OpenRouterFusionPromptContribution = {
  dynamicSuffix?: string;
};

function normalizeOpenRouterResolvedModel<T extends ProviderRuntimeModel>(model: T): T | undefined {
  const normalizedBaseUrl = normalizeOpenRouterBaseUrl(model.baseUrl);
  const normalizedId = normalizeOpenRouterApiModelId(model.id);
  const reasoning = isOpenRouterProxyReasoningUnsupportedModel(model.id) ? false : model.reasoning;
  if (
    (!normalizedBaseUrl || normalizedBaseUrl === model.baseUrl) &&
    (!normalizedId || normalizedId === model.id) &&
    reasoning === model.reasoning
  ) {
    return undefined;
  }
  return {
    ...model,
    ...(normalizedId ? { id: normalizedId } : {}),
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    reasoning,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizePromptModelId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = truncateUtf16Safe(
    Array.from(value)
      .filter((char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        return (
          codePoint > 0x1f &&
          (codePoint < 0x7f || codePoint > 0x9f) &&
          codePoint !== 0x2028 &&
          codePoint !== 0x2029
        );
      })
      .join("")
      .trim(),
    MAX_PROMPT_MODEL_ID_DISPLAY_CHARS,
  );
  return normalized || undefined;
}

function openRouterModelConfigKey(modelId: string): string {
  const providerPrefix = `${PROVIDER_ID}/`;
  return modelId.trim().toLowerCase().startsWith(providerPrefix)
    ? modelId
    : `${PROVIDER_ID}/${modelId}`;
}

function findConfiguredOpenRouterModelParams(
  ctx: OpenRouterFusionPromptContext,
): Record<string, unknown> | undefined {
  const configuredModels = ctx.config?.agents?.defaults?.models;
  if (!configuredModels) {
    return undefined;
  }

  const normalizedModelId = normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId;
  const directKeys = [
    openRouterModelConfigKey(ctx.modelId),
    openRouterModelConfigKey(normalizedModelId),
    `${PROVIDER_ID}/${ctx.modelId}`,
    `${PROVIDER_ID}/${normalizedModelId}`,
  ];
  for (const key of directKeys) {
    const params = readRecord(configuredModels[key]?.params);
    if (params) {
      return params;
    }
  }

  for (const [rawKey, entry] of Object.entries(configuredModels)) {
    const slashIndex = rawKey.indexOf("/");
    if (slashIndex <= 0) {
      continue;
    }
    const provider = rawKey.slice(0, slashIndex).trim().toLowerCase();
    const modelId = rawKey.slice(slashIndex + 1);
    const candidateModelId = normalizeOpenRouterApiModelId(modelId) ?? modelId;
    if (
      provider === PROVIDER_ID &&
      candidateModelId.trim().toLowerCase() === normalizedModelId.trim().toLowerCase()
    ) {
      return readRecord(entry.params);
    }
  }

  return undefined;
}

function findConfiguredOpenRouterAgentParams(
  ctx: OpenRouterFusionPromptContext,
): Record<string, unknown> | undefined {
  if (!ctx.agentId) {
    return undefined;
  }
  return readRecord(ctx.config?.agents?.list?.find((agent) => agent.id === ctx.agentId)?.params);
}

function resolveMergedOpenRouterPromptParams(
  ctx: OpenRouterFusionPromptContext,
): Record<string, unknown> | undefined {
  const merged = {
    ...readRecord(ctx.config?.agents?.defaults?.params),
    ...findConfiguredOpenRouterModelParams(ctx),
    ...findConfiguredOpenRouterAgentParams(ctx),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function resolveFusionExtraBody(
  ctx: OpenRouterFusionPromptContext,
): Record<string, unknown> | undefined {
  const params = resolveMergedOpenRouterPromptParams(ctx);
  const rawExtraBody =
    params && Object.hasOwn(params, "extra_body") ? params.extra_body : params?.extraBody;
  return readRecord(rawExtraBody);
}

function resolveOpenRouterFusionPromptContribution(
  ctx: OpenRouterFusionPromptContext,
): OpenRouterFusionPromptContribution | undefined {
  const normalizedModelId = normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId;
  if (normalizedModelId !== OPENROUTER_FUSION_MODEL_ID) {
    return undefined;
  }

  const extraBody = resolveFusionExtraBody(ctx);
  const fusionPlugin = Array.isArray(extraBody?.plugins)
    ? extraBody.plugins.map(readRecord).find((plugin) => plugin?.id === "fusion")
    : undefined;
  if (!fusionPlugin) {
    return undefined;
  }
  if (fusionPlugin.enabled === false) {
    return undefined;
  }

  const analysisModels = Array.isArray(fusionPlugin.analysis_models)
    ? fusionPlugin.analysis_models
        .map(sanitizePromptModelId)
        .filter((model): model is string => Boolean(model))
    : [];
  const finalModel = sanitizePromptModelId(fusionPlugin.model);
  const lines = [
    "## OpenRouter Fusion Configuration",
    "The active OpenRouter Fusion request is configured with these non-secret Fusion plugin fields.",
    analysisModels.length > 0 ? `Analysis models: ${analysisModels.join(", ")}.` : undefined,
    finalModel ? `Final Fusion model: ${finalModel}.` : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 2 ? { dynamicSuffix: lines.join("\n") } : undefined;
}

export default definePluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  register(api) {
    function buildDynamicOpenRouterModel(
      ctx: ProviderResolveDynamicModelContext,
    ): ProviderRuntimeModel {
      const apiModelId = normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId;
      const capabilities = getOpenRouterModelCapabilities(apiModelId);
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: OPENROUTER_BASE_URL,
        reasoning:
          (capabilities?.reasoning ?? false) &&
          !isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId),
        input: capabilities?.input ?? ["text"],
        ...(capabilities?.supportsTools !== undefined
          ? { compat: { supportsTools: capabilities.supportsTools } }
          : {}),
        cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
      };
    }

    function isOpenRouterCacheTtlModel(modelId: string): boolean {
      return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
    }

    const passthroughGeminiReplayHooks = buildProviderReplayFamilyHooks({
      family: "passthrough-gemini",
    });
    const passthroughReplayHook = passthroughGeminiReplayHooks.buildReplayPolicy;
    function buildOpenRouterReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
      const base = passthroughReplayHook?.(ctx) ?? {};
      // OpenRouter proxies Mistral, which uses non-base62 tool_call_ids and
      // requires the 9-char id contract that direct `mistral` provider already
      // applies. Without strict9, replayed assistant turns fail with HTTP 400
      // `invalid_function_call` 3280 (#58012).
      if (isOpenRouterMistralModelId(ctx.modelId)) {
        return {
          ...base,
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict9",
        };
      }
      return base;
    }

    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenRouter",
      docsPath: "/providers/models",
      envVars: ["OPENROUTER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "OpenRouter API key",
          hint: "API key",
          optionKey: "openrouterApiKey",
          flagName: "--openrouter-api-key",
          envVar: "OPENROUTER_API_KEY",
          promptMessage: "Enter OpenRouter API key",
          defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
          expectedProviders: ["openrouter"],
          applyConfig: (cfg) => applyOpenrouterConfig(cfg),
          wizard: {
            choiceId: "openrouter-api-key",
            choiceLabel: "OpenRouter API key",
            groupId: "openrouter",
            groupLabel: "OpenRouter",
            groupHint: "OAuth or API key",
            onboardingScopes: ["text-inference", "music-generation"],
          },
        }),
        createOpenRouterOAuthAuthMethod(),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
          const apiKey = auth.apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: await buildOpenrouterLiveProvider({
              apiKey,
              discoveryApiKey: auth.discoveryApiKey,
            }),
          };
        },
      },
      staticCatalog: {
        order: "simple",
        run: async () => ({
          provider: buildOpenrouterProvider(),
        }),
      },
      resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),
      prepareDynamicModel: async (ctx) => {
        await loadOpenRouterModelCapabilities(
          normalizeOpenRouterApiModelId(ctx.modelId) ?? ctx.modelId,
        );
      },
      normalizeConfig: ({ providerConfig }) => {
        const normalizedBaseUrl = normalizeOpenRouterBaseUrl(providerConfig.baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
          ? { ...providerConfig, baseUrl: normalizedBaseUrl }
          : undefined;
      },
      normalizeResolvedModel: ({ model }) => normalizeOpenRouterResolvedModel(model),
      normalizeTransport: ({ api: apiLocal, baseUrl }) => {
        const normalizedBaseUrl = normalizeOpenRouterBaseUrl(baseUrl);
        return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
          ? {
              api: apiLocal,
              baseUrl: normalizedBaseUrl,
            }
          : undefined;
      },
      ...passthroughGeminiReplayHooks,
      buildReplayPolicy: buildOpenRouterReplayPolicy,
      resolveReasoningOutputMode: () => "native",
      resolveThinkingProfile: ({ modelId }) => resolveOpenRouterThinkingProfile(modelId),
      isModernModelRef: () => true,
      resolveSystemPromptContribution: resolveOpenRouterFusionPromptContribution,
      extraParamsForTransport: resolveOpenRouterExtraParamsForTransport,
      wrapStreamFn: wrapOpenRouterProviderStream,
      isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId),
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          envDirect: [ctx.env.OPENROUTER_API_KEY],
        });
        return apiKey ? { token: apiKey } : null;
      },
      fetchUsageSnapshot: async (ctx) =>
        await fetchOpenRouterUsage({
          token: ctx.token,
          timeoutMs: ctx.timeoutMs,
          fetchFn: ctx.fetchFn,
        }),
    });
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider());
    api.registerMusicGenerationProvider(buildOpenRouterMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildOpenRouterVideoGenerationProvider());
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["video_generation"],
      liveCatalog: listOpenRouterVideoModelCatalog,
    });
    api.registerSpeechProvider(buildOpenRouterSpeechProvider());
  },
});
