// Xai provider module implements model/runtime integration.
import {
  buildLiveModelProviderConfig,
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
// The Grok OAuth proxy answers /v1/responses with HTTP 426 unless the caller reports a
// Grok CLI client version at or above xAI's floor; /v1/models stays ungated, so discovery
// looks healthy while every inference turn fails. Raise when xAI raises the minimum.
const XAI_GROK_OAUTH_HEADERS = {
  "x-grok-client-version": "0.1.202",
} satisfies ModelProviderConfig["headers"];
const XAI_MODELS_CACHE_TTL_MS = 60_000;
const XAI_GROK_OAUTH_MODELS_CACHE_TTL_MS = 60_000;
// Composer emits replayable Responses reasoning, but the OAuth catalog omits that capability.
// Keep it classified here or the stream wrapper will omit encrypted reasoning from replay.
const XAI_GROK_OAUTH_REASONING_MODEL_IDS = new Set(["grok-composer-2.5-fast"]);
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

/**
 * The client version is a contract with xAI's own Grok proxy, and provider-level
 * headers survive an operator's `models.providers.xai.baseUrl` override (config
 * wins over the catalog baseUrl when the two merge). Withhold the header unless
 * the effective route is still the canonical proxy so a custom endpoint never
 * receives vendor identity it did not ask for.
 */
function resolveGrokOAuthHeaders(configuredBaseUrl?: string): ModelProviderConfig["headers"] {
  const effectiveBaseUrl = configuredBaseUrl?.trim().replace(/\/+$/, "");
  return !effectiveBaseUrl || effectiveBaseUrl === XAI_GROK_OAUTH_BASE_URL
    ? XAI_GROK_OAUTH_HEADERS
    : undefined;
}

function buildXaiOAuthFallbackProvider(configuredBaseUrl?: string): ModelProviderConfig {
  const headers = resolveGrokOAuthHeaders(configuredBaseUrl);
  return {
    baseUrl: XAI_GROK_OAUTH_BASE_URL,
    api: "openai-responses",
    auth: "oauth",
    ...(headers ? { headers } : {}),
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
  const supportsReasoningEffort =
    readLiveModelBoolean(row, "supports_reasoning_effort") ??
    readLiveModelBoolean(row, "supportsReasoningEffort");
  const reasoning =
    supportsReasoningEffort === true ||
    fallback?.reasoning === true ||
    XAI_GROK_OAUTH_REASONING_MODEL_IDS.has(modelId);

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
  /** Operator-configured xAI base URL, used to gate the Grok client-version header. */
  configuredBaseUrl?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  // Destructure the fallback instead of picking fields: the live path must carry
  // every provider-level setting the fallback declares (notably the Grok client
  // version header), or discovery success would silently drop it.
  const { models, ...providerConfig } = buildXaiOAuthFallbackProvider(params.configuredBaseUrl);
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: XAI_GROK_OAUTH_MODELS_ENDPOINT,
    providerConfig,
    models,
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
}
