/**
 * Chutes model catalog, static model definitions, and dynamic model discovery.
 */
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { buildLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelDefinition } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asPositiveSafeInteger,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const CHUTES_MANIFEST_CATALOG = manifest.modelCatalog.providers.chutes;

/** Base URL for Chutes OpenAI-compatible inference. */
export const CHUTES_BASE_URL = CHUTES_MANIFEST_CATALOG.baseUrl;

const CHUTES_DEFAULT_CONTEXT_WINDOW = 128000;
const CHUTES_DEFAULT_MAX_TOKENS = 4096;

function decorateChutesModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsUsageInStreaming: false,
    },
  };
}

/** Bundled fallback Chutes model catalog, normalized from the plugin manifest. */
export const CHUTES_MODEL_CATALOG: ModelDefinitionConfig[] = CHUTES_MANIFEST_CATALOG.models.map(
  buildManifestModelDefinition({
    providerId: "chutes",
    catalog: CHUTES_MANIFEST_CATALOG,
    decorate: decorateChutesModelDefinition,
  }),
);

interface ChutesModelEntry {
  id: string;
  name?: string;
  supported_features?: string[];
  input_modalities?: string[];
  context_length?: number;
  max_model_len?: number;
  max_output_length?: number;
  pricing?: {
    prompt?: number;
    completion?: number;
    input_cache_read?: number;
  };
  [key: string]: unknown;
}

const CACHE_TTL = 5 * 60 * 1000;

function projectChutesModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const seen = new Set<string>();
  const models: ModelDefinitionConfig[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const entry = row as ChutesModelEntry;
    const id = normalizeOptionalString(entry.id) ?? "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const lowerId = normalizeLowercaseStringOrEmpty(id);
    models.push({
      id,
      name: id,
      reasoning:
        entry.supported_features?.includes("reasoning") ||
        lowerId.includes("r1") ||
        lowerId.includes("thinking") ||
        lowerId.includes("reason") ||
        lowerId.includes("tee"),
      input: (entry.input_modalities || ["text"]).filter(
        (item): item is "text" | "image" => item === "text" || item === "image",
      ),
      cost: {
        input: entry.pricing?.prompt || 0,
        output: entry.pricing?.completion || 0,
        cacheRead: entry.pricing?.input_cache_read || 0,
        cacheWrite: 0,
      },
      contextWindow:
        asPositiveSafeInteger(entry.context_length) ??
        asPositiveSafeInteger(entry.max_model_len) ??
        CHUTES_DEFAULT_CONTEXT_WINDOW,
      maxTokens: asPositiveSafeInteger(entry.max_output_length) ?? CHUTES_DEFAULT_MAX_TOKENS,
      compat: { supportsUsageInStreaming: false },
    });
  }
  return models;
}

/** Discovers Chutes models dynamically, falling back to the bundled static catalog. */
export async function discoverChutesModels(accessToken?: string): Promise<ModelDefinitionConfig[]> {
  const provider = await buildLiveModelProviderConfig({
    providerId: "chutes",
    endpoint: `${CHUTES_BASE_URL}/models`,
    providerConfig: { baseUrl: CHUTES_BASE_URL, api: "openai-completions" },
    models: structuredClone(CHUTES_MODEL_CATALOG),
    discoveryApiKey: normalizeOptionalString(accessToken),
    timeoutMs: 10_000,
    ttlMs: CACHE_TTL,
    buildRequestHeaders: ({ discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
    }),
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(CHUTES_BASE_URL),
    auditContext: "chutes-model-discovery",
    fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
    fallbackToAnonymousOnUnauthorized: true,
    projectRows: projectChutesModels,
  });
  return provider.models;
}
