import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import {
  shouldSuppressBuiltInModel,
  shouldSuppressBuiltInModelFromManifest,
} from "../../agents/model-suppression.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { ModelListAuthIndex } from "./list.auth-index.js";
import type { ListRowModel } from "./list.model-row.js";
import { toModelRow } from "./list.model-row.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";
import { isLocalBaseUrl, modelKey } from "./shared.js";

type ConfiguredByKey = Map<string, ConfiguredEntry>;
type ModelCatalogModule = typeof import("../../agents/model-catalog.js");
type ModelResolverModule = typeof import("../../agents/pi-embedded-runner/model.js");
type ProviderCatalogModule = typeof import("./list.provider-catalog.js");

type RowFilter = {
  provider?: string;
  local?: boolean;
};

export type RowBuilderContext = {
  cfg: OpenClawConfig;
  agentDir: string;
  authIndex: ModelListAuthIndex;
  availableKeys?: Set<string>;
  configuredByKey: ConfiguredByKey;
  discoveredKeys: Set<string>;
  filter: RowFilter;
  skipRuntimeModelSuppression?: boolean;
};

const modelCatalogModuleLoader = createLazyImportLoader<ModelCatalogModule>(
  () => import("../../agents/model-catalog.js"),
);
const modelResolverModuleLoader = createLazyImportLoader<ModelResolverModule>(
  () => import("../../agents/pi-embedded-runner/model.js"),
);
const providerCatalogModuleLoader = createLazyImportLoader<ProviderCatalogModule>(
  () => import("./list.provider-catalog.js"),
);

function loadModelCatalogModule(): Promise<ModelCatalogModule> {
  return modelCatalogModuleLoader.load();
}

function loadModelResolverModule(): Promise<ModelResolverModule> {
  return modelResolverModuleLoader.load();
}

function loadProviderCatalogModule(): Promise<ProviderCatalogModule> {
  return providerCatalogModuleLoader.load();
}

function matchesRowFilter(filter: RowFilter, model: { provider: string; baseUrl?: string }) {
  if (filter.provider && normalizeProviderId(model.provider) !== filter.provider) {
    return false;
  }
  if (filter.local && !isLocalBaseUrl(model.baseUrl ?? "")) {
    return false;
  }
  return true;
}

async function buildRow(params: {
  model: ListRowModel;
  key: string;
  context: RowBuilderContext;
  allowProviderAvailabilityFallback?: boolean;
}): Promise<ModelRow> {
  const configured = params.context.configuredByKey.get(params.key);
  const shouldResolveProviderAuth =
    params.context.availableKeys === undefined || params.allowProviderAvailabilityFallback === true;
  return toModelRow({
    model: params.model,
    key: params.key,
    tags: configured ? Array.from(configured.tags) : [],
    aliases: configured?.aliases ?? [],
    availableKeys: params.context.availableKeys,
    allowProviderAvailabilityFallback: params.allowProviderAvailabilityFallback ?? false,
    hasAuthForProvider: shouldResolveProviderAuth
      ? (provider) => params.context.authIndex.hasProviderAuth(provider)
      : undefined,
  });
}

function shouldSuppressListModel(params: {
  model: { provider: string; id: string; baseUrl?: string };
  context: RowBuilderContext;
}): boolean {
  if (params.context.skipRuntimeModelSuppression) {
    return shouldSuppressBuiltInModelFromManifest({
      provider: params.model.provider,
      id: params.model.id,
      config: params.context.cfg,
    });
  }
  return shouldSuppressBuiltInModel({
    provider: params.model.provider,
    id: params.model.id,
    baseUrl: params.model.baseUrl,
    config: params.context.cfg,
  });
}

async function appendVisibleRow(params: {
  rows: ModelRow[];
  model: ListRowModel;
  key: string;
  context: RowBuilderContext;
  seenKeys?: Set<string>;
  allowProviderAvailabilityFallback?: boolean;
  skipSuppression?: boolean;
}): Promise<boolean> {
  if (params.seenKeys?.has(params.key)) {
    return false;
  }
  if (!matchesRowFilter(params.context.filter, params.model)) {
    return false;
  }
  if (
    !params.skipSuppression &&
    shouldSuppressListModel({ model: params.model, context: params.context })
  ) {
    return false;
  }
  params.rows.push(
    await buildRow({
      model: params.model,
      key: params.key,
      context: params.context,
      allowProviderAvailabilityFallback: params.allowProviderAvailabilityFallback,
    }),
  );
  params.seenKeys?.add(params.key);
  return true;
}

function resolveConfiguredModelInput(params: {
  model: Partial<ModelDefinitionConfig>;
}): Array<"text" | "image"> {
  const input = Array.isArray(params.model.input)
    ? params.model.input.filter(
        (item): item is "text" | "image" => item === "text" || item === "image",
      )
    : [];
  return input.length > 0 ? input : ["text"];
}

function toConfiguredProviderListModel(params: {
  provider: string;
  providerConfig: Partial<ModelProviderConfig>;
  model: Partial<ModelDefinitionConfig> & Pick<ModelDefinitionConfig, "id">;
}): ListRowModel {
  return {
    provider: params.provider,
    id: params.model.id,
    name: params.model.name ?? params.model.id,
    baseUrl: params.model.baseUrl ?? params.providerConfig.baseUrl,
    input: resolveConfiguredModelInput({ model: params.model }),
    contextWindow: params.model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: params.model.contextTokens,
  };
}

function toManifestCatalogListModel(row: NormalizedModelCatalogRow): ListRowModel {
  return {
    provider: row.provider,
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    input: [...row.input],
    contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
  };
}

function shouldListConfiguredProviderModel(params: {
  providerConfig: Partial<ModelProviderConfig>;
  model: Partial<ModelDefinitionConfig>;
}): boolean {
  return params.providerConfig.api !== undefined || params.model.api !== undefined;
}

function findConfiguredProviderModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): ListRowModel | undefined {
  const providerConfig = params.cfg.models?.providers?.[params.provider];
  const configuredModel = providerConfig?.models?.find((model) => model.id === params.modelId);
  if (!providerConfig || !configuredModel) {
    return undefined;
  }
  return toConfiguredProviderListModel({
    provider: params.provider,
    providerConfig,
    model: configuredModel,
  });
}

function toFallbackConfiguredListModel(entry: ConfiguredEntry, cfg: OpenClawConfig): ListRowModel {
  return (
    findConfiguredProviderModel({
      cfg,
      provider: entry.ref.provider,
      modelId: entry.ref.model,
    }) ?? {
      provider: entry.ref.provider,
      id: entry.ref.model,
      name: entry.ref.model,
      input: ["text"],
      contextWindow: DEFAULT_CONTEXT_TOKENS,
    }
  );
}

export async function appendDiscoveredRows(params: {
  rows: ModelRow[];
  models: Model<Api>[];
  modelRegistry?: ModelRegistry;
  context: RowBuilderContext;
  resolveWithRegistry?: boolean;
  skipSuppression?: boolean;
}): Promise<Set<string>> {
  const seenKeys = new Set<string>();
  const modelResolver =
    params.modelRegistry && params.resolveWithRegistry !== false
      ? (await loadModelResolverModule()).resolveModelWithRegistry
      : undefined;
  const sorted = [...params.models].toSorted((a, b) => {
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) {
      return providerCompare;
    }
    return a.id.localeCompare(b.id);
  });

  for (const model of sorted) {
    const key = modelKey(model.provider, model.id);
    const resolvedModel =
      params.modelRegistry && modelResolver
        ? modelResolver({
            provider: model.provider,
            modelId: model.id,
            modelRegistry: params.modelRegistry,
            cfg: params.context.cfg,
            agentDir: params.context.agentDir,
          })
        : undefined;
    const rowModel =
      resolvedModel && modelKey(resolvedModel.provider, resolvedModel.id) === key
        ? resolvedModel
        : model;
    await appendVisibleRow({
      rows: params.rows,
      model: rowModel,
      key,
      context: params.context,
      seenKeys,
      skipSuppression: params.skipSuppression,
    });
  }

  return seenKeys;
}

export async function appendConfiguredProviderRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  for (const [provider, providerConfig] of Object.entries(
    params.context.cfg.models?.providers ?? {},
  )) {
    for (const configuredModel of providerConfig.models ?? []) {
      if (!shouldListConfiguredProviderModel({ providerConfig, model: configuredModel })) {
        continue;
      }
      const key = modelKey(provider, configuredModel.id);
      const model = toConfiguredProviderListModel({
        provider,
        providerConfig,
        model: configuredModel,
      });
      await appendVisibleRow({
        rows: params.rows,
        model,
        key,
        context: params.context,
        seenKeys: params.seenKeys,
        allowProviderAvailabilityFallback: !params.context.discoveredKeys.has(key),
      });
    }
  }
}

export async function appendModelCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
  catalogRows: readonly NormalizedModelCatalogRow[];
}): Promise<number> {
  let appended = 0;
  for (const catalogRow of params.catalogRows) {
    const key = modelKey(catalogRow.provider, catalogRow.id);
    if (
      await appendVisibleRow({
        rows: params.rows,
        model: toManifestCatalogListModel(catalogRow),
        key,
        context: params.context,
        seenKeys: params.seenKeys,
        allowProviderAvailabilityFallback: true,
      })
    ) {
      appended += 1;
    }
  }
  return appended;
}

export function appendManifestCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
  manifestRows: readonly NormalizedModelCatalogRow[];
}): Promise<number> {
  return appendModelCatalogRows({
    ...params,
    catalogRows: params.manifestRows,
  });
}

export async function appendCatalogSupplementRows(params: {
  rows: ModelRow[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  const [{ loadModelCatalog }, { resolveModelWithRegistry }] = await Promise.all([
    loadModelCatalogModule(),
    loadModelResolverModule(),
  ]);
  const catalog = await loadModelCatalog({ config: params.context.cfg, readOnly: true });
  for (const entry of catalog) {
    if (
      params.context.filter.provider &&
      normalizeProviderId(entry.provider) !== params.context.filter.provider
    ) {
      continue;
    }
    const key = modelKey(entry.provider, entry.id);
    if (params.seenKeys.has(key)) {
      continue;
    }
    const model = resolveModelWithRegistry({
      provider: entry.provider,
      modelId: entry.id,
      modelRegistry: params.modelRegistry,
      cfg: params.context.cfg,
    });
    if (!model) {
      continue;
    }
    await appendVisibleRow({
      rows: params.rows,
      model,
      key,
      context: params.context,
      seenKeys: params.seenKeys,
      allowProviderAvailabilityFallback: !params.context.discoveredKeys.has(key),
    });
  }

  if (params.context.filter.local || !params.context.filter.provider) {
    return;
  }

  await appendProviderCatalogRows({
    rows: params.rows,
    context: params.context,
    seenKeys: params.seenKeys,
  });
}

export async function appendProviderCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
  staticOnly?: boolean;
}): Promise<number> {
  let appended = 0;
  const { loadProviderCatalogModelsForList } = await loadProviderCatalogModule();
  for (const model of await loadProviderCatalogModelsForList({
    cfg: params.context.cfg,
    agentDir: params.context.agentDir,
    providerFilter: params.context.filter.provider,
    staticOnly: params.staticOnly,
  })) {
    const key = modelKey(model.provider, model.id);
    if (
      await appendVisibleRow({
        rows: params.rows,
        model,
        key,
        context: params.context,
        seenKeys: params.seenKeys,
        allowProviderAvailabilityFallback: !params.context.discoveredKeys.has(key),
      })
    ) {
      appended += 1;
    }
  }
  return appended;
}

export async function appendConfiguredRows(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry?: ModelRegistry;
  context: RowBuilderContext;
}): Promise<void> {
  const resolveModelWithRegistry = params.modelRegistry
    ? (await loadModelResolverModule()).resolveModelWithRegistry
    : undefined;
  for (const entry of params.entries) {
    if (
      params.context.filter.provider &&
      normalizeProviderId(entry.ref.provider) !== params.context.filter.provider
    ) {
      continue;
    }
    const model =
      params.modelRegistry && resolveModelWithRegistry
        ? resolveModelWithRegistry({
            provider: entry.ref.provider,
            modelId: entry.ref.model,
            modelRegistry: params.modelRegistry,
            cfg: params.context.cfg,
          })
        : toFallbackConfiguredListModel(entry, params.context.cfg);
    if (params.context.filter.local && model && !isLocalBaseUrl(model.baseUrl ?? "")) {
      continue;
    }
    if (params.context.filter.local && !model) {
      continue;
    }
    if (model && shouldSuppressListModel({ model, context: params.context })) {
      continue;
    }
    const shouldResolveProviderAuth =
      model &&
      (params.context.availableKeys === undefined ||
        !params.context.discoveredKeys.has(modelKey(model.provider, model.id)));
    params.rows.push(
      toModelRow({
        model,
        key: entry.key,
        tags: Array.from(entry.tags),
        aliases: entry.aliases,
        availableKeys: params.context.availableKeys,
        allowProviderAvailabilityFallback: model
          ? !params.context.discoveredKeys.has(modelKey(model.provider, model.id))
          : false,
        hasAuthForProvider: shouldResolveProviderAuth
          ? (provider) => params.context.authIndex.hasProviderAuth(provider)
          : undefined,
      }),
    );
  }
}
