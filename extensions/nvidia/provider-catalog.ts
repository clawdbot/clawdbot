// Nvidia provider module implements model/runtime integration.
import { lookup as dnsLookup } from "node:dns/promises";
import {
  getCachedLiveProviderModelRows,
  readLiveModelCatalogStringField,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";

const FEATURED_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FEATURED_MODEL_FETCH_TIMEOUT_MS = 10_000;
const FEATURED_MODEL_MAX_ROWS = 32;
const FEATURED_MODEL_MAX_ID_LENGTH = 200;
const FEATURED_MODEL_MAX_NAME_LENGTH = 200;
const FEATURED_MODEL_MAX_CONTEXT_WINDOW = 10_000_000;
const FEATURED_MODEL_MAX_OUTPUT_TOKENS = 1_000_000;
const FEATURED_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
const NVIDIA_ULTRA_DEFAULT_PARAMS = {
  chat_template_kwargs: {
    enable_thinking: false,
    force_nonempty_content: true,
  },
} as const;
const DEPRECATED_NVIDIA_MODEL_IDS = new Set<string>(
  manifest.modelCatalog.providers.nvidia.models
    .filter((model) => "status" in model && model.status === "deprecated")
    .map((model) => model.id),
);

type NvidiaFeaturedModel = {
  model: string;
  "model-name": string;
  context: number;
  "max-output": number;
};

type DnsLookupOptions = {
  all?: boolean;
  family?: number;
  hints?: number;
  order?: "ipv4first" | "ipv6first" | "verbatim";
  verbatim?: boolean;
};

const lookupNvidiaFeaturedModelHostname = (async (
  hostname: string,
  options?: number | DnsLookupOptions,
) => {
  if (typeof options === "object" && options !== null) {
    return await dnsLookup(hostname, { ...options, family: 4 });
  }
  return await dnsLookup(hostname, { family: 4 });
}) as LookupFn;

export function buildNvidiaProvider(): ModelProviderConfig {
  const provider = {
    ...buildManifestModelProviderConfig({
      providerId: "nvidia",
      catalog: manifest.modelCatalog.providers.nvidia,
    }),
    apiKey: "NVIDIA_API_KEY",
  };
  return {
    ...provider,
    models: applyNvidiaModelDefaults(provider.models ?? []),
  };
}

export function buildSelectableNvidiaProvider(): ModelProviderConfig {
  const provider = buildNvidiaProvider();
  return {
    ...provider,
    models: filterSelectableNvidiaModels(provider.models ?? []),
  };
}

export async function buildLiveNvidiaProvider(): Promise<ModelProviderConfig> {
  const provider = buildNvidiaProvider();
  return {
    ...provider,
    models:
      (await loadNvidiaLiveModels(provider.models)) ??
      filterSelectableNvidiaModels(provider.models),
  };
}

export async function buildSelectableLiveNvidiaProvider(): Promise<ModelProviderConfig> {
  const provider = buildNvidiaProvider();
  return {
    ...provider,
    models: (await loadNvidiaLiveModels(provider.models)) ?? [],
  };
}

async function loadNvidiaLiveModels(
  bundledModels: ModelDefinitionConfig[],
): Promise<ModelDefinitionConfig[] | null> {
  try {
    const [rows, featured] = await Promise.all([
      getCachedLiveProviderModelRows({
        providerId: "nvidia",
        endpoint: NVIDIA_MODELS_URL,
        requireHttps: true,
        readRows: (payload) => {
          if (!isRecord(payload) || !Array.isArray(payload.data)) {
            throw new Error("NVIDIA model inventory must contain data[]");
          }
          if (payload.data.some((row) => !readLiveModelCatalogStringField(row, "id"))) {
            throw new Error("NVIDIA model inventory contains a row without an id");
          }
          return payload.data;
        },
      }),
      loadNvidiaFeaturedModels(),
    ]);
    const available = new Set(rows.map((row) => readLiveModelCatalogStringField(row, "id")));
    const known = new Map(bundledModels.map((model) => [model.id, model]));
    // /models includes embeddings and other non-chat endpoints without capabilities.
    // Only exact known chat metadata or the vendor's featured chat rows are selectable.
    const ranked = new Map(
      (featured ?? []).map((model) => {
        const bundled = known.get(model.id);
        return [
          model.id,
          bundled
            ? {
                ...bundled,
                name: model.name,
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
              }
            : model,
        ];
      }),
    );
    for (const [id, model] of known) {
      if (!ranked.has(id)) {
        ranked.set(id, model);
      }
    }
    // A fresh inventory can restore a republished legacy id, but a stale featured
    // recommendation cannot restore an id the inference endpoint no longer lists.
    return [...ranked.values()].filter((model) => available.has(model.id));
  } catch {
    return null;
  }
}

async function loadNvidiaFeaturedModels(): Promise<ModelDefinitionConfig[] | null> {
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: "nvidia",
      endpoint: NVIDIA_FEATURED_MODELS_URL,
      timeoutMs: FEATURED_MODEL_FETCH_TIMEOUT_MS,
      ttlMs: FEATURED_MODEL_CACHE_TTL_MS,
      requireHttps: true,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(NVIDIA_FEATURED_MODELS_URL),
      // The featured catalog is an NVIDIA-owned CloudFront URL. Some resolvers
      // stall for seconds on the default all-family lookup; IPv4 pinning keeps
      // the guarded fixed-host fetch on the fast path.
      lookupFn: lookupNvidiaFeaturedModelHostname,
      auditContext: "nvidia-featured-model-catalog",
      shouldCacheRows: (modelRows) => parseNvidiaFeaturedModels(modelRows) !== null,
      readRows: (payload) => {
        if (!payload || typeof payload !== "object") {
          return [];
        }
        const featuredRows = (payload as { "featured-models"?: unknown })["featured-models"];
        return Array.isArray(featuredRows) ? featuredRows : [];
      },
    });
    return parseNvidiaFeaturedModels(rows);
  } catch {
    return null;
  }
}

function parseNvidiaFeaturedModels(rows: readonly unknown[]): ModelDefinitionConfig[] | null {
  const models = rows
    .slice(0, FEATURED_MODEL_MAX_ROWS)
    .map(parseNvidiaFeaturedModel)
    .filter((model) => model !== null);
  return models.length > 0 ? models : null;
}

function applyNvidiaModelDefaults(models: ModelDefinitionConfig[]): ModelDefinitionConfig[] {
  return models.map((model) =>
    model.id === NVIDIA_DEFAULT_MODEL_ID
      ? {
          ...model,
          params: {
            ...model.params,
            chat_template_kwargs: {
              ...NVIDIA_ULTRA_DEFAULT_PARAMS.chat_template_kwargs,
              ...(isRecord(model.params?.chat_template_kwargs)
                ? model.params.chat_template_kwargs
                : {}),
            },
          },
        }
      : model,
  );
}

function filterSelectableNvidiaModels(models: ModelDefinitionConfig[]): ModelDefinitionConfig[] {
  return models.filter((model) => !DEPRECATED_NVIDIA_MODEL_IDS.has(model.id));
}

function parseNvidiaFeaturedModel(row: unknown): ModelDefinitionConfig | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const entry = row as Partial<NvidiaFeaturedModel>;
  if (
    typeof entry.model !== "string" ||
    typeof entry["model-name"] !== "string" ||
    !isBoundedPositiveInteger(entry.context, FEATURED_MODEL_MAX_CONTEXT_WINDOW) ||
    !isBoundedPositiveInteger(entry["max-output"], FEATURED_MODEL_MAX_OUTPUT_TOKENS)
  ) {
    return null;
  }
  const id = normalizeNvidiaFeaturedModelId(entry.model);
  const name = normalizeFeaturedModelName(entry["model-name"]);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    contextWindow: entry.context,
    maxTokens: entry["max-output"],
    cost: { ...FEATURED_MODEL_COST },
    compat: {
      requiresStringContent: true,
    },
  };
}

function normalizeNvidiaFeaturedModelId(model: string): string {
  const trimmed = model.trim();
  if (
    !trimmed ||
    trimmed.length > FEATURED_MODEL_MAX_ID_LENGTH ||
    hasWhitespaceOrControlCharacter(trimmed)
  ) {
    return "";
  }
  return trimmed.includes("/") ? trimmed : `nvidia/${trimmed}`;
}

function normalizeFeaturedModelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > FEATURED_MODEL_MAX_NAME_LENGTH || hasControlCharacter(trimmed)) {
    return "";
  }
  return trimmed;
}

function isBoundedPositiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
}

function hasWhitespaceOrControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isAsciiWhitespaceOrControlCharacter(char)) {
      return true;
    }
  }
  return false;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isControlCharacter(char)) {
      return true;
    }
  }
  return false;
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 31 || code === 127;
}

function isAsciiWhitespaceOrControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 32 || code === 127;
}
