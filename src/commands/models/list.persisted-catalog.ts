/** Reads persisted generated catalogs without constructing a model registry. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry, ModelInputType } from "../../agents/model-catalog.types.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogsReadOnly,
} from "../../agents/plugin-model-catalog.js";
import { MODEL_APIS, type ModelApi } from "../../config/types.models.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

const modelApis = new Set<string>(MODEL_APIS);
const modelInputs = new Set<ModelInputType>(["text", "image", "audio", "video", "document"]);

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readModelApi(value: unknown): ModelApi | undefined {
  const api = readString(value);
  return api && modelApis.has(api) ? (api as ModelApi) : undefined;
}

function readModelInput(value: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const input = value.filter(
    (item): item is ModelInputType =>
      typeof item === "string" && modelInputs.has(item as ModelInputType),
  );
  return input.length > 0 ? input : undefined;
}

function parseProviderModels(params: {
  providerId: string;
  provider: unknown;
}): ModelCatalogEntry[] {
  if (!isRecord(params.provider) || !Array.isArray(params.provider.models)) {
    return [];
  }
  const providerApi = readModelApi(params.provider.api);
  const providerBaseUrl = readString(params.provider.baseUrl);
  return params.provider.models.flatMap((model) => {
    if (!isRecord(model)) {
      return [];
    }
    const id = readString(model.id);
    const api = readModelApi(model.api) ?? providerApi;
    if (!id || !api) {
      return [];
    }
    const baseUrl = readString(model.baseUrl) ?? providerBaseUrl;
    const input = readModelInput(model.input);
    const contextWindow = readPositiveNumber(model.contextWindow);
    const contextTokens = readPositiveNumber(model.contextTokens);
    return [
      {
        id,
        name: readString(model.name) ?? id,
        provider: normalizeProviderId(params.providerId),
        api,
        ...(baseUrl ? { baseUrl } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextTokens !== undefined ? { contextTokens } : {}),
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
        ...(input ? { input } : {}),
      },
    ];
  });
}

/** Loads valid provider-owned rows from the agent's generated catalog cache. */
export function loadPersistedListCatalogEntries(params: {
  agentDir: string;
  providerIds: ReadonlySet<string>;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const catalog of loadPersistedPluginModelCatalogsReadOnly(params.agentDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(catalog.contents) as unknown;
    } catch {
      continue;
    }
    if (
      !isRecord(parsed) ||
      !isGeneratedPluginModelCatalog(parsed) ||
      !isRecord(parsed.providers)
    ) {
      continue;
    }
    const providers = filterGeneratedPluginModelCatalogProviders({
      catalogPluginId: catalog.pluginId,
      parsedCatalog: parsed,
      pluginMetadataSnapshot: params.metadataSnapshot,
      providers: parsed.providers,
    });
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!params.providerIds.has(normalizeProviderId(providerId))) {
        continue;
      }
      entries.push(...parseProviderModels({ providerId, provider }));
    }
  }
  return entries;
}
