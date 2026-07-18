/**
 * Chutes model catalog, static model definitions, and dynamic model discovery.
 */
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asPositiveSafeInteger,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isChutesModelDiscoveryTestEnvironment } from "./model-discovery-env.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const log = createSubsystemLogger("chutes-models");

const CHUTES_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "chutes",
  catalog: manifest.modelCatalog.providers.chutes,
});

/** Base URL for Chutes OpenAI-compatible inference. */
export const CHUTES_BASE_URL = CHUTES_MANIFEST_PROVIDER.baseUrl;
/** Default Chutes model id used for onboarding. */
export const CHUTES_DEFAULT_MODEL_ID = "zai-org/GLM-5-TEE";
/** Default Chutes model ref used for onboarding. */
export const CHUTES_DEFAULT_MODEL_REF = `chutes/${CHUTES_DEFAULT_MODEL_ID}`;

const CHUTES_DEFAULT_CONTEXT_WINDOW = 128000;
const CHUTES_DEFAULT_MAX_TOKENS = 4096;

/** Bundled fallback Chutes model catalog, normalized from the plugin manifest. */
export const CHUTES_MODEL_CATALOG = CHUTES_MANIFEST_PROVIDER.models;

/** Adds Chutes provider compat metadata to one model catalog entry. */
export function buildChutesModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsUsageInStreaming: false,
    },
  };
}

interface ChutesModelEntry {
  id: string;
  name?: string;
  supported_features?: string[];
  input_modalities?: string[];
  context_length?: number;
  max_output_length?: number;
  pricing?: {
    prompt?: number;
    completion?: number;
  };
  [key: string]: unknown;
}

const CACHE_TTL = 5 * 60 * 1000;

async function fetchChutesModelRows(accessToken?: string): Promise<readonly unknown[]> {
  return await getCachedLiveProviderModelRows({
    providerId: "chutes",
    endpoint: `${CHUTES_BASE_URL}/models`,
    discoveryApiKey: accessToken,
    timeoutMs: 10_000,
    ttlMs: CACHE_TTL,
    buildRequestHeaders: ({ discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
    }),
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(CHUTES_BASE_URL),
    auditContext: "chutes-model-discovery",
  });
}

/** Discovers Chutes models dynamically, falling back to the bundled static catalog. */
export async function discoverChutesModels(accessToken?: string): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = normalizeOptionalString(accessToken) ?? "";

  if (isChutesModelDiscoveryTestEnvironment()) {
    return CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition);
  }

  const staticCatalog = () => CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition);

  try {
    const data = await fetchChutesModelRows(trimmedKey || undefined);
    if (data.length === 0) {
      log.warn("No models in response, using static catalog");
      return staticCatalog();
    }

    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of data as ChutesModelEntry[]) {
      const id = normalizeOptionalString(entry?.id) ?? "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);

      const lowerId = normalizeLowercaseStringOrEmpty(id);
      const isReasoning =
        entry.supported_features?.includes("reasoning") ||
        lowerId.includes("r1") ||
        lowerId.includes("thinking") ||
        lowerId.includes("reason") ||
        lowerId.includes("tee");

      const input: Array<"text" | "image"> = (entry.input_modalities || ["text"]).filter(
        (i): i is "text" | "image" => i === "text" || i === "image",
      );

      models.push({
        id,
        name: id,
        reasoning: isReasoning,
        input,
        cost: {
          input: entry.pricing?.prompt || 0,
          output: entry.pricing?.completion || 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: asPositiveSafeInteger(entry.context_length) ?? CHUTES_DEFAULT_CONTEXT_WINDOW,
        maxTokens: asPositiveSafeInteger(entry.max_output_length) ?? CHUTES_DEFAULT_MAX_TOKENS,
        compat: {
          supportsUsageInStreaming: false,
        },
      });
    }

    if (models.length === 0) {
      return staticCatalog();
    }
    return models;
  } catch (error) {
    if (error instanceof LiveModelCatalogHttpError && error.status === 401 && trimmedKey) {
      return await discoverChutesModels(undefined);
    }
    if (
      error instanceof LiveModelCatalogHttpError &&
      error.status !== 401 &&
      error.status !== 503
    ) {
      log.warn(`GET /v1/models failed: HTTP ${error.status}, using static catalog`);
      return staticCatalog();
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticCatalog();
  }
}
