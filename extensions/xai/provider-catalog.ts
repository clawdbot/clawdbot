// Xai provider module implements model/runtime integration.
import {
  buildLiveModelProviderConfig,
  getCachedLiveProviderModelRows,
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
} from "./model-definitions.js";

const PROVIDER_ID = "xai";
const XAI_MODELS_ENDPOINT = `${XAI_BASE_URL}/models`;
const XAI_GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_GROK_OAUTH_MODELS_ENDPOINT = `${XAI_GROK_OAUTH_BASE_URL}/models`;
const XAI_MODELS_CACHE_TTL_MS = 60_000;
const XAI_GROK_OAUTH_MODELS_CACHE_TTL_MS = 60_000;
const XAI_UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} satisfies ModelDefinitionConfig["cost"];

export function buildXaiProvider(
  api: ModelProviderConfig["api"] = "openai-responses",
): ModelProviderConfig {
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

export async function buildLiveXaiProvider(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
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

function readLiveModelString(row: unknown, key: string): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readLiveModelPositiveInteger(row: unknown, keys: readonly string[]): number | undefined {
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

function readLiveModelBoolean(row: unknown, key: string): boolean | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function resolveXaiOauthMetadataFallback(modelId: string) {
  if (modelId === "grok-build") {
    return resolveXaiCatalogEntry("grok-build-0.1");
  }
  return resolveXaiCatalogEntry(modelId);
}

function isXaiOAuthResponsesModel(row: unknown, fallback: ModelDefinitionConfig | undefined) {
  const modelId = readLiveModelString(row, "id") ?? readLiveModelString(row, "model");
  if (modelId && (XAI_IMAGE_MODELS as readonly string[]).includes(modelId)) {
    return false;
  }
  const backend =
    readLiveModelString(row, "api_backend") ??
    readLiveModelString(row, "apiBackend") ??
    readLiveModelString(row, "backend");
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
  const modelId = readLiveModelString(row, "id") ?? readLiveModelString(row, "model");
  if (!modelId) {
    return undefined;
  }
  const fallback = resolveXaiOauthMetadataFallback(modelId);
  if (!isXaiOAuthResponsesModel(row, fallback)) {
    return undefined;
  }
  const contextWindow =
    readLiveModelPositiveInteger(row, ["context_window", "contextWindow"]) ??
    fallback?.contextWindow ??
    XAI_DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    readLiveModelPositiveInteger(row, ["max_completion_tokens", "maxCompletionTokens"]) ??
    fallback?.maxTokens ??
    XAI_DEFAULT_MAX_TOKENS;
  const reasoning =
    readLiveModelBoolean(row, "supports_reasoning_effort") ??
    readLiveModelBoolean(row, "supportsReasoningEffort") ??
    fallback?.reasoning ??
    false;

  return {
    id: modelId,
    name: readLiveModelString(row, "name") ?? fallback?.name ?? modelId,
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
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: XAI_GROK_OAUTH_MODELS_ENDPOINT,
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
    });
    const models = rows
      .map(buildXaiOauthModelFromLiveRow)
      .filter((model): model is ModelDefinitionConfig => Boolean(model));
    if (models.length > 0) {
      return {
        baseUrl: XAI_GROK_OAUTH_BASE_URL,
        api: "openai-responses",
        auth: "oauth",
        models,
      };
    }
  } catch {
    // Grok subscription discovery is advisory. If the proxy is unavailable,
    // preserve the OAuth proxy transport instead of publishing API-key rows.
  }
  return buildXaiOAuthFallbackProvider();
}
