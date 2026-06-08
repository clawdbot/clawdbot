// Openai provider module implements model/runtime integration.
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildLiveModelProviderConfig,
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  normalizeProviderId,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENAI_ACCOUNT_WIZARD_GROUP, OPENAI_API_KEY_LABEL } from "./auth-choice-copy.js";
import {
  OPENAI_CODEX_RESPONSES_BASE_URL,
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";
import { applyOpenAIConfig, OPENAI_DEFAULT_MODEL } from "./default-models.js";
import {
  buildOpenAIChatGPTAuthMethods,
  buildOpenAICodexProviderHooks,
} from "./openai-chatgpt-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpenAIResponsesProviderHooks,
  buildOpenAISyntheticCatalogEntry,
  cloneFirstTemplateModel,
  findCatalogTemplate,
  matchesExactOrPrefix,
} from "./shared.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "openai";
const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_CODEX_MODELS_ENDPOINT = `${OPENAI_CODEX_RESPONSES_BASE_URL}/models?client_version=1.0.0`;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;
const OPENAI_CODEX_MODELS_CACHE_TTL_MS = 60_000;
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
const OPENAI_UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} satisfies ModelDefinitionConfig["cost"];

const OPENAI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: PROVIDER_ID,
  catalog: manifest.modelCatalog.providers.openai,
});

type BuildOpenAILiveProviderConfigParams = {
  apiKey: string;
  baseUrl?: string;
  discoveryApiKey?: string;
  env?: Record<string, string | undefined>;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

function shouldFetchOpenAILiveModels(baseUrl: string): boolean {
  return /^https:/i.test(baseUrl) && isOpenAIApiBaseUrl(baseUrl);
}

function buildOpenAIManifestModelsForBaseUrl(baseUrl: string): ModelDefinitionConfig[] {
  return OPENAI_MANIFEST_PROVIDER.models.map((model) =>
    model.api === "openai-chatgpt-responses" || isOpenAICodexBaseUrl(model.baseUrl)
      ? { ...model }
      : { ...model, baseUrl },
  );
}

export async function buildOpenAILiveProviderConfig(
  params: BuildOpenAILiveProviderConfigParams,
): Promise<ModelProviderConfig> {
  const baseUrl =
    normalizeOptionalString(params.baseUrl) ?? resolveOpenAIDefaultBaseUrl(params.env);
  const models = buildOpenAIManifestModelsForBaseUrl(baseUrl);
  if (!shouldFetchOpenAILiveModels(baseUrl)) {
    return {
      baseUrl,
      api: "openai-responses",
      apiKey: params.apiKey,
      models,
    };
  }
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: OPENAI_MODELS_ENDPOINT,
    providerConfig: {
      baseUrl,
      api: "openai-responses",
    },
    models,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    ttlMs: OPENAI_MODELS_CACHE_TTL_MS,
    auditContext: "openai-model-discovery",
  });
}

function readCodexModelString(row: unknown, key: string): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readCodexModelPositiveInteger(row: unknown, keys: readonly string[]): number | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function readCodexModelStringArray(row: unknown, keys: readonly string[]): readonly string[] {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return [];
  }
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
}

function readCodexReasoningLevels(row: unknown): readonly string[] {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return [];
  }
  const record = row as Record<string, unknown>;
  const value = record.supported_reasoning_levels ?? record.supportedReasoningLevels;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return [entry.trim()];
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const effort = (entry as { effort?: unknown }).effort;
      return typeof effort === "string" && effort.trim().length > 0 ? [effort.trim()] : [];
    }
    return [];
  });
}

function readCodexModelBoolean(row: unknown, key: string): boolean | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function readCodexModelRows(body: unknown): readonly unknown[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("OpenAI Codex model discovery response must be { models: [] }");
  }
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new Error("OpenAI Codex model discovery response must be { models: [] }");
  }
  return models;
}

function shouldIncludeCodexModelRow(row: unknown): boolean {
  const visibility = normalizeLowercaseStringOrEmpty(readCodexModelString(row, "visibility") ?? "");
  if (visibility && visibility !== "list") {
    return false;
  }
  const showInPicker =
    readCodexModelBoolean(row, "show_in_picker") ?? readCodexModelBoolean(row, "showInPicker");
  return showInPicker !== false;
}

function resolveCodexModelInput(
  row: unknown,
  fallback: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig["input"] {
  const rawModalities = readCodexModelStringArray(row, ["input_modalities", "inputModalities"]);
  if (rawModalities.length === 0) {
    return fallback?.input ?? ["text", "image"];
  }
  const modalities = new Set(
    rawModalities.map((modality) => normalizeLowercaseStringOrEmpty(modality)),
  );
  const input = new Set<ModelDefinitionConfig["input"][number]>();
  if (modalities.has("text")) {
    input.add("text");
  }
  if (modalities.has("image") || modalities.has("vision")) {
    input.add("image");
  }
  if (modalities.has("audio")) {
    input.add("audio");
  }
  if (modalities.has("video")) {
    input.add("video");
  }
  return input.size > 0 ? [...input] : (fallback?.input ?? ["text", "image"]);
}

function resolveCodexModelFallback(modelId: string): ModelDefinitionConfig | undefined {
  return OPENAI_MANIFEST_PROVIDER.models.find(
    (model) =>
      normalizeLowercaseStringOrEmpty(model.id) === normalizeLowercaseStringOrEmpty(modelId),
  );
}

function buildOpenAICodexModelFromLiveRow(row: unknown): ModelDefinitionConfig | undefined {
  if (!shouldIncludeCodexModelRow(row)) {
    return undefined;
  }
  const modelId = readCodexModelString(row, "slug") ?? readCodexModelString(row, "id");
  if (!modelId) {
    return undefined;
  }
  const fallback = resolveCodexModelFallback(modelId);
  const reasoningLevels = readCodexReasoningLevels(row);
  const contextTokens = readCodexModelPositiveInteger(row, ["context_window", "contextWindow"]);
  const contextWindow =
    readCodexModelPositiveInteger(row, ["max_context_window", "maxContextWindow"]) ??
    fallback?.contextWindow ??
    contextTokens ??
    DEFAULT_CONTEXT_TOKENS;
  const maxTokens =
    readCodexModelPositiveInteger(row, [
      "max_output_tokens",
      "maxOutputTokens",
      "max_completion_tokens",
      "maxCompletionTokens",
    ]) ??
    fallback?.maxTokens ??
    OPENAI_GPT_54_MAX_TOKENS;

  return {
    id: modelId,
    name: readCodexModelString(row, "display_name") ?? fallback?.name ?? modelId,
    api: "openai-chatgpt-responses",
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    reasoning: reasoningLevels.length > 0 || fallback?.reasoning || false,
    input: resolveCodexModelInput(row, fallback),
    cost: fallback?.cost ?? OPENAI_UNKNOWN_MODEL_COST,
    contextWindow,
    maxTokens,
    ...((contextTokens ?? fallback?.contextTokens)
      ? { contextTokens: contextTokens ?? fallback?.contextTokens }
      : {}),
    ...(fallback?.mediaInput ? { mediaInput: fallback.mediaInput } : {}),
    ...(fallback?.compat ? { compat: fallback.compat } : {}),
    ...(fallback?.thinkingLevelMap ? { thinkingLevelMap: fallback.thinkingLevelMap } : {}),
  };
}

function buildOpenAICodexStaticProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    api: "openai-chatgpt-responses",
    auth: "oauth",
    models: OPENAI_MANIFEST_PROVIDER.models,
  };
}

export async function buildOpenAICodexLiveProviderConfig(params: {
  discoveryApiKey: string;
  accountId?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: OPENAI_CODEX_MODELS_ENDPOINT,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      ttlMs: OPENAI_CODEX_MODELS_CACHE_TTL_MS,
      auditContext: "openai-codex-model-discovery",
      readRows: readCodexModelRows,
      buildRequestHeaders: ({ discoveryApiKey }) => ({
        Accept: "application/json",
        ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
        ...(params.accountId ? { "ChatGPT-Account-ID": params.accountId } : {}),
      }),
      cacheKeyParts: [
        PROVIDER_ID,
        "codex-model-rows",
        OPENAI_CODEX_MODELS_ENDPOINT,
        params.discoveryApiKey,
        params.accountId ?? "",
      ],
    });
    const models = rows
      .map(buildOpenAICodexModelFromLiveRow)
      .filter((model): model is ModelDefinitionConfig => Boolean(model));
    if (models.length > 0) {
      return {
        baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        api: "openai-chatgpt-responses",
        auth: "oauth",
        models,
      };
    }
  } catch {
    // Codex/ChatGPT discovery is advisory. Static OpenAI rows stay available
    // when OAuth refresh or the remote model list is unavailable.
  }
  return buildOpenAICodexStaticProviderConfig();
}

function isCodexCatalogAuthMode(mode: string): boolean {
  return mode === "oauth" || mode === "token";
}

function resolveOpenAICatalogBaseUrl(ctx: {
  config?: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } };
  env?: Record<string, string | undefined>;
}): string {
  const configuredProvider = Object.entries(ctx.config?.models?.providers ?? {}).find(
    ([providerId]) => normalizeProviderId(providerId) === PROVIDER_ID,
  )?.[1];
  return (
    normalizeOptionalString(configuredProvider?.baseUrl) ??
    resolveOpenAIDefaultBaseUrl(ctx.env ?? process.env)
  );
}

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
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const auth = ctx.resolveProviderAuth(PROVIDER_ID);
        try {
          const { resolveApiKeyForProvider, resolveProviderAuthProfileMetadata } =
            await import("openclaw/plugin-sdk/provider-auth-runtime");
          const runtimeAuth = await resolveApiKeyForProvider({
            provider: PROVIDER_ID,
            cfg: ctx.config,
            ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
            ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
            ...(auth.profileId
              ? {
                  profileId: auth.profileId,
                  lockedProfile: true,
                }
              : {}),
          });
          if (runtimeAuth && isCodexCatalogAuthMode(runtimeAuth.mode) && runtimeAuth.apiKey) {
            const metadata = resolveProviderAuthProfileMetadata({
              provider: PROVIDER_ID,
              cfg: ctx.config,
              ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
              ...((runtimeAuth.profileId ?? auth.profileId)
                ? { profileId: runtimeAuth.profileId ?? auth.profileId }
                : {}),
            });
            const provider = await buildOpenAICodexLiveProviderConfig({
              discoveryApiKey: runtimeAuth.apiKey,
              accountId: metadata.accountId,
            });
            return { providers: { [PROVIDER_ID]: provider } };
          }
        } catch {
          // OAuth discovery is advisory; fall through so configured API-key
          // auth can still publish the standard OpenAI catalog.
        }
        if (auth.mode === "api_key" && auth.apiKey) {
          return {
            providers: {
              [PROVIDER_ID]: await buildOpenAILiveProviderConfig({
                apiKey: auth.apiKey,
                baseUrl: resolveOpenAICatalogBaseUrl(ctx),
                discoveryApiKey: auth.discoveryApiKey,
              }),
            },
          };
        }
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey.apiKey) {
          return null;
        }
        return {
          providers: {
            [PROVIDER_ID]: await buildOpenAILiveProviderConfig({
              apiKey: apiKey.apiKey,
              baseUrl: resolveOpenAICatalogBaseUrl(ctx),
              discoveryApiKey: apiKey.discoveryApiKey,
            }),
          },
        };
      },
    },
    staticCatalog: {
      order: "simple",
      run: async () => ({ providers: { [PROVIDER_ID]: OPENAI_MANIFEST_PROVIDER } }),
    },
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
