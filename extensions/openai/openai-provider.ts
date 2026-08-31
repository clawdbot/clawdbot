// Openai provider module implements model/runtime integration.
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
  readLiveModelCatalogBooleanField,
  readLiveModelCatalogPositiveSafeIntegerField,
  readLiveModelCatalogStringField,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  buildManifestModelProviderConfig,
  type ProviderCatalogOutcome,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeProviderId,
  resolveFamilyForwardCompatModel,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENAI_CODEX_RESPONSES_BASE_URL,
  classifyOpenAIBaseUrl,
  isOpenAICodexBaseUrl,
  isOpenAIHttpsApiBaseUrl,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";
import {
  applyOpenAIConfig,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
} from "./default-models.js";
import {
  OPENAI_CHAT_LATEST_MODEL_ID,
  OPENAI_GPT_53_CODEX_SPARK_MODEL_ID,
  OPENAI_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_NANO_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_56_LUNA_MODEL_ID,
  OPENAI_GPT_56_MODEL_ID,
  OPENAI_GPT_56_SOL_MODEL_ID,
  OPENAI_GPT_56_TERRA_MODEL_ID,
  OPENAI_PROVIDER_MODERN_MODEL_IDS,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAISubscriptionOnlyRouteModelId,
  normalizeOpenAIModelRouteId,
  resolveOpenAICodexReasoningEfforts,
} from "./model-route-contract.js";
import {
  buildOpenAIChatGPTAuthMethodRuns,
  buildOpenAICodexProviderHooks,
} from "./openai-chatgpt-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createOpenAIProvider } from "./provider-contract-api.js";
import { resolveAuthoredOpenAIProviderConfig } from "./provider-policy-api.js";
import {
  buildOpenAIResponsesProviderHooks,
  buildOpenAISyntheticCatalogEntry,
  findCatalogTemplate,
  matchesExactOrPrefix,
  OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
} from "./shared.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "openai";

// OpenAI-native error codes stay with the OpenAI provider hook.
function classifyOpenAiFailoverCode(code: string | undefined) {
  switch (code?.trim().toUpperCase()) {
    case "SERVER_ERROR":
      return "server_error" as const;
    case "INSUFFICIENT_QUOTA":
      return "billing" as const;
    default:
      return undefined;
  }
}
const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
// Keep synchronized with extensions/codex's exact @openai/codex dependency;
// the provider contract test fails when that managed-runtime pin changes.
const OPENAI_CODEX_CLIENT_VERSION = "0.151.0";
const OPENAI_CODEX_MODELS_ENDPOINT = `${OPENAI_CODEX_RESPONSES_BASE_URL}/models?client_version=${OPENAI_CODEX_CLIENT_VERSION}`;
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;
const OPENAI_CODEX_MODELS_CACHE_TTL_MS = 60_000;
const OPENAI_CODEX_GPT_56_CONTEXT_WINDOW = 372_000;
const OPENAI_GPT_55_PRO_CONTEXT_WINDOW = 1_050_000;
const OPENAI_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_PRO_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_MINI_CONTEXT_TOKENS = 400_000;
const OPENAI_GPT_54_NANO_CONTEXT_TOKENS = 400_000;
const OPENAI_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CHAT_LATEST_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } as const;
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
// Repair an already-authorized model before borrowing an older family template;
// remote discovery must not be needed to restore its native image capability.
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = [OPENAI_GPT_54_MODEL_ID, OPENAI_GPT_55_MODEL_ID] as const;
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = [
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
] as const;
const OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS = [OPENAI_GPT_54_MINI_MODEL_ID, "gpt-5-mini"] as const;
const OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS = [
  OPENAI_GPT_54_NANO_MODEL_ID,
  "gpt-5-nano",
  "gpt-5-mini",
] as const;
const OPENAI_CHAT_LATEST_TEMPLATE_MODEL_IDS = [
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
] as const;
const OPENAI_GPT_56_TEMPLATE_MODEL_IDS = [OPENAI_GPT_55_MODEL_ID] as const;
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
  rejectionScope?: "catalog";
  env?: Record<string, string | undefined>;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

function shouldFetchOpenAILiveModels(baseUrl: string): boolean {
  return isOpenAIHttpsApiBaseUrl(baseUrl);
}

function buildOpenAIManifestModelsForBaseUrl(baseUrl: string): ModelDefinitionConfig[] {
  return OPENAI_MANIFEST_PROVIDER.models.map((model) =>
    model.api === "openai-chatgpt-responses" || isOpenAICodexBaseUrl(model.baseUrl)
      ? { ...model }
      : {
          ...model,
          api: model.api ?? OPENAI_MANIFEST_PROVIDER.api ?? "openai-responses",
          baseUrl,
        },
  );
}

function buildOpenAIDiscoverablePlatformModels(baseUrl: string): ModelDefinitionConfig[] {
  const models = [
    {
      id: OPENAI_CHAT_LATEST_MODEL_ID,
      name: "Chat Latest",
      reasoning: false,
      cost: OPENAI_CHAT_LATEST_COST,
      contextWindow: 400_000,
    },
    {
      id: OPENAI_GPT_54_MODEL_ID,
      name: "GPT-5.4",
      reasoning: true,
      cost: OPENAI_GPT_54_COST,
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
    },
    {
      id: OPENAI_GPT_54_PRO_MODEL_ID,
      name: "GPT-5.4 Pro",
      reasoning: true,
      cost: OPENAI_GPT_54_PRO_COST,
      contextWindow: OPENAI_GPT_54_PRO_CONTEXT_TOKENS,
    },
    {
      id: OPENAI_GPT_54_MINI_MODEL_ID,
      name: "GPT-5.4 Mini",
      reasoning: true,
      cost: OPENAI_GPT_54_MINI_COST,
      contextWindow: OPENAI_GPT_54_MINI_CONTEXT_TOKENS,
    },
    {
      id: OPENAI_GPT_54_NANO_MODEL_ID,
      name: "GPT-5.4 Nano",
      reasoning: true,
      cost: OPENAI_GPT_54_NANO_COST,
      contextWindow: OPENAI_GPT_54_NANO_CONTEXT_TOKENS,
    },
  ] as const;

  // First-party discovery must retain provider-owned costs and capabilities;
  // generic projection would otherwise surface valid models as zero-cost.
  return models.map(({ id, name, reasoning, cost, contextWindow }) => ({
    id,
    name,
    reasoning,
    cost,
    contextWindow,
    api: "openai-responses",
    baseUrl,
    input: ["text", "image"],
    maxTokens: OPENAI_GPT_54_MAX_TOKENS,
  }));
}

type OpenAILiveProviderCatalog = {
  provider: ModelProviderConfig;
  outcome?: ProviderCatalogOutcome;
};

function scopeOpenAICatalogOutcome(
  catalog: OpenAILiveProviderCatalog,
  profileId: string | undefined,
): OpenAILiveProviderCatalog {
  const scopedProfileId = profileId?.trim();
  if (!catalog.outcome || !scopedProfileId) {
    return catalog;
  }
  return { ...catalog, outcome: { ...catalog.outcome, profileId: scopedProfileId } };
}

async function buildOpenAILiveProviderConfig(
  params: BuildOpenAILiveProviderConfigParams,
): Promise<OpenAILiveProviderCatalog> {
  const baseUrl =
    normalizeOptionalString(params.baseUrl) ?? resolveOpenAIDefaultBaseUrl(params.env);
  const models = buildOpenAIManifestModelsForBaseUrl(baseUrl);
  const fallback: ModelProviderConfig = {
    baseUrl,
    api: "openai-responses",
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    models,
  };
  if (!shouldFetchOpenAILiveModels(baseUrl)) {
    return { provider: fallback };
  }
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: OPENAI_MODELS_ENDPOINT,
      apiKey: params.apiKey,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      ttlMs: OPENAI_MODELS_CACHE_TTL_MS,
      auditContext: "openai-model-discovery",
    });
    const discoveredIds = new Set(
      rows.flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          return [];
        }
        const candidate = row as { id?: unknown; object?: unknown };
        if (candidate.object !== undefined && candidate.object !== "model") {
          return [];
        }
        const modelId = typeof candidate.id === "string" ? candidate.id.trim() : "";
        return modelId ? [modelId] : [];
      }),
    );
    const selectedIds = new Set<string>();
    // A successful account catalog is authoritative even when it has no
    // visible supported models; static rows cannot grant model access.
    return {
      provider: {
        ...fallback,
        models: [...models, ...buildOpenAIDiscoverablePlatformModels(baseUrl)].filter((model) => {
          if (!discoveredIds.has(model.id) || selectedIds.has(model.id)) {
            return false;
          }
          selectedIds.add(model.id);
          return true;
        }),
      },
      outcome: { provider: PROVIDER_ID, status: "ready" },
    };
  } catch (error) {
    if (
      error instanceof LiveModelCatalogHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      return {
        provider: { ...fallback, models: [] },
        outcome: {
          provider: PROVIDER_ID,
          ...(params.rejectionScope ? { rejectionScope: "catalog" } : {}),
          status: "auth-rejected",
        },
      };
    }
    return { provider: fallback, outcome: { provider: PROVIDER_ID, status: "unavailable" } };
  }
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

function readCodexReasoningLevels(row: unknown): readonly string[] | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const value = record.supported_reasoning_levels ?? record.supportedReasoningLevels;
  if (!Array.isArray(value)) {
    return undefined;
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
  const visibility = normalizeLowercaseStringOrEmpty(
    readLiveModelCatalogStringField(row, "visibility") ?? "",
  );
  if (visibility && visibility !== "list") {
    return false;
  }
  const showInPicker =
    readLiveModelCatalogBooleanField(row, "show_in_picker") ??
    readLiveModelCatalogBooleanField(row, "showInPicker");
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

function normalizeOpenAICodexCatalogModel(model: ModelDefinitionConfig): ModelDefinitionConfig {
  const modelId = normalizeLowercaseStringOrEmpty(model.id);
  if (
    modelId === OPENAI_GPT_56_SOL_MODEL_ID ||
    modelId === OPENAI_GPT_56_TERRA_MODEL_ID ||
    modelId === OPENAI_GPT_56_LUNA_MODEL_ID
  ) {
    const supportedReasoningEfforts = resolveOpenAICodexReasoningEfforts(
      modelId,
      model.compat?.supportedReasoningEfforts?.filter((effort) => effort !== "none"),
    );
    return {
      ...model,
      contextWindow: OPENAI_CODEX_GPT_56_CONTEXT_WINDOW,
      contextTokens: OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      thinkingLevelMap: { ...model.thinkingLevelMap, off: null },
      ...(model.compat
        ? {
            compat: {
              ...model.compat,
              ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
            },
          }
        : {}),
    };
  }
  return model;
}

function resolveCodexModelFallback(modelId: string): ModelDefinitionConfig | undefined {
  const fallbackModel = OPENAI_MANIFEST_PROVIDER.models.find(
    (candidate) =>
      normalizeLowercaseStringOrEmpty(candidate.id) === normalizeLowercaseStringOrEmpty(modelId),
  );
  return fallbackModel ? normalizeOpenAICodexCatalogModel(fallbackModel) : undefined;
}

function buildOpenAICodexModelFromLiveRow(row: unknown): ModelDefinitionConfig | undefined {
  if (!shouldIncludeCodexModelRow(row)) {
    return undefined;
  }
  const modelId =
    readLiveModelCatalogStringField(row, "slug") ?? readLiveModelCatalogStringField(row, "id");
  if (!modelId) {
    return undefined;
  }
  if (isOpenAIPlatformOnlyRouteModelId(modelId)) {
    return undefined;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const fallback = resolveCodexModelFallback(modelId);
  const reasoningLevels = readCodexReasoningLevels(row);
  const observedContextTokens = readLiveModelCatalogPositiveSafeIntegerField(row, [
    "context_window",
    "contextWindow",
  ]);
  const isGpt56Model = matchesExactOrPrefix(normalizedModelId, [OPENAI_GPT_56_MODEL_ID]);
  const contextTokens = isGpt56Model
    ? Math.min(
        observedContextTokens ?? fallback?.contextTokens ?? OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
        OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      )
    : observedContextTokens;
  const contextWindow =
    readLiveModelCatalogPositiveSafeIntegerField(row, ["max_context_window", "maxContextWindow"]) ??
    fallback?.contextWindow ??
    observedContextTokens ??
    DEFAULT_CONTEXT_TOKENS;
  const maxTokens =
    readLiveModelCatalogPositiveSafeIntegerField(row, [
      "max_output_tokens",
      "maxOutputTokens",
      "max_completion_tokens",
      "maxCompletionTokens",
    ]) ??
    fallback?.maxTokens ??
    OPENAI_GPT_54_MAX_TOKENS;
  const compat =
    reasoningLevels !== undefined
      ? {
          ...fallback?.compat,
          supportsReasoningEffort: true,
          supportedReasoningEfforts: [...reasoningLevels],
        }
      : fallback?.compat;
  const thinkingLevelMap = {
    ...(reasoningLevels === undefined ? fallback?.thinkingLevelMap : {}),
    ...(normalizedModelId.startsWith("gpt-5.6") ? { off: null } : {}),
    ...(reasoningLevels?.includes("xhigh") ? { xhigh: "xhigh" as const } : {}),
    ...(reasoningLevels?.includes("max") ? { max: "max" as const } : {}),
  };

  return normalizeOpenAICodexCatalogModel({
    id: modelId,
    name: readLiveModelCatalogStringField(row, "display_name") ?? fallback?.name ?? modelId,
    api: "openai-chatgpt-responses",
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    reasoning: (reasoningLevels?.length ?? 0) > 0 || fallback?.reasoning || false,
    input: resolveCodexModelInput(row, fallback),
    cost: fallback?.cost ?? OPENAI_UNKNOWN_MODEL_COST,
    contextWindow,
    maxTokens,
    ...((contextTokens ?? fallback?.contextTokens)
      ? { contextTokens: contextTokens ?? fallback?.contextTokens }
      : {}),
    ...(fallback?.mediaInput ? { mediaInput: fallback.mediaInput } : {}),
    ...(compat ? { compat } : {}),
    ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
  });
}

function buildOpenAICodexStaticProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    api: "openai-chatgpt-responses",
    auth: "oauth",
    models: OPENAI_MANIFEST_PROVIDER.models.flatMap((model) => {
      const modelId = normalizeLowercaseStringOrEmpty(model.id);
      if (isOpenAIPlatformOnlyRouteModelId(modelId)) {
        return [];
      }
      // Static OAuth rows are offline hints, not entitlement claims. Keep only
      // the proven GPT-5.6 subscription route; live discovery may add others.
      if (modelId.startsWith("gpt-5.6") && modelId !== OPENAI_GPT_56_SOL_MODEL_ID) {
        return [];
      }
      return [normalizeOpenAICodexCatalogModel(model)];
    }),
  };
}

async function buildOpenAICodexLiveProviderConfig(params: {
  discoveryApiKey: string;
  accountId?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<OpenAILiveProviderCatalog> {
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: OPENAI_CODEX_MODELS_ENDPOINT,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      ttlMs: OPENAI_CODEX_MODELS_CACHE_TTL_MS,
      auditContext: "openai-model-discovery",
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
    // A successful account-scoped response is authoritative even when all
    // rows are hidden; static hints must not invent subscription access.
    return {
      provider: {
        baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        api: "openai-chatgpt-responses",
        auth: "oauth",
        models,
      },
      outcome: { provider: PROVIDER_ID, status: "ready" },
    };
  } catch (error) {
    if (
      error instanceof LiveModelCatalogHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      return {
        provider: { ...buildOpenAICodexStaticProviderConfig(), models: [] },
        outcome: { provider: PROVIDER_ID, status: "auth-rejected" },
      };
    }
    // Codex/ChatGPT discovery is advisory. Static OpenAI rows stay available
    // when OAuth refresh or the remote model list is unavailable.
  }
  return {
    provider: buildOpenAICodexStaticProviderConfig(),
    outcome: { provider: PROVIDER_ID, status: "unavailable" },
  };
}

function isCodexCatalogAuthMode(mode: string): boolean {
  return mode === "oauth" || mode === "token";
}

function resolveOpenAICatalogRejectionScope(auth: {
  apiKey?: string;
  discoveryApiKey?: string;
}): "catalog" | undefined {
  return auth.apiKey && !auth.discoveryApiKey && isNonSecretApiKeyMarker(auth.apiKey)
    ? "catalog"
    : undefined;
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
  modelId?: string;
  api?: string | null;
  baseUrl?: string;
  config?: { models?: { providers?: Record<string, ModelProviderConfig | undefined> } };
}): boolean {
  if (params.api !== "openai-completions") {
    return false;
  }
  const isOwnerProvider = normalizeProviderId(params.provider) === PROVIDER_ID;
  const isPlatformEndpoint =
    typeof params.baseUrl === "string" && classifyOpenAIBaseUrl(params.baseUrl) === "platform";
  if (isOwnerProvider) {
    if (resolveAuthoredOpenAICompletionsRoute(params)) {
      return false;
    }
    return !params.baseUrl || isPlatformEndpoint;
  }
  return isPlatformEndpoint;
}

/** Resolves the effective authored OpenAI config route for one model. */
function resolveAuthoredOpenAIConfigRoute(params: {
  provider: string;
  modelId?: string;
  config?: { models?: { providers?: Record<string, ModelProviderConfig | undefined> } };
}):
  | { configuredModel?: ModelDefinitionConfig; configuredProvider: ModelProviderConfig }
  | undefined {
  const providerConfig = resolveAuthoredOpenAIProviderConfig(params);
  if (!providerConfig) {
    return undefined;
  }
  const modelId = normalizeOpenAIModelRouteId(params.modelId);
  let modelConfig: ModelDefinitionConfig | undefined;
  for (const model of providerConfig.models ?? []) {
    if (normalizeOpenAIModelRouteId(model.id) !== modelId) {
      continue;
    }
    // Match config normalization: the first row stays authoritative while
    // later duplicate rows fill fields the first row omitted.
    modelConfig = modelConfig ? { ...model, ...modelConfig } : model;
  }
  return {
    ...(modelConfig ? { configuredModel: modelConfig } : {}),
    configuredProvider: providerConfig,
  };
}

/** Authored Completions is a current transport contract; only catalog defaults are upgraded. */
function resolveAuthoredOpenAICompletionsRoute(params: {
  provider: string;
  modelId?: string;
  config?: { models?: { providers?: Record<string, ModelProviderConfig | undefined> } };
}): { api: "openai-completions"; baseUrl: string } | undefined {
  const configuredRoute = resolveAuthoredOpenAIConfigRoute(params);
  if (!configuredRoute) {
    return undefined;
  }
  const effectiveApi =
    normalizeOptionalString(configuredRoute.configuredModel?.api) ??
    normalizeOptionalString(configuredRoute.configuredProvider.api);
  if (effectiveApi !== "openai-completions") {
    return undefined;
  }
  const baseUrl =
    normalizeOptionalString(configuredRoute.configuredModel?.baseUrl) ??
    normalizeOptionalString(configuredRoute.configuredProvider.baseUrl) ??
    resolveOpenAIDefaultBaseUrl(process.env);
  return { api: "openai-completions", baseUrl };
}

function isOpenAIProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === PROVIDER_ID;
}

function normalizeOpenAITransport(
  model: ProviderRuntimeModel,
  context?: {
    modelId?: string;
    config?: { models?: { providers?: Record<string, ModelProviderConfig | undefined> } };
  },
): ProviderRuntimeModel {
  const useResponsesTransport = shouldUseOpenAIResponsesTransport({
    provider: model.provider,
    modelId: context?.modelId,
    api: model.api,
    baseUrl: model.baseUrl,
    config: context?.config,
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

function resolveConfiguredProviderAuthTransport(
  providerConfig: ProviderResolveDynamicModelContext["providerConfig"],
) {
  const authMode = providerConfig?.auth;
  if (authMode === "oauth" || authMode === "token") {
    return "codex";
  }
  if (authMode === "api-key") {
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
  if (
    ctx.providerConfig?.api === "openai-responses" ||
    ctx.providerConfig?.api === "openai-completions" ||
    (ctx.providerConfig?.baseUrl && !isOpenAICodexBaseUrl(ctx.providerConfig.baseUrl))
  ) {
    return false;
  }
  // The auth planner owns profile ordering and projects the selected physical
  // route into providerConfig before materialization. Until then, only a
  // one-route model contract may choose a transport.
  if (isOpenAIPlatformOnlyRouteModelId(ctx.modelId)) {
    return false;
  }
  if (isOpenAISubscriptionOnlyRouteModelId(ctx.modelId)) {
    return true;
  }
  return ctx.agentRuntimeId === "codex";
}

function buildOpenAIUnknownModelHint(modelId: string): string | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (normalized !== OPENAI_GPT_53_CODEX_SPARK_MODEL_ID) {
    return undefined;
  }
  return "gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.";
}

const OPENAI_GPT_FORWARD_COMPAT_CASES = [
  {
    match: [OPENAI_CHAT_LATEST_MODEL_ID],
    templateIds: OPENAI_CHAT_LATEST_TEMPLATE_MODEL_IDS,
    patch: { reasoning: false, cost: OPENAI_CHAT_LATEST_COST, contextWindow: 400_000 },
  },
  {
    match: [
      OPENAI_GPT_56_MODEL_ID,
      OPENAI_GPT_56_SOL_MODEL_ID,
      OPENAI_GPT_56_TERRA_MODEL_ID,
      OPENAI_GPT_56_LUNA_MODEL_ID,
    ],
    templateIds: OPENAI_GPT_56_TEMPLATE_MODEL_IDS,
  },
  {
    match: [OPENAI_GPT_55_MODEL_ID],
    templateIds: [OPENAI_GPT_55_MODEL_ID, OPENAI_GPT_54_MODEL_ID],
  },
  {
    match: [OPENAI_GPT_55_PRO_MODEL_ID],
    templateIds: OPENAI_GPT_55_PRO_TEMPLATE_MODEL_IDS,
  },
  {
    match: [OPENAI_GPT_54_MODEL_ID],
    templateIds: OPENAI_GPT_54_TEMPLATE_MODEL_IDS,
  },
  {
    match: [OPENAI_GPT_54_PRO_MODEL_ID],
    templateIds: OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS,
  },
  {
    match: [OPENAI_GPT_54_MINI_MODEL_ID],
    templateIds: OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS,
  },
  {
    match: [OPENAI_GPT_54_NANO_MODEL_ID],
    templateIds: OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS,
  },
] satisfies Parameters<typeof resolveFamilyForwardCompatModel>[0]["cases"];

function resolveOpenAIGptForwardCompatModel(ctx: ProviderResolveDynamicModelContext) {
  const trimmedModelId = ctx.modelId.trim();
  const modelId = normalizeLowercaseStringOrEmpty(trimmedModelId);
  const exactModel = ctx.modelRegistry.find(PROVIDER_ID, trimmedModelId);
  if (
    modelId === OPENAI_GPT_56_SOL_MODEL_ID ||
    modelId === OPENAI_GPT_56_TERRA_MODEL_ID ||
    modelId === OPENAI_GPT_56_LUNA_MODEL_ID
  ) {
    if (exactModel) {
      return exactModel;
    }
  }
  // Known rows own capability metadata even before discovery. Only an exact registry row
  // may override compat; an older family template cannot choose this model's Code Mode tier.
  const catalogModel = OPENAI_MANIFEST_PROVIDER.models.find(
    ({ id }) => id === (modelId === OPENAI_GPT_56_MODEL_ID ? OPENAI_GPT_56_SOL_MODEL_ID : modelId),
  );
  return resolveFamilyForwardCompatModel({
    providerId: PROVIDER_ID,
    ctx,
    cases: OPENAI_GPT_FORWARD_COMPAT_CASES,
    patch: {
      reasoning: true,
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      ...catalogModel,
      id: trimmedModelId,
      name: trimmedModelId,
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: resolveOpenAIDefaultBaseUrl(),
      input: catalogModel
        ? catalogModel.input.filter(
            (item): item is "text" | "image" => item === "text" || item === "image",
          )
        : ["text", "image"],
      compat: exactModel ? exactModel.compat : catalogModel?.compat,
    },
    synthesize: true,
  });
}

export function buildOpenAIProvider(): ProviderPlugin {
  const providerDefinition = createOpenAIProvider();
  const apiKeyDefinition = providerDefinition.auth.find((method) => method.id === "api-key");
  if (!apiKeyDefinition) {
    throw new Error("OpenAI provider contract is missing API-key auth");
  }
  const chatGPTAuthRuns = buildOpenAIChatGPTAuthMethodRuns();
  const apiKeyRuntime = createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: apiKeyDefinition.id,
    label: apiKeyDefinition.label,
    hint: apiKeyDefinition.hint,
    optionKey: "openaiApiKey",
    flagName: "--openai-api-key",
    envVar: "OPENAI_API_KEY",
    promptMessage: "Enter OpenAI API key",
    profileId: "openai:api-key",
    defaultModel: OPENAI_DEFAULT_MODEL,
    preserveExistingPrimary: true,
    expectedProviders: [PROVIDER_ID],
    applyConfig: (cfg) => applyOpenAIConfig(cfg),
    wizard: apiKeyDefinition.wizard,
  });
  for (const method of providerDefinition.auth) {
    if (method.id === "oauth" || method.id === "device-code") {
      method.run = chatGPTAuthRuns[method.id];
      continue;
    }
    if (method.id !== "api-key") {
      throw new Error(`OpenAI provider contract has unknown auth method: ${method.id}`);
    }
    method.starterModel = apiKeyRuntime.starterModel;
    method.run = apiKeyRuntime.run;
    method.runNonInteractive = apiKeyRuntime.runNonInteractive;
    method.validateNonInteractive = apiKeyRuntime.validateNonInteractive;
  }
  const codexHooks = buildOpenAICodexProviderHooks();
  const nativeResponsesHooks = buildOpenAIResponsesProviderHooks();
  const responsesHooks = buildOpenAIResponsesProviderHooks({ transport: "sse" });
  return {
    ...providerDefinition,
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER_ID)) {
          return null;
        }
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
            const catalog = scopeOpenAICatalogOutcome(
              await buildOpenAICodexLiveProviderConfig({
                discoveryApiKey: runtimeAuth.apiKey,
                accountId: metadata.accountId,
              }),
              runtimeAuth.profileId ?? auth.profileId,
            );
            return {
              providers: { [PROVIDER_ID]: catalog.provider },
              ...(catalog.outcome ? { outcomes: [catalog.outcome] } : {}),
            };
          }
        } catch {
          // OAuth discovery is advisory; fall through so configured API-key
          // auth can still publish the standard OpenAI catalog.
        }
        if (auth.mode === "api_key" && auth.apiKey) {
          const catalog = scopeOpenAICatalogOutcome(
            await buildOpenAILiveProviderConfig({
              apiKey: auth.apiKey,
              baseUrl: resolveOpenAICatalogBaseUrl(ctx),
              discoveryApiKey: auth.discoveryApiKey,
              rejectionScope: resolveOpenAICatalogRejectionScope(auth),
            }),
            auth.profileId,
          );
          return {
            providers: { [PROVIDER_ID]: catalog.provider },
            ...(catalog.outcome ? { outcomes: [catalog.outcome] } : {}),
          };
        }
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey.apiKey) {
          return null;
        }
        const catalog = await buildOpenAILiveProviderConfig({
          apiKey: apiKey.apiKey,
          baseUrl: resolveOpenAICatalogBaseUrl(ctx),
          discoveryApiKey: apiKey.discoveryApiKey,
          rejectionScope: resolveOpenAICatalogRejectionScope(apiKey),
        });
        return {
          providers: { [PROVIDER_ID]: catalog.provider },
          ...(catalog.outcome ? { outcomes: [catalog.outcome] } : {}),
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
      const authoredCompletionsRoute = resolveAuthoredOpenAICompletionsRoute(ctx);
      if (authoredCompletionsRoute) {
        return { ...ctx.model, ...authoredCompletionsRoute };
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
      return normalizeOpenAITransport(ctx.model, ctx);
    },
    normalizeTransport: (ctx) => {
      const authoredCompletionsRoute = resolveAuthoredOpenAICompletionsRoute(ctx);
      if (authoredCompletionsRoute) {
        return ctx.api === authoredCompletionsRoute.api &&
          ctx.baseUrl === authoredCompletionsRoute.baseUrl
          ? undefined
          : authoredCompletionsRoute;
      }
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
          (!providerConfig?.baseUrl || isOpenAIHttpsApiBaseUrl(providerConfig.baseUrl)) &&
          resolveConfiguredProviderAuthTransport(providerConfig) === "codex");
      return (useCodexTransport ? nativeResponsesHooks : responsesHooks).prepareExtraParams?.(ctx);
    },
    resolveUsageAuth: codexHooks.resolveUsageAuth,
    fetchUsageSnapshot: codexHooks.fetchUsageSnapshot,
    refreshOAuth: codexHooks.refreshOAuth,
    buildUnknownModelHint: ({ modelId }) => buildOpenAIUnknownModelHint(modelId),
    buildMissingAuthMessage: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      if (ctx.listProfileIds(PROVIDER_ID).length === 0) {
        return undefined;
      }
      return `No API key found for provider "openai". You are authenticated with OpenAI ChatGPT/Codex OAuth. Use ${OPENAI_CODEX_DEFAULT_MODEL} with the ChatGPT/Codex OAuth profile, or set OPENAI_API_KEY for direct OpenAI API access.`;
    },
    matchesContextOverflowError: ({ errorMessage }) =>
      /content_filter.*(?:prompt|input).*(?:too long|exceed)/i.test(errorMessage),
    classifyFailoverReason: ({ code }) => classifyOpenAiFailoverCode(code),
    resolveReasoningOutputMode: () => "native",
    resolveThinkingProfile: ({ provider, modelId, agentRuntime, api, compat }) =>
      normalizeProviderId(provider) === PROVIDER_ID
        ? resolveUnifiedOpenAIThinkingProfile(modelId, agentRuntime, compat, api)
        : null,
    isModernModelRef: ({ modelId }) =>
      matchesExactOrPrefix(modelId, OPENAI_PROVIDER_MODERN_MODEL_IDS),
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
          contextWindow: OPENAI_GPT_55_PRO_CONTEXT_WINDOW,
          contextTokens: OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
