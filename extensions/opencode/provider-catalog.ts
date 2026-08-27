import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLiveModelProviderConfig,
  fetchLiveProviderModelIds,
  getCachedUpstreamProviderCatalog,
  projectUpstreamProviderCatalogModel,
  type LiveModelCatalogFetchGuard,
  type UpstreamProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "opencode";
const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";
const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
const OPENCODE_UPSTREAM_CATALOG_ENDPOINT = "https://models.opencode.ai/api.json";
const OPENCODE_ZEN_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_ZEN_MODELS_CACHE_TTL_MS = 60_000;

type OpencodeZenModelDefinition = ModelDefinitionConfig & {
  provider: typeof PROVIDER_ID;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

type FetchOpencodeZenLiveModelIdsParams = {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

type OpencodeZenModelLifecycle = {
  status?: "deprecated";
  replacedBy?: string;
};

const OPENCODE_ZEN_MANIFEST_PROVIDER = manifest.modelCatalog.providers.opencode;
const OPENCODE_ZEN_SEED_MODELS = OPENCODE_ZEN_MANIFEST_PROVIDER.models.map((model) =>
  normalizeModelCompat({
    ...model,
    provider: PROVIDER_ID,
    api: model.api ?? OPENCODE_ZEN_MANIFEST_PROVIDER.api,
    baseUrl: model.baseUrl ?? OPENCODE_ZEN_MANIFEST_PROVIDER.baseUrl,
  } as OpencodeZenModelDefinition),
) as OpencodeZenModelDefinition[];
const OPENCODE_ZEN_MODEL_BY_ID = new Map(
  OPENCODE_ZEN_SEED_MODELS.map((model) => [model.id, model]),
);
const OPENCODE_ZEN_MODEL_LIFECYCLE_BY_ID = new Map<string, OpencodeZenModelLifecycle>(
  OPENCODE_ZEN_MANIFEST_PROVIDER.models.map((model) => [
    model.id,
    {
      ...("status" in model && model.status === "deprecated"
        ? { status: "deprecated" as const }
        : {}),
      ...("replacedBy" in model && typeof model.replacedBy === "string"
        ? { replacedBy: model.replacedBy }
        : {}),
    },
  ]),
);

function isActiveOpencodeZenModel(model: OpencodeZenModelDefinition): boolean {
  return OPENCODE_ZEN_MODEL_LIFECYCLE_BY_ID.get(model.id)?.status !== "deprecated";
}

function listStaticOpencodeZenModels(): OpencodeZenModelDefinition[] {
  return OPENCODE_ZEN_SEED_MODELS.filter(isActiveOpencodeZenModel);
}

function cacheUpstreamOpencodeZenModels(catalog: UpstreamProviderCatalog): void {
  OPENCODE_ZEN_MODEL_BY_ID.clear();
  OPENCODE_ZEN_MODEL_LIFECYCLE_BY_ID.clear();
  for (const model of OPENCODE_ZEN_SEED_MODELS) {
    OPENCODE_ZEN_MODEL_BY_ID.set(model.id, model);
  }
  for (const upstreamModel of Object.values(catalog.models)) {
    const projected = projectUpstreamProviderCatalogModel({
      providerId: PROVIDER_ID,
      provider: catalog,
      model: upstreamModel,
      anthropicBaseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL,
      defaultBaseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
    });
    if (!projected) {
      continue;
    }
    const model = normalizeModelCompat(projected) as OpencodeZenModelDefinition;
    OPENCODE_ZEN_MODEL_BY_ID.set(model.id.toLowerCase(), model);
    if (upstreamModel.status === "deprecated") {
      OPENCODE_ZEN_MODEL_LIFECYCLE_BY_ID.set(model.id, { status: "deprecated" });
    }
  }
}

export async function prepareOpencodeZenModel(params: {
  modelId: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ProviderRuntimeModel | undefined> {
  const catalog = await getCachedUpstreamProviderCatalog({
    endpoint: OPENCODE_UPSTREAM_CATALOG_ENDPOINT,
    providerId: PROVIDER_ID,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
  });
  if (!catalog) {
    return undefined;
  }
  cacheUpstreamOpencodeZenModels(catalog);
  return resolveOpencodeZenModel(params.modelId);
}

export function buildStaticOpencodeZenProviderConfig(apiKey?: string): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    models: listStaticOpencodeZenModels(),
  };
}

export async function resolveOpencodeZenStarterModel(params: {
  apiKey: string;
  preferredModelRef: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const liveModelIds = await fetchLiveProviderModelIds({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
    discoveryApiKey: params.apiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
    auditContext: "opencode-zen-onboarding-model-discovery",
  });
  const preferredModelId = params.preferredModelRef.replace(`${PROVIDER_ID}/`, "");
  return liveModelIds.includes(preferredModelId) ? params.preferredModelRef : undefined;
}

function readLiveModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  if ("object" in row && row.object !== undefined && row.object !== "model") {
    return undefined;
  }
  if (!("id" in row) || typeof row.id !== "string") {
    return undefined;
  }
  return row.id.trim().toLowerCase() || undefined;
}

function projectOpencodeZenLiveModels(rows: readonly unknown[]): OpencodeZenModelDefinition[] {
  const seen = new Set<string>();
  const models: OpencodeZenModelDefinition[] = [];
  for (const row of rows) {
    const modelId = readLiveModelId(row);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    const model = OPENCODE_ZEN_MODEL_BY_ID.get(modelId);
    if (model && isActiveOpencodeZenModel(model)) {
      models.push(model);
    }
  }
  return models;
}

export async function buildOpencodeZenLiveProviderConfig(
  params: FetchOpencodeZenLiveModelIdsParams = {},
): Promise<ModelProviderConfig> {
  const fallbackModels = listStaticOpencodeZenModels();
  if (!params.apiKey && !params.discoveryApiKey) {
    return buildStaticOpencodeZenProviderConfig();
  }
  try {
    const upstream = await getCachedUpstreamProviderCatalog({
      endpoint: OPENCODE_UPSTREAM_CATALOG_ENDPOINT,
      providerId: PROVIDER_ID,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
    });
    if (upstream) {
      cacheUpstreamOpencodeZenModels(upstream);
    }
  } catch {
    // The offline seed remains usable when authoritative metadata is unavailable.
  }
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
    providerConfig: {
      api: "openai-completions",
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
    },
    models: fallbackModels,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
    ttlMs: OPENCODE_ZEN_MODELS_CACHE_TTL_MS,
    auditContext: "opencode-zen-model-discovery",
    projectRows: projectOpencodeZenLiveModels,
  });
}

export function listOpencodeZenModelCatalogEntries(): ModelCatalogEntry[] {
  return Array.from(OPENCODE_ZEN_MODEL_BY_ID.values(), (model) => {
    const lifecycle = OPENCODE_ZEN_MODEL_LIFECYCLE_BY_ID.get(model.id);
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      contextTokens: model.contextTokens,
      compat: model.compat,
      ...(lifecycle?.status ? { status: lifecycle.status } : {}),
      ...(lifecycle?.replacedBy ? { replacedBy: lifecycle.replacedBy } : {}),
    };
  });
}

export function resolveOpencodeZenModel(modelId: string): ProviderRuntimeModel | undefined {
  return OPENCODE_ZEN_MODEL_BY_ID.get(modelId.trim().toLowerCase());
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeOpencodeZenBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  const isAnthropicRoute = params.api === "anthropic-messages";
  if (normalized === OPENCODE_ZEN_ANTHROPIC_BASE_URL) {
    return isAnthropicRoute ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  if (normalized === OPENCODE_ZEN_OPENAI_BASE_URL) {
    return isAnthropicRoute ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  return undefined;
}
