import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLiveModelProviderConfig,
  fetchLiveProviderModelIds,
  getCachedUpstreamProviderCatalog,
  listProviderCatalogSnapshotEntries,
  projectProviderCatalogSnapshotRows,
  projectUpstreamProviderCatalogSnapshot,
  type LiveModelCatalogFetchGuard,
  type ProviderCatalogSnapshot,
  type ProjectedUpstreamProviderCatalogModel as OpencodeGoModelDefinition,
  type UpstreamProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
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
const OPENCODE_GO_MANIFEST_PROVIDER = manifest.modelCatalog.providers[PROVIDER_ID];
const OPENCODE_GO_SEED_CATALOG: ProviderCatalogSnapshot = new Map(
  OPENCODE_GO_MANIFEST_PROVIDER.models.map((row) => {
    const inheritedTransport = {
      ...row,
      provider: PROVIDER_ID,
      api: "api" in row ? row.api : OPENCODE_GO_MANIFEST_PROVIDER.api,
      baseUrl: "baseUrl" in row ? row.baseUrl : OPENCODE_GO_MANIFEST_PROVIDER.baseUrl,
    };
    // SAFETY: Bundled rows and inherited transport supply the complete runtime model shape.
    const hydrated = inheritedTransport as OpencodeGoModelDefinition;
    // SAFETY: Normalization preserves the hydrated model's transport and input shape.
    const model = normalizeModelCompat(hydrated) as OpencodeGoModelDefinition;
    return [
      model.id.toLowerCase(),
      {
        model,
        ...("status" in row && (row.status === "deprecated" || row.status === "preview")
          ? { status: row.status }
          : {}),
      },
    ];
  }),
);
let opencodeGoCatalog = OPENCODE_GO_SEED_CATALOG;

function listStaticOpencodeGoModels(): OpencodeGoModelDefinition[] {
  return [...OPENCODE_GO_SEED_CATALOG.values()]
    .filter(({ model }) => !opencodeGoCatalog.get(model.id)?.status)
    .map(({ model }) => model);
}

function cacheUpstreamOpencodeGoModels(catalog: UpstreamProviderCatalog): void {
  opencodeGoCatalog = projectUpstreamProviderCatalogSnapshot({
    providerId: PROVIDER_ID,
    provider: catalog,
    seed: OPENCODE_GO_SEED_CATALOG,
    anthropicBaseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
    defaultBaseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    decorateModel: (model) =>
      model.api === "anthropic-messages" && model.id.startsWith("qwen")
        ? { ...model, compat: { ...model.compat, thinkingFormat: "qwen" } }
        : model,
  });
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
    discoveryMode: "strict",
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_GO_MODELS_ENDPOINT,
    providerConfig: {
      api: "openai-completions",
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    },
    models: listStaticOpencodeGoModels(),
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_GO_MODELS_TIMEOUT_MS,
    ttlMs: OPENCODE_GO_MODELS_CACHE_TTL_MS,
    auditContext: "opencode-go-model-discovery",
    projectRows: (rows) => projectProviderCatalogSnapshotRows(rows, opencodeGoCatalog),
  });
}

export function listOpencodeGoModelCatalogEntries(): ModelCatalogEntry[] {
  return listProviderCatalogSnapshotEntries(opencodeGoCatalog);
}

export function resolveOpencodeGoModel(modelId: string): ProviderRuntimeModel | undefined {
  // Public upstream metadata does not establish another account's Go entitlement.
  return OPENCODE_GO_SEED_CATALOG.get(modelId.trim().toLowerCase())?.model;
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
