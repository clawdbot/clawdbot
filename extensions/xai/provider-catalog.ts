// Xai provider module implements model/runtime integration.
import {
  buildLiveModelProviderConfig,
  readLiveModelCatalogBooleanField,
  readLiveModelCatalogPositiveSafeIntegerField,
  readLiveModelCatalogStringField,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildXaiCatalogModels,
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_IMAGE_MODELS,
  XAI_DEFAULT_MAX_TOKENS,
  XAI_UNKNOWN_MODEL_COST,
} from "./model-definitions.js";

const PROVIDER_ID = "xai";
const XAI_MODELS_ENDPOINT = `${XAI_BASE_URL}/models`;
export const XAI_GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_GROK_OAUTH_MODELS_ENDPOINT = `${XAI_GROK_OAUTH_BASE_URL}/models`;
const XAI_MODELS_CACHE_TTL_MS = 60_000;
const XAI_GROK_OAUTH_MODELS_CACHE_TTL_MS = 60_000;
// Composer emits replayable Responses reasoning, but the OAuth catalog omits that capability.
// Keep it classified here or the stream wrapper will omit encrypted reasoning from replay.
const XAI_GROK_OAUTH_REASONING_MODEL_IDS = new Set(["grok-composer-2.5-fast"]);

export function buildXaiProvider(
  api: ModelProviderConfig["api"] = "openai-responses",
  oauthLogin = false,
): ModelProviderConfig {
  if (oauthLogin) {
    return buildXaiOAuthProvider();
  }
  return {
    baseUrl: XAI_BASE_URL,
    api,
    models: buildXaiCatalogModels(),
  };
}

function buildXaiOAuthFallbackProvider(): ModelProviderConfig {
  return {
    baseUrl: XAI_GROK_OAUTH_BASE_URL,
    api: "openai-responses",
    auth: "oauth",
    models: buildXaiCatalogModels(),
  };
}

export function buildXaiOAuthProvider(): ModelProviderConfig {
  return buildXaiOAuthFallbackProvider();
}

export async function buildLiveXaiProvider(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  oauthLogin?: boolean;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  if (params.oauthLogin) {
    const discoveryApiKey = params.discoveryApiKey ?? params.apiKey;
    return discoveryApiKey
      ? await buildLiveXaiOAuthProvider({
          discoveryApiKey,
          fetchGuard: params.fetchGuard,
          signal: params.signal,
        })
      : buildXaiProvider("openai-responses", true);
  }
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: XAI_MODELS_ENDPOINT,
    providerConfig: {
      baseUrl: XAI_BASE_URL,
      api: "openai-responses",
    },
    models: buildXaiCatalogModels(),
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    ttlMs: XAI_MODELS_CACHE_TTL_MS,
    auditContext: "xai-model-discovery",
  });
}

function resolveXaiOauthMetadataFallback(modelId: string) {
  if (modelId === "grok-build") {
    return resolveXaiCatalogEntry("grok-build-0.1");
  }
  return resolveXaiCatalogEntry(modelId);
}

function isXaiOAuthResponsesModel(row: unknown, fallback: ModelDefinitionConfig | undefined) {
  const modelId =
    readLiveModelCatalogStringField(row, "id") ?? readLiveModelCatalogStringField(row, "model");
  if (modelId && (XAI_IMAGE_MODELS as readonly string[]).includes(modelId)) {
    return false;
  }
  const backend =
    readLiveModelCatalogStringField(row, "api_backend") ??
    readLiveModelCatalogStringField(row, "apiBackend") ??
    readLiveModelCatalogStringField(row, "backend");
  if (backend) {
    const normalizedBackend = backend.toLowerCase();
    return (
      normalizedBackend === "responses" ||
      normalizedBackend === "chat" ||
      normalizedBackend === "language"
    );
  }
  return Boolean(fallback);
}

function buildXaiOauthModelFromLiveRow(row: unknown): ModelDefinitionConfig | undefined {
  const modelId =
    readLiveModelCatalogStringField(row, "id") ?? readLiveModelCatalogStringField(row, "model");
  if (!modelId) {
    return undefined;
  }
  const fallback = resolveXaiOauthMetadataFallback(modelId);
  if (!isXaiOAuthResponsesModel(row, fallback)) {
    return undefined;
  }
  const contextWindow =
    readLiveModelCatalogPositiveSafeIntegerField(row, ["context_window", "contextWindow"]) ??
    fallback?.contextWindow ??
    XAI_DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    readLiveModelCatalogPositiveSafeIntegerField(row, [
      "max_completion_tokens",
      "maxCompletionTokens",
    ]) ??
    fallback?.maxTokens ??
    XAI_DEFAULT_MAX_TOKENS;
  const supportsReasoningEffort =
    readLiveModelCatalogBooleanField(row, "supports_reasoning_effort") ??
    readLiveModelCatalogBooleanField(row, "supportsReasoningEffort");
  const reasoning =
    supportsReasoningEffort === true ||
    fallback?.reasoning === true ||
    XAI_GROK_OAUTH_REASONING_MODEL_IDS.has(modelId);

  return {
    id: modelId,
    name: readLiveModelCatalogStringField(row, "name") ?? fallback?.name ?? modelId,
    api: "openai-responses",
    baseUrl: XAI_GROK_OAUTH_BASE_URL,
    reasoning,
    input: fallback?.input ?? ["text"],
    cost: fallback?.cost ?? XAI_UNKNOWN_MODEL_COST,
    contextWindow,
    maxTokens,
    ...(fallback?.compat ? { compat: fallback.compat } : {}),
    ...(fallback?.thinkingLevelMap ? { thinkingLevelMap: fallback.thinkingLevelMap } : {}),
  };
}

export async function buildLiveXaiOAuthProvider(params: {
  discoveryApiKey: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const fallback = buildXaiOAuthFallbackProvider();
  const provider = await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: XAI_GROK_OAUTH_MODELS_ENDPOINT,
    providerConfig: {
      baseUrl: fallback.baseUrl,
      api: fallback.api,
      auth: fallback.auth,
    },
    models: fallback.models,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    ttlMs: XAI_GROK_OAUTH_MODELS_CACHE_TTL_MS,
    auditContext: "xai-grok-oauth-model-discovery",
    cacheKeyParts: [
      PROVIDER_ID,
      "grok-oauth-model-rows",
      XAI_GROK_OAUTH_MODELS_ENDPOINT,
      params.discoveryApiKey,
    ],
    projectRows: (rows) =>
      rows
        .map(buildXaiOauthModelFromLiveRow)
        .filter((model): model is ModelDefinitionConfig => Boolean(model)),
  });
  return provider;
}
