// Opencode Go provider module implements model/runtime integration.
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

const PROVIDER_ID = "opencode-go";

const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";
const OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS = new Set([
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
]);
const OPENCODE_GO_MODELS_ENDPOINT = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_UPSTREAM_CATALOG_ENDPOINT = "https://models.opencode.ai/api.json";
const OPENCODE_GO_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_GO_MODELS_CACHE_TTL_MS = 60_000;
type OpencodeGoModelDefinition = ModelDefinitionConfig & {
  provider: typeof PROVIDER_ID;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

const OPENCODE_GO_MANIFEST_PROVIDER = manifest.modelCatalog.providers[PROVIDER_ID];
const OPENCODE_GO_SEED_MODELS = OPENCODE_GO_MANIFEST_PROVIDER.models.map((model) => {
  const inheritedTransport = {
    ...model,
    provider: PROVIDER_ID,
    api: "api" in model ? model.api : OPENCODE_GO_MANIFEST_PROVIDER.api,
    baseUrl: "baseUrl" in model ? model.baseUrl : OPENCODE_GO_MANIFEST_PROVIDER.baseUrl,
  };
  // SAFETY: Bundled manifest rows supply model metadata, and inherited provider transport is filled above.
  const hydrated = inheritedTransport as OpencodeGoModelDefinition;
  // SAFETY: Compatibility normalization preserves the hydrated model's provider, transport, and input shape.
  return normalizeModelCompat(hydrated) as OpencodeGoModelDefinition;
});
const OPENCODE_GO_SEED_MODEL_BY_ID = new Map(
  OPENCODE_GO_SEED_MODELS.map((model) => [model.id.toLowerCase(), model]),
);
const OPENCODE_GO_MODEL_BY_ID = new Map(OPENCODE_GO_SEED_MODEL_BY_ID);
const OPENCODE_GO_SEED_MODEL_STATUS = new Map<string, "deprecated" | "preview">(
  manifest.modelCatalog.providers[PROVIDER_ID].models.flatMap((model) =>
    "status" in model && (model.status === "deprecated" || model.status === "preview")
      ? [[model.id, model.status] as const]
      : [],
  ),
);
const OPENCODE_GO_MODEL_STATUS = new Map(OPENCODE_GO_SEED_MODEL_STATUS);

function listStaticOpencodeGoModels(): OpencodeGoModelDefinition[] {
  return OPENCODE_GO_SEED_MODELS.filter((model) => !OPENCODE_GO_MODEL_STATUS.has(model.id));
}

function cacheUpstreamOpencodeGoModels(catalog: UpstreamProviderCatalog): void {
  const currentModels = new Map(
    OPENCODE_GO_SEED_MODELS.map((model) => [model.id.toLowerCase(), model]),
  );
  const currentStatuses = new Map(OPENCODE_GO_SEED_MODEL_STATUS);
  for (const upstreamModel of Object.values(catalog.models)) {
    const projected = projectUpstreamProviderCatalogModel({
      providerId: PROVIDER_ID,
      provider: catalog,
      model: upstreamModel,
      anthropicBaseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      defaultBaseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    });
    if (!projected) {
      continue;
    }
    const normalized = normalizeModelCompat({
      ...projected,
      ...(projected.api === "anthropic-messages" && projected.id.startsWith("qwen")
        ? { compat: { ...projected.compat, thinkingFormat: "qwen" as const } }
        : {}),
    });
    // SAFETY: The shared projector validates transport and limits; normalization preserves those model fields.
    const model = normalized as OpencodeGoModelDefinition;
    currentModels.set(model.id.toLowerCase(), model);
    if (upstreamModel.status === "deprecated") {
      currentStatuses.set(model.id, "deprecated");
    } else {
      currentStatuses.delete(model.id);
    }
  }
  OPENCODE_GO_MODEL_BY_ID.clear();
  for (const [id, model] of currentModels) {
    OPENCODE_GO_MODEL_BY_ID.set(id, model);
  }
  OPENCODE_GO_MODEL_STATUS.clear();
  for (const [id, status] of currentStatuses) {
    OPENCODE_GO_MODEL_STATUS.set(id, status);
  }
}

type FetchOpencodeGoLiveModelIdsParams = {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

export function buildStaticOpencodeGoProviderConfig(apiKey?: string): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    models: listStaticOpencodeGoModels(),
  };
}

export async function resolveOpencodeGoStarterModel(params: {
  apiKey: string;
  preferredModelRef: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const liveModelIds = await fetchLiveProviderModelIds({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_GO_MODELS_ENDPOINT,
    discoveryApiKey: params.apiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_GO_MODELS_TIMEOUT_MS,
    auditContext: "opencode-go-onboarding-model-discovery",
  });
  const preferredModelId = params.preferredModelRef.replace(`${PROVIDER_ID}/`, "");
  return liveModelIds.includes(preferredModelId) ? params.preferredModelRef : undefined;
}

export async function buildOpencodeGoLiveProviderConfig(
  params: FetchOpencodeGoLiveModelIdsParams = {},
): Promise<ModelProviderConfig> {
  const fallbackModels = listStaticOpencodeGoModels();
  if (!params.apiKey && !params.discoveryApiKey) {
    return buildStaticOpencodeGoProviderConfig();
  }
  try {
    const upstream = await getCachedUpstreamProviderCatalog({
      endpoint: OPENCODE_UPSTREAM_CATALOG_ENDPOINT,
      providerId: PROVIDER_ID,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
    });
    if (upstream) {
      cacheUpstreamOpencodeGoModels(upstream);
    }
  } catch {
    // Keep the trusted offline seed usable when upstream metadata is unavailable.
  }
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_GO_MODELS_ENDPOINT,
    providerConfig: {
      api: "openai-completions",
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    },
    models: fallbackModels,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_GO_MODELS_TIMEOUT_MS,
    ttlMs: OPENCODE_GO_MODELS_CACHE_TTL_MS,
    auditContext: "opencode-go-model-discovery",
    projectRows: (rows) => {
      const seen = new Set<string>();
      const models: OpencodeGoModelDefinition[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          continue;
        }
        const object = "object" in row ? row.object : undefined;
        if (object !== undefined && object !== "model") {
          continue;
        }
        const id = "id" in row ? row.id : undefined;
        const modelId = typeof id === "string" ? id.trim().toLowerCase() : "";
        if (!modelId || seen.has(modelId) || OPENCODE_GO_MODEL_STATUS.has(modelId)) {
          continue;
        }
        seen.add(modelId);
        const model = OPENCODE_GO_MODEL_BY_ID.get(modelId);
        if (model) {
          models.push(model);
        }
      }
      return models;
    },
  });
}

export function listOpencodeGoModelCatalogEntries(): ModelCatalogEntry[] {
  return [...OPENCODE_GO_MODEL_BY_ID.values()].map((model) => {
    const entry: ModelCatalogEntry = {
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
    };
    const status = OPENCODE_GO_MODEL_STATUS.get(model.id);
    if (status) {
      entry.status = status;
    }
    return entry;
  });
}

export function resolveOpencodeGoModel(modelId: string): ProviderRuntimeModel | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  return OPENCODE_GO_SEED_MODEL_BY_ID.get(normalizedModelId);
}

export function isOpencodeGoKimiNoReasoningModelId(modelId: unknown): boolean {
  return (
    typeof modelId === "string" &&
    OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS.has(modelId.trim().toLowerCase())
  );
}

export function normalizeOpencodeGoResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  if (!isOpencodeGoKimiNoReasoningModelId(model.id)) {
    return undefined;
  }
  const compat =
    model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
      ? model.compat
      : undefined;
  if (!model.reasoning && !compat?.supportsReasoningEffort) {
    return undefined;
  }
  return {
    ...model,
    reasoning: false,
    compat: {
      ...compat,
      supportsReasoningEffort: false,
    },
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeOpencodeGoBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENCODE_GO_OPENAI_BASE_URL) {
    return OPENCODE_GO_OPENAI_BASE_URL;
  }
  if (normalized === OPENCODE_GO_ANTHROPIC_BASE_URL) {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go") {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go/v1") {
    return params.api === "anthropic-messages"
      ? OPENCODE_GO_ANTHROPIC_BASE_URL
      : OPENCODE_GO_OPENAI_BASE_URL;
  }
  return undefined;
}
