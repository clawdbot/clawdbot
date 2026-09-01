// Builds provider catalog entries from plugin manifest metadata.
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type {
  ModelCatalogCost,
  ModelCatalogMediaInputConfig,
  ModelCatalogModel,
  ModelCatalogTieredCost,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { copyRecordEntries } from "../shared/safe-record.js";
import type { ProviderCatalogContext, ProviderCatalogResult, ProviderPlugin } from "./types.js";

function addApiKeyToProvider(
  provider: ModelProviderConfig,
  apiKey: string,
): (ModelProviderConfig & { apiKey: string }) | undefined {
  try {
    return { ...provider, apiKey };
  } catch {
    return undefined;
  }
}

/** Finds a provider catalog template entry by normalized provider and template id. */
export function findCatalogTemplate(params: {
  entries: ReadonlyArray<{ provider: string; id: string }>;
  providerId: string;
  templateIds: readonly string[];
}) {
  return params.templateIds
    .map((templateId) =>
      params.entries.find(
        (entry) =>
          normalizeProviderId(entry.provider) === normalizeProviderId(params.providerId) &&
          normalizeLowercaseStringOrEmpty(entry.id) === normalizeLowercaseStringOrEmpty(templateId),
      ),
    )
    .find((entry) => entry !== undefined);
}

/** Builds a provider catalog result for providers that share one API key. */
export async function buildSingleProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
}): Promise<ProviderCatalogResult> {
  const providerId = normalizeProviderId(params.providerId);
  const apiKey = params.ctx.resolveProviderApiKey(providerId).apiKey;
  if (!apiKey) {
    return null;
  }

  const explicitProvider =
    params.allowExplicitBaseUrl && params.ctx.config.models?.providers
      ? Object.entries(params.ctx.config.models.providers).find(
          ([configuredProviderId]) => normalizeProviderId(configuredProviderId) === providerId,
        )?.[1]
      : undefined;
  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl) ?? "";

  return {
    provider: {
      ...(await params.buildProvider()),
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      apiKey,
    },
  };
}

/** Builds a multi-provider catalog result backed by one provider API key. */
export async function buildPairedProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProviders: () =>
    | Record<string, ModelProviderConfig>
    | Promise<Record<string, ModelProviderConfig>>;
}): Promise<ProviderCatalogResult> {
  const apiKey = params.ctx.resolveProviderApiKey(normalizeProviderId(params.providerId)).apiKey;
  if (!apiKey) {
    return null;
  }

  const providers = await params.buildProviders();
  return {
    providers: Object.fromEntries(
      copyRecordEntries<ModelProviderConfig>(providers).flatMap(([id, provider]) => {
        const providerWithApiKey = addApiKeyToProvider(provider, apiKey);
        return providerWithApiKey ? [[id, providerWithApiKey]] : [];
      }),
    ),
  };
}

function countRawManifestCatalogModels(catalog: unknown): number | undefined {
  if (!catalog || typeof catalog !== "object") {
    return undefined;
  }
  // SAFETY: Only the unknown models field is read; Array.isArray validates it next.
  const models = (catalog as { models?: unknown }).models;
  return Array.isArray(models) ? models.length : undefined;
}

/** Reads a provider's normalized manifest default as a fully qualified model ref. */
export function readManifestProviderDefaultModelRef(
  manifest: unknown,
  providerId: string,
): string | undefined {
  // SAFETY: Optional reads locate metadata without trusting its model value.
  const catalog = (manifest as { modelCatalog?: { providers?: Record<string, unknown> } })
    ?.modelCatalog?.providers?.[providerId];
  const defaultModel = normalizeOptionalString(
    // SAFETY: The field stays unknown until normalizeOptionalString validates it.
    (catalog as { defaultModel?: unknown })?.defaultModel,
  );
  return defaultModel ? buildModelCatalogRef(providerId, defaultModel) : undefined;
}

function cloneManifestCatalogTieredCost(
  tier: ModelCatalogTieredCost,
): NonNullable<ModelDefinitionConfig["cost"]["tieredPricing"]>[number] {
  return {
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead,
    cacheWrite: tier.cacheWrite,
    range: tier.range.length === 1 ? [tier.range[0]] : [tier.range[0], tier.range[1]],
  };
}

function cloneManifestCatalogCost(cost: ModelCatalogCost): ModelDefinitionConfig["cost"] {
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? 0,
    cacheWrite: cost.cacheWrite ?? 0,
    ...(cost.tieredPricing
      ? { tieredPricing: cost.tieredPricing.map(cloneManifestCatalogTieredCost) }
      : {}),
  };
}

function buildManifestCatalogModelInput(model: ModelCatalogModel): ModelDefinitionConfig["input"] {
  if (model.input?.includes("document")) {
    throw new Error(
      `Manifest modelCatalog row ${model.id} uses unsupported runtime input document`,
    );
  }
  return model.input?.filter((item): item is "text" | "image" => item !== "document") ?? ["text"];
}

function cloneManifestCatalogMediaInput(
  mediaInput?: ModelCatalogMediaInputConfig,
): ModelDefinitionConfig["mediaInput"] | undefined {
  if (!mediaInput?.image) {
    return undefined;
  }
  return {
    image: { ...mediaInput.image },
  };
}

function buildManifestCatalogModel(
  providerId: string,
  model: ModelCatalogModel,
): ModelDefinitionConfig {
  if (model.contextWindow === undefined) {
    throw new Error(`Manifest modelCatalog row ${model.id} is missing contextWindow`);
  }
  if (model.maxTokens === undefined) {
    throw new Error(`Manifest modelCatalog row ${model.id} is missing maxTokens`);
  }
  const id = normalizeConfiguredProviderCatalogModelId(providerId, model.id, new Map());
  return {
    id,
    name: model.name ?? id,
    ...(model.api ? { api: model.api } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    reasoning: model.reasoning ?? false,
    input: buildManifestCatalogModelInput(model),
    cost: cloneManifestCatalogCost(model.cost ?? {}),
    contextWindow: model.contextWindow,
    ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
    ...(model.mediaInput ? { mediaInput: cloneManifestCatalogMediaInput(model.mediaInput) } : {}),
  };
}

/**
 * Converts a plugin manifest modelCatalog provider into runtime provider config.
 */
export function buildManifestModelProviderConfig(params: {
  /** Provider id that owns the manifest catalog rows. */
  providerId: string;
  /** Raw manifest modelCatalog provider block to normalize into runtime config. */
  catalog: unknown;
}): ModelProviderConfig {
  const catalog = normalizeModelCatalog(
    { providers: { [params.providerId]: params.catalog } },
    { ownedProviders: new Set([params.providerId]) },
  )?.providers?.[params.providerId];
  if (!catalog) {
    throw new Error(`Missing modelCatalog.providers.${params.providerId}`);
  }
  if (!catalog.baseUrl) {
    throw new Error(`Missing modelCatalog.providers.${params.providerId}.baseUrl`);
  }
  const rawModelCount = countRawManifestCatalogModels(params.catalog);
  if (rawModelCount !== undefined && rawModelCount !== catalog.models.length) {
    throw new Error(`Invalid modelCatalog.providers.${params.providerId}.models`);
  }
  return {
    baseUrl: catalog.baseUrl,
    ...(catalog.api ? { api: catalog.api } : {}),
    ...(catalog.headers ? { headers: { ...catalog.headers } } : {}),
    models: catalog.models.map((model) => buildManifestCatalogModel(params.providerId, model)),
  };
}

export type ManifestProviderCatalogSurface = {
  id: string;
  label: string;
  catalog: unknown;
};

export type ManifestProviderCatalogEntry = {
  id: string;
  label: string;
  baseUrl: string;
  models: ModelProviderConfig["models"];
  buildProvider: () => ModelProviderConfig;
};

/** Projects an ordered family of manifest catalogs into static provider and model surfaces. */
export function buildManifestProviderCatalogFamily(params: {
  surfaces: readonly ManifestProviderCatalogSurface[];
  docsPath?: string;
}) {
  const entries: ManifestProviderCatalogEntry[] = params.surfaces.map((surface) => {
    const buildProvider = () =>
      buildManifestModelProviderConfig({
        providerId: surface.id,
        catalog: surface.catalog,
      });
    const provider = buildProvider();
    return {
      id: surface.id,
      label: surface.label,
      baseUrl: provider.baseUrl,
      models: provider.models,
      buildProvider,
    };
  });
  const staticDiscovery: ProviderPlugin[] = entries.map(({ id, label, buildProvider }) => ({
    id,
    label,
    docsPath: params.docsPath ?? "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildProvider() }),
    },
  }));

  return {
    entries,
    staticDiscovery,
    staticCatalog: async () => ({
      providers: Object.fromEntries(entries.map(({ id, buildProvider }) => [id, buildProvider()])),
    }),
    augmentModelCatalog: () =>
      entries.flatMap(({ id: provider, models }) =>
        models.map((entry) => ({
          provider,
          id: entry.id,
          name: entry.name,
          reasoning: entry.reasoning,
          input: [...entry.input],
          contextWindow: entry.contextWindow,
        })),
      ),
  };
}
