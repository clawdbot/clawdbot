import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  normalizeProviderId,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENAI_ACCOUNT_WIZARD_GROUP, OPENAI_API_KEY_LABEL } from "./auth-choice-copy.js";
import {
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";
import { applyOpenAIConfig, OPENAI_DEFAULT_MODEL } from "./default-models.js";
import {
  buildOpenAIChatGPTAuthMethods,
  buildOpenAICodexProviderHooks,
} from "./openai-chatgpt-provider.js";
import {
  buildOpenAIResponsesProviderHooks,
  buildOpenAISyntheticCatalogEntry,
  cloneFirstTemplateModel,
  findCatalogTemplate,
  matchesExactOrPrefix,
} from "./shared.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "openai";
const OPENAI_CHAT_LATEST_MODEL_ID = "chat-latest";
const OPENAI_GPT_55_MODEL_ID = "gpt-5.5";
const OPENAI_GPT_55_PRO_MODEL_ID = "gpt-5.5-pro";
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_GPT_54_NANO_MODEL_ID = "gpt-5.4-nano";
const OPENAI_GPT_55_CONTEXT_WINDOW = 1_000_000;
const OPENAI_GPT_55_CONTEXT_TOKENS = 272_000;
const OPENAI_GPT_55_PRO_CONTEXT_TOKENS = 1_000_000;
const OPENAI_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_PRO_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_MINI_CONTEXT_TOKENS = 400_000;
const OPENAI_GPT_54_NANO_CONTEXT_TOKENS = 400_000;
const OPENAI_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CHAT_LATEST_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } as const;
const OPENAI_GPT_55_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } as const;
const OPENAI_GPT_55_PRO_COST = { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } as const;
const OPENAI_GPT_54_COST = { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } as const;
const OPENAI_GPT_54_PRO_COST = { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } as const;
const OPENAI_GPT_54_MINI_COST = {
  input: 0.75,
  output: 4.5,
  cacheRead: 0.075,
  cacheWrite: 0,
} as const;
const OPENAI_GPT_54_NANO_COST = {
  input: 0.2,
  output: 1.25,
  cacheRead: 0.02,
  cacheWrite: 0,
} as const;
const OPENAI_GPT_55_PRO_TEMPLATE_MODEL_IDS = [
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
] as const;
const OPENAI_GPT_55_MEDIA_INPUT = {
  image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
} as const satisfies ProviderRuntimeModel["mediaInput"];
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = [OPENAI_GPT_55_MODEL_ID] as const;
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = [OPENAI_GPT_55_PRO_MODEL_ID] as const;
const OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS = ["gpt-5-mini"] as const;
const OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS = ["gpt-5-nano", "gpt-5-mini"] as const;
const OPENAI_CHAT_LATEST_TEMPLATE_MODEL_IDS = [
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
] as const;
const OPENAI_MODERN_MODEL_IDS = [
  OPENAI_CHAT_LATEST_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_NANO_MODEL_ID,
] as const;

function shouldUseOpenAIResponsesTransport(params: {
  provider: string;
  api?: string | null;
  baseUrl?: string;
}): boolean {
  if (params.api !== "openai-completions") {
    return false;
  }
  const isOwnerProvider = normalizeProviderId(params.provider) === PROVIDER_ID;
  if (isOwnerProvider) {
    return !params.baseUrl || isOpenAIApiBaseUrl(params.baseUrl);
  }
  return typeof params.baseUrl === "string" && isOpenAIApiBaseUrl(params.baseUrl);
}

function isOpenAIProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === PROVIDER_ID;
}

function normalizeOpenAITransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const useResponsesTransport = shouldUseOpenAIResponsesTransport({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
  });

  if (!useResponsesTransport) {
    return model;
  }

  return {
    ...model,
    api: "openai-responses",
  };
}

function shouldUseCodexResponsesHooks(params: {
  provider?: string;
  api?: ProviderRuntimeModel["api"] | null;
  baseUrl?: string;
}): boolean {
  if (params.api === "openai-chatgpt-responses") {
    return true;
  }
  return typeof params.baseUrl === "string" && isOpenAICodexBaseUrl(params.baseUrl);
}

function resolveConfiguredAuthTransport(
  ctx: Pick<
    ProviderResolveDynamicModelContext,
    "authProfileId" | "authProfileMode" | "config" | "providerConfig"
  >,
) {
  if (ctx.authProfileMode === "oauth" || ctx.authProfileMode === "token") {
    return "codex";
  }
  if (ctx.authProfileMode === "api_key" || ctx.authProfileMode === "aws-sdk") {
    return "responses";
  }
  const authMode = ctx.providerConfig?.auth;
  if (authMode === "oauth" || authMode === "token") {
    return "codex";
  }
  if (authMode === "api-key") {
    return "responses";
  }

  const auth = ctx.config?.auth;
  const profiles = auth?.profiles ?? {};
  const orderedProfileIds = auth?.order?.[PROVIDER_ID] ?? [];
  for (const profileId of orderedProfileIds) {
    const mode = profiles[profileId]?.mode;
    if (mode === "oauth" || mode === "token") {
      return "codex";
    }
    if (mode === "api_key") {
      return "responses";
    }
  }

  const providerModes = Object.values(profiles)
    .filter((profile) => normalizeProviderId(profile.provider) === PROVIDER_ID)
    .map((profile) => profile.mode);
  if (providerModes.some((mode) => mode === "oauth" || mode === "token")) {
    return "codex";
  }
  if (providerModes.includes("api_key")) {
    return "responses";
  }
  return undefined;
}

function shouldResolveDynamicModelThroughCodex(ctx: ProviderResolveDynamicModelContext): boolean {
  if (
    shouldUseCodexResponsesHooks({
      provider: ctx.provider,
      api: ctx.providerConfig?.api,
      baseUrl: ctx.providerConfig?.baseUrl,
    })
  ) {
    return true;
  }
  if (ctx.providerConfig?.baseUrl && !isOpenAIApiBaseUrl(ctx.providerConfig.baseUrl)) {
    return false;
  }
  return resolveConfiguredAuthTransport(ctx) === "codex";
}

function resolveOpenAIGptForwardCompatModel(ctx: ProviderResolveDynamicModelContext) {
  const trimmedModelId = ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  let templateIds: readonly string[];
  let patch: Partial<ProviderRuntimeModel>;
  if (lower === OPENAI_CHAT_LATEST_MODEL_ID) {
    templateIds = OPENAI_CHAT_LATEST_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      reasoning: false,
      input: ["text", "image"],
      cost: OPENAI_CHAT_LATEST_COST,
      contextWindow: 400_000,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_55_MODEL_ID) {
    templateIds = [OPENAI_GPT_55_MODEL_ID, OPENAI_GPT_54_MODEL_ID];
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      reasoning: true,
      input: ["text", "image"],
      mediaInput: OPENAI_GPT_55_MEDIA_INPUT,
      cost: OPENAI_GPT_55_COST,
      contextWindow: OPENAI_GPT_55_CONTEXT_WINDOW,
      contextTokens: OPENAI_GPT_55_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_55_PRO_MODEL_ID) {
    templateIds = OPENAI_GPT_55_PRO_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      reasoning: true,
      input: ["text", "image"],
      cost: OPENAI_GPT_55_PRO_COST,
      contextWindow: OPENAI_GPT_55_PRO_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_54_MODEL_ID) {
    templateIds = OPENAI_GPT_54_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      reasoning: true,
      input: ["text", "image"],
      cost: OPENAI_GPT_54_COST,
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_54_PRO_MODEL_ID) {
    templateIds = OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      reasoning: true,
      input: ["text", "image"],
      cost: OPENAI_GPT_54_PRO_COST,
      contextWindow: OPENAI_GPT_54_PRO_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_54_MINI_MODEL_ID) {
    templateIds = OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      reasoning: true,
      input: ["text", "image"],
      cost: OPENAI_GPT_54_MINI_COST,
      contextWindow: OPENAI_GPT_54_MINI_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_GPT_54_NANO_MODEL_ID) {
    templateIds = OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      reasoning: true,
      input: ["text", "image"],
      cost: OPENAI_GPT_54_NANO_COST,
      contextWindow: OPENAI_GPT_54_NANO_CONTEXT_TOKENS,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
    };
  } else {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId: trimmedModelId,
      templateIds,
      ctx,
      patch,
    }) ??
    normalizeModelCompat({
      id: trimmedModelId,
      name: trimmedModelId,
      ...patch,
      cost: patch.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: patch.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      maxTokens: patch.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

export function buildOpenAIProvider(): ProviderPlugin {
  const codexHooks = buildOpenAICodexProviderHooks();
  const codexResponsesHooks = buildOpenAIResponsesProviderHooks();
  const responsesHooks = buildOpenAIResponsesProviderHooks({ transport: "sse" });
  return {
    id: PROVIDER_ID,
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      ...buildOpenAIChatGPTAuthMethods(),
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key",
        label: OPENAI_API_KEY_LABEL,
        hint: "Use your OpenAI API key directly",
        optionKey: "openaiApiKey",
        flagName: "--openai-api-key",
        envVar: "OPENAI_API_KEY",
        promptMessage: "Enter OpenAI API key",
        profileId: "openai:api-key",
        defaultModel: OPENAI_DEFAULT_MODEL,
        expectedProviders: ["openai"],
        applyConfig: (cfg) => applyOpenAIConfig(cfg),
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: OPENAI_API_KEY_LABEL,
          choiceHint: "Use your OpenAI API key directly",
          assistantPriority: 5,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      }),
    ],
    resolveDynamicModel: (ctx) =>
      shouldResolveDynamicModelThroughCodex(ctx)
        ? codexHooks.resolveDynamicModel?.(ctx)
        : resolveOpenAIGptForwardCompatModel(ctx),
    preferRuntimeResolvedModel: (ctx) => codexHooks.preferRuntimeResolvedModel?.(ctx) ?? false,
    normalizeResolvedModel: (ctx) => {
      if (!isOpenAIProvider(ctx.provider)) {
        return undefined;
      }
      if (
        shouldUseCodexResponsesHooks({
          provider: ctx.provider,
          api: ctx.model.api,
          baseUrl: ctx.model.baseUrl,
        })
      ) {
        return codexHooks.normalizeResolvedModel?.(ctx);
      }
      return normalizeOpenAITransport(ctx.model);
    },
    normalizeTransport: (ctx) => {
      if (shouldUseCodexResponsesHooks(ctx)) {
        return codexHooks.normalizeTransport?.(ctx);
      }
      return shouldUseOpenAIResponsesTransport(ctx)
        ? { api: "openai-responses", baseUrl: ctx.baseUrl }
        : undefined;
    },
    ...responsesHooks,
    prepareExtraParams: (ctx) => {
      const providerConfig = ctx.config?.models?.providers?.[PROVIDER_ID];
      const useCodexTransport =
        shouldUseCodexResponsesHooks({
          provider: ctx.provider,
          api: ctx.model?.api,
          baseUrl: ctx.model?.baseUrl,
        }) ||
        (normalizeProviderId(ctx.provider) === PROVIDER_ID &&
          (!providerConfig?.baseUrl || isOpenAIApiBaseUrl(providerConfig.baseUrl)) &&
          resolveConfiguredAuthTransport({
            config: ctx.config,
            providerConfig,
          }) === "codex");
      return (useCodexTransport ? codexResponsesHooks : responsesHooks).prepareExtraParams?.(ctx);
    },
    resolveUsageAuth: codexHooks.resolveUsageAuth,
    fetchUsageSnapshot: codexHooks.fetchUsageSnapshot,
    refreshOAuth: codexHooks.refreshOAuth,
    buildMissingAuthMessage: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      if (ctx.listProfileIds(PROVIDER_ID).length === 0) {
        return undefined;
      }
      return 'No API key found for provider "openai". You are authenticated with OpenAI ChatGPT/Codex OAuth. Use openai/gpt-5.5 with the ChatGPT/Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.';
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /content_filter.*(?:prompt|input).*(?:too long|exceed)/i.test(errorMessage),
    resolveReasoningOutputMode: () => "native",
    resolveThinkingProfile: ({ provider, modelId }) =>
      normalizeProviderId(provider) === PROVIDER_ID
        ? resolveUnifiedOpenAIThinkingProfile(modelId)
        : null,
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_MODERN_MODEL_IDS),
    augmentModelCatalog: (ctx) => {
      const openAiGpt55ProTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_55_PRO_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54Template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54ProTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54MiniTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54NanoTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS,
      });
      return [
        buildOpenAISyntheticCatalogEntry(openAiGpt55ProTemplate, {
          id: OPENAI_GPT_55_PRO_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_GPT_55_PRO_CONTEXT_TOKENS,
        }),
        buildOpenAISyntheticCatalogEntry(openAiGpt54Template, {
          id: OPENAI_GPT_54_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
        }),
        buildOpenAISyntheticCatalogEntry(openAiGpt54ProTemplate, {
          id: OPENAI_GPT_54_PRO_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_GPT_54_PRO_CONTEXT_TOKENS,
        }),
        buildOpenAISyntheticCatalogEntry(openAiGpt54MiniTemplate, {
          id: OPENAI_GPT_54_MINI_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_GPT_54_MINI_CONTEXT_TOKENS,
        }),
        buildOpenAISyntheticCatalogEntry(openAiGpt54NanoTemplate, {
          id: OPENAI_GPT_54_NANO_MODEL_ID,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: OPENAI_GPT_54_NANO_CONTEXT_TOKENS,
        }),
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}

/** @deprecated Use buildOpenAIProvider; OpenAI Codex is now an OpenAI auth/transport mode. */
export function buildOpenAICodexProviderPlugin(): ProviderPlugin {
  return buildOpenAIProvider();
}
