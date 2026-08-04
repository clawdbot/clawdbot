import { isDeepStrictEqual } from "node:util";
import type {
  ModelCatalog,
  NormalizedModelCatalogRow,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  modelTransportRoutesMatch,
  resolveUniqueCatalogModelRoute,
} from "../../../agents/model-compat-catalog.js";
import { getRecord, type LegacyConfigRule } from "../../../config/legacy.shared.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";
// Doctor intentionally reads shipped catalogs only; remote rows must not influence migrations.
import { planManifestModelCatalogRows } from "../../../model-catalog/manifest-planner.js";
import { listOpenClawPluginManifestMetadata } from "../../../plugins/manifest-metadata-scan.js";

const STALE_CONTEXT_WINDOW_FIXES: Record<string, { stale: number; correct: number }> = {
  "deepseek/deepseek-v4-flash": { stale: 200_000, correct: 1_000_000 },
  "xai/grok-4.20-0309-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-0309-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-beta-latest-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-beta-latest-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-experimental-beta-0304-reasoning": {
    stale: 2_000_000,
    correct: 1_000_000,
  },
  "xai/grok-4.20-experimental-beta-0304-non-reasoning": {
    stale: 2_000_000,
    correct: 1_000_000,
  },
  "xai/grok-4.20-reasoning": { stale: 2_000_000, correct: 1_000_000 },
  "xai/grok-4.20-non-reasoning": { stale: 2_000_000, correct: 1_000_000 },
} as const;
const DEAD_MODEL_COMPAT_KEYS = ["nativeWebSearchTool", "requiresMistralToolIds"] as const;

type ModelCompatOverrideState = { dead: number; divergent: number; matching: number };

function normalizedCatalogModelKey(provider: string, modelId: string): string {
  // Keep doctor identity aligned with runtime catalog lookup and merge keys,
  // which intentionally treat provider/model ids case-insensitively.
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedId = modelId.trim().toLowerCase();
  const providerPrefix = `${normalizedProvider}/`;
  return `${normalizedProvider}::${normalizedId.startsWith(providerPrefix) ? normalizedId.slice(providerPrefix.length) : normalizedId}`;
}

// Manifest metadata is process-stable; plugin installs/reloads restart the owning process.
const modelCompatCatalogRowsByProvider = new Map<string, readonly NormalizedModelCatalogRow[]>();
let modelCompatCatalogPlugins:
  | Array<{ id: string; modelCatalog: ModelCatalog; providers: string[] }>
  | undefined;

function getModelCompatCatalogPlugins() {
  modelCompatCatalogPlugins ??= listOpenClawPluginManifestMetadata().flatMap(({ manifest }) => {
    const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
    const modelCatalog = getRecord(manifest.modelCatalog);
    if (!id || !modelCatalog) {
      return [];
    }
    return [
      {
        id,
        providers: Array.isArray(manifest.providers)
          ? manifest.providers.filter((value): value is string => typeof value === "string")
          : [],
        modelCatalog: modelCatalog as ModelCatalog,
      },
    ];
  });
  return modelCompatCatalogPlugins;
}

function buildConfiguredProviderCatalogRows(
  providers: Record<string, unknown>,
): Map<string, NormalizedModelCatalogRow[]> {
  const rows = new Map<string, NormalizedModelCatalogRow[]>();
  for (const providerId of Object.keys(providers)) {
    const normalizedProviderId = normalizeProviderId(providerId);
    let providerRows = modelCompatCatalogRowsByProvider.get(normalizedProviderId);
    if (!providerRows) {
      providerRows = planManifestModelCatalogRows({
        registry: { plugins: getModelCompatCatalogPlugins() },
        providerFilter: normalizedProviderId,
      }).rows;
      modelCompatCatalogRowsByProvider.set(normalizedProviderId, providerRows);
    }
    for (const row of providerRows) {
      const key = normalizedCatalogModelKey(row.provider, row.id);
      const variants = rows.get(key) ?? [];
      variants.push(row);
      rows.set(key, variants);
    }
  }
  return rows;
}

function inspectModelCompatOverrides(
  providersValue: unknown,
  onEntry?: (params: {
    catalogRow?: NormalizedModelCatalogRow;
    compat: Record<string, unknown>;
    model: Record<string, unknown>;
    modelIndex: number;
    provider: Record<string, unknown>;
    providerId: string;
    state: ModelCompatOverrideState;
  }) => void,
): ModelCompatOverrideState {
  const providers = getRecord(providersValue);
  const total = { dead: 0, divergent: 0, matching: 0 };
  if (!providers) {
    return total;
  }
  const hasCompat = Object.values(providers).some((providerValue) => {
    const models = getRecord(providerValue)?.models;
    return (
      Array.isArray(models) &&
      models.some((modelValue) => Boolean(getRecord(getRecord(modelValue)?.compat)))
    );
  });
  if (!hasCompat) {
    return total;
  }
  const catalogRows = buildConfiguredProviderCatalogRows(providers);
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    const models = provider?.models;
    if (!provider || !Array.isArray(models)) {
      continue;
    }
    for (const [modelIndex, modelValue] of models.entries()) {
      const model = getRecord(modelValue);
      const compat = getRecord(model?.compat);
      const modelId = typeof model?.id === "string" ? model.id : "";
      if (!model || !compat || !modelId) {
        continue;
      }
      const state = { dead: 0, divergent: 0, matching: 0 };
      for (const key of DEAD_MODEL_COMPAT_KEYS) {
        if (Object.hasOwn(compat, key)) {
          state.dead += 1;
        }
      }
      const configuredRoute = {
        api: model.api ?? provider.api,
        baseUrl: model.baseUrl ?? provider.baseUrl,
      };
      const catalogRow = resolveUniqueCatalogModelRoute(
        catalogRows.get(normalizedCatalogModelKey(providerId, modelId)),
        configuredRoute,
      );
      const catalogRouteMatches = catalogRow !== undefined;
      if (catalogRouteMatches) {
        const catalogCompat = catalogRow.compat ?? {};
        for (const [key, value] of Object.entries(compat)) {
          if ((DEAD_MODEL_COMPAT_KEYS as readonly string[]).includes(key)) {
            continue;
          }
          if (isDeepStrictEqual(value, catalogCompat[key as keyof typeof catalogCompat])) {
            state.matching += 1;
          } else {
            state.divergent += 1;
          }
        }
      }
      total.dead += state.dead;
      total.divergent += state.divergent;
      total.matching += state.matching;
      onEntry?.({ catalogRow, compat, model, modelIndex, provider, providerId, state });
    }
  }
  return total;
}

export const MODEL_COMPAT_CATALOG_RULES: LegacyConfigRule[] = [
  {
    path: ["models", "providers"],
    message:
      'nativeWebSearchTool and requiresMistralToolIds are unused and retired; run "openclaw doctor --fix" to remove them.',
    match: (value) => inspectModelCompatOverrides(value).dead > 0,
  },
  {
    path: ["models", "providers"],
    message:
      'Catalog-known model compat values are provider-owned; run "openclaw doctor --fix" to remove matching config overrides.',
    match: (value) => inspectModelCompatOverrides(value).matching > 0,
  },
  {
    path: ["models", "providers"],
    message:
      "Catalog-known model compat differs from the provider catalog and was preserved for review. Use a distinct custom route when the endpoint really has different capabilities.",
    match: (value) => inspectModelCompatOverrides(value).divergent > 0,
  },
];

export function migrateModelCompatCatalogOwnership(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  const providers = getRecord(getRecord(raw.models)?.providers);
  inspectModelCompatOverrides(
    providers,
    ({ catalogRow, compat, model, modelIndex, provider, providerId }) => {
      const removed: string[] = [];
      for (const key of DEAD_MODEL_COMPAT_KEYS) {
        if (Object.hasOwn(compat, key)) {
          delete compat[key];
          removed.push(key);
        }
      }
      if (
        catalogRow &&
        modelTransportRoutesMatch(catalogRow, {
          api: model.api ?? provider.api ?? catalogRow.api,
          baseUrl: model.baseUrl ?? provider.baseUrl ?? catalogRow.baseUrl,
        })
      ) {
        const catalogCompat = catalogRow.compat ?? {};
        for (const [key, value] of Object.entries(compat)) {
          if (isDeepStrictEqual(value, catalogCompat[key as keyof typeof catalogCompat])) {
            delete compat[key];
            removed.push(key);
          }
        }
      }
      if (removed.length === 0) {
        return;
      }
      if (Object.keys(compat).length === 0) {
        delete model.compat;
      }
      changes.push(
        `Removed models.providers.${providerId}.models.${modelIndex}.compat catalog/dead overrides: ${removed.toSorted().join(", ")}.`,
      );
    },
  );
}

export function resolveStaleContextWindowFix(params: {
  providerId: string;
  modelId: string;
  contextWindow: number;
}): { stale: number; correct: number } | undefined {
  const providerId = params.providerId.trim().toLowerCase();
  const modelId = params.modelId.trim().toLowerCase();
  const providerPrefix = `${providerId}/`;
  const unprefixedModelId = modelId.startsWith(providerPrefix)
    ? modelId.slice(providerPrefix.length)
    : modelId;
  const scopedModelId = `${providerId}/${unprefixedModelId}`;
  const fix = STALE_CONTEXT_WINDOW_FIXES[scopedModelId];
  return fix && params.contextWindow === fix.stale ? fix : undefined;
}

export function hasStaleContextWindowValue(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord) {
    return false;
  }
  for (const [providerId, provider] of Object.entries(providersRecord)) {
    const models = getRecord(provider)?.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      const modelRecord = getRecord(model);
      const modelId = typeof modelRecord?.id === "string" ? modelRecord.id : undefined;
      const contextWindow = modelRecord?.contextWindow;
      if (!modelId || typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
        continue;
      }
      if (resolveStaleContextWindowFix({ providerId, modelId, contextWindow })) {
        return true;
      }
    }
  }
  return false;
}

export function hasInvalidThinkingFormat(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord) {
    return false;
  }
  for (const provider of Object.values(providersRecord)) {
    const models = getRecord(provider)?.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      const compat = getRecord(getRecord(model)?.compat);
      const thinkingFormat = compat?.thinkingFormat;
      if (typeof thinkingFormat === "string" && !isModelThinkingFormat(thinkingFormat)) {
        return true;
      }
    }
  }
  return false;
}
