// Nvidia provider module implements model/runtime integration.
import { lookup as dnsLookup } from "node:dns/promises";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  fetchWithSsrFGuard,
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b";
export const NVIDIA_FEATURED_MODELS_URL =
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

type NvidiaFeaturedModel = {
  model: string;
  "model-name": string;
  context: number;
  "max-output": number;
};

let featuredModelCache:
  | {
      expiresAtMs: number;
      models: ModelDefinitionConfig[];
    }
  | undefined;
let featuredModelRequest: Promise<ModelDefinitionConfig[] | null> | undefined;

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

export async function buildLiveNvidiaProvider(): Promise<ModelProviderConfig> {
  const provider = buildNvidiaProvider();
  const featuredModels = await loadNvidiaFeaturedModels();
  if (!featuredModels || featuredModels.length === 0) {
    return provider;
  }
  return {
    ...provider,
    models: applyNvidiaModelDefaults(featuredModels),
  };
}

export async function buildSelectableLiveNvidiaProvider(): Promise<ModelProviderConfig> {
  const provider = buildNvidiaProvider();
  const featuredModels = await loadNvidiaFeaturedModels();
  if (!featuredModels || featuredModels.length === 0) {
    return {
      ...provider,
      models: [],
    };
  }
  return {
    ...provider,
    models: applyNvidiaModelDefaults(featuredModels),
  };
}

export function clearNvidiaFeaturedModelCacheForTests() {
  featuredModelCache = undefined;
  featuredModelRequest = undefined;
}

async function loadNvidiaFeaturedModels(): Promise<ModelDefinitionConfig[] | null> {
  const now = Date.now();
  if (
    featuredModelCache &&
    isFutureDateTimestampMs(featuredModelCache.expiresAtMs, { nowMs: now })
  ) {
    return featuredModelCache.models;
  }
  featuredModelCache = undefined;
  featuredModelRequest ??= fetchNvidiaFeaturedModels();
  try {
    const models = await featuredModelRequest;
    if (models && models.length > 0) {
      const expiresAtMs = resolveExpiresAtMsFromDurationMs(FEATURED_MODEL_CACHE_TTL_MS, {
        nowMs: now,
      });
      if (expiresAtMs !== undefined) {
        featuredModelCache = {
          expiresAtMs,
          models,
        };
      }
    }
    return models;
  } finally {
    featuredModelRequest = undefined;
  }
}

async function fetchNvidiaFeaturedModels(): Promise<ModelDefinitionConfig[] | null> {
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: NVIDIA_FEATURED_MODELS_URL,
      timeoutMs: FEATURED_MODEL_FETCH_TIMEOUT_MS,
      requireHttps: true,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(NVIDIA_FEATURED_MODELS_URL),
      // The featured catalog is an NVIDIA-owned CloudFront URL. Some resolvers
      // stall for seconds on the default all-family lookup; IPv4 pinning keeps
      // the guarded fixed-host fetch on the fast path.
      lookupFn: lookupNvidiaFeaturedModelHostname,
      auditContext: "nvidia-featured-model-catalog",
    });
    try {
      if (!response.ok) {
        return null;
      }
      return parseNvidiaFeaturedModels(await response.json());
    } finally {
      await release();
    }
  } catch {
    return null;
  }
}

function parseNvidiaFeaturedModels(payload: unknown): ModelDefinitionConfig[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const rows = (payload as { "featured-models"?: unknown })["featured-models"];
  if (!Array.isArray(rows)) {
    return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
