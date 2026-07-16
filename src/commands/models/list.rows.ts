/** Row builders used by `openclaw models list` source orchestration. */
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import {
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "@openclaw/model-catalog-core/provider-id";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import {
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "../../agents/model-catalog-route.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { modelCatalogLogicalKey } from "../../agents/model-selection-shared.js";
import {
  shouldSuppressBuiltInModel,
  shouldSuppressBuiltInModelFromManifest,
} from "../../agents/model-suppression.js";
import { openAIModelCatalogRoutePolicy } from "../../agents/openai-model-routes.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { normalizeProviderResolvedModelWithPlugin } from "../../plugins/provider-runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type {
  ModelListAuthEvaluation,
  ModelListAuthIndex,
  ModelListAuthRef,
} from "./list.auth-index.js";
import { isLocalBaseUrl } from "./list.local-url.js";
import type { ListRowModel } from "./list.model-row.js";
import { toModelRow } from "./list.model-row.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";
import { canonicalizeModelCatalogProviderAlias } from "./provider-aliases.js";
import { modelKey } from "./shared.js";

type ConfiguredByKey = Map<string, ConfiguredEntry>;
type ModelCatalogModule = typeof import("../../agents/model-catalog.js");
type ModelResolverModule = typeof import("../../agents/embedded-agent-runner/model.js");
type ProviderCatalogModule = typeof import("./list.provider-catalog.js");

type RowFilter = {
  provider?: string;
  local?: boolean;
};

/** Context shared by every model-list row source builder. */
export type RowBuilderContext = {
  cfg: OpenClawConfig;
  agentDir: string;
  authIndex: ModelListAuthIndex;
  availableKeys?: Set<string>;
  configuredByKey: ConfiguredByKey;
  discoveredKeys: Set<string>;
  filter: RowFilter;
  skipRuntimeModelSuppression?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
};

const modelCatalogModuleLoader = createLazyImportLoader<ModelCatalogModule>(
  () => import("../../agents/model-catalog.js"),
);
const modelResolverModuleLoader = createLazyImportLoader<ModelResolverModule>(
  () => import("../../agents/embedded-agent-runner/model.js"),
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

function matchesProviderFilter(context: RowBuilderContext, provider: string): boolean {
  const providerFilter = context.filter.provider;
  if (!providerFilter) {
    return true;
  }
  const canonicalProvider = canonicalizeModelCatalogProviderAlias(provider, {
    cfg: context.cfg,
    metadataSnapshot: context.metadataSnapshot,
  });
  return normalizeProviderId(canonicalProvider) === providerFilter;
}

function matchesRowFilter(
  context: RowBuilderContext,
  model: { provider: string; baseUrl?: string },
) {
  if (!matchesProviderFilter(context, model.provider)) {
    return false;
  }
  if (context.filter.local && !isLocalBaseUrl(model.baseUrl ?? "")) {
    return false;
  }
  return true;
}

type ModelCatalogLogicalRouteIndex = ReadonlyMap<string, readonly ModelCatalogEntry[]>;

function resolveCatalogLogicalKey(model: Pick<ModelCatalogEntry, "provider" | "id">): string {
  return openAIModelCatalogRoutePolicy.resolveIdentity(model)?.key ?? modelCatalogLogicalKey(model);
}

function createModelCatalogLogicalRouteIndex(
  catalog: readonly ModelCatalogEntry[],
): ModelCatalogLogicalRouteIndex {
  const index = new Map<string, ModelCatalogEntry[]>();
  for (const entry of catalog) {
    const key = resolveCatalogLogicalKey(entry);
    const variants = index.get(key) ?? [];
    variants.push(entry);
    index.set(key, variants);
  }
  return index;
}

function resolveCatalogLogicalRoutes(
  model: Pick<ModelCatalogEntry, "provider" | "id">,
  routeIndex: ModelCatalogLogicalRouteIndex | undefined,
): readonly ModelCatalogEntry[] | undefined {
  return routeIndex?.get(resolveCatalogLogicalKey(model));
}

function toModelAuthRef(
  model: ListRowModel,
  routeIndex?: ModelCatalogLogicalRouteIndex,
): ModelListAuthRef {
  const identity = openAIModelCatalogRoutePolicy.resolveIdentity(model);
  const observedRoutes = resolveCatalogLogicalRoutes(model, routeIndex)?.map((entry) => ({
    api: entry.api,
    baseUrl: entry.baseUrl,
  }));
  return {
    modelId: identity?.id ?? model.id,
    ...(observedRoutes && observedRoutes.length > 0
      ? { observedRoutes }
      : { api: model.api, baseUrl: model.baseUrl }),
  };
}

function toCatalogProjectionEntry(model: ListRowModel): ModelCatalogEntry {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    ...(typeof model.api === "string" ? { api: model.api as ModelCatalogEntry["api"] } : {}),
    ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.contextTokens === "number" ? { contextTokens: model.contextTokens } : {}),
    ...(model.input !== undefined ? { input: model.input } : {}),
  };
}

function hasSameCatalogRoute(left: ListRowModel, right: ListRowModel): boolean {
  return left.api === right.api && left.baseUrl === right.baseUrl;
}

function projectListRowModel(params: {
  model: ListRowModel;
  evaluation: ModelListAuthEvaluation;
  cfg: OpenClawConfig;
  routeIndex?: ModelCatalogLogicalRouteIndex;
}): ListRowModel {
  const projection =
    params.evaluation.routeResolution === null
      ? ({ kind: "unmanaged" } as const)
      : params.evaluation.selectedRoute
        ? ({
            kind: "selected",
            route: params.evaluation.selectedRoute,
            policy: openAIModelCatalogRoutePolicy,
          } as const)
        : ({ kind: "unresolved", policy: openAIModelCatalogRoutePolicy } as const);
  const entry = toCatalogProjectionEntry(params.model);
  const overrides = resolveConfiguredModelCatalogOverrides({
    cfg: params.cfg,
    entry,
    policy: openAIModelCatalogRoutePolicy,
  });
  const routeVariants = resolveCatalogLogicalRoutes(entry, params.routeIndex);
  const projected = projectModelCatalogEntryForRoute({
    entry,
    projection,
    ...(routeVariants ? { catalog: routeVariants } : {}),
    ...(overrides ? { overrides } : {}),
  });
  return {
    ...params.model,
    name: projected.name,
    api: projected.api,
    baseUrl: projected.baseUrl,
    input: projected.input?.filter(
      (item): item is NonNullable<ListRowModel["input"]>[number] =>
        item === "text" || item === "image" || item === "document",
    ),
    contextWindow: projected.contextWindow,
    contextTokens: projected.contextTokens,
  };
}

async function buildRow(params: {
  model: ListRowModel;
  key: string;
  context: RowBuilderContext;
  routeIndex?: ModelCatalogLogicalRouteIndex;
  authEvaluation?: ModelListAuthEvaluation;
  allowAuthAvailabilityOverride?: boolean;
}): Promise<ModelRow> {
  const configured = params.context.configuredByKey.get(params.key);
  const authRef = toModelAuthRef(params.model, params.routeIndex);
  const authEvaluation =
    params.authEvaluation ??
    params.context.authIndex.evaluateModelAuth(params.model.provider, authRef);
  const model = projectListRowModel({
    model: params.model,
    evaluation: authEvaluation,
    cfg: params.context.cfg,
    ...(params.routeIndex ? { routeIndex: params.routeIndex } : {}),
  });
  return toModelRow({
    model,
    key: params.key,
    tags: configured ? Array.from(configured.tags) : [],
    aliases: configured?.aliases ?? [],
    availableKeys: params.context.availableKeys,
    authAvailability: authEvaluation.availability,
    authAvailabilityAuthoritative:
      params.allowAuthAvailabilityOverride === true ||
      normalizeProviderIdForAuth(params.model.provider) === "openai" ||
      authEvaluation.routeResolution !== null,
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
      baseUrl: params.model.baseUrl,
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

function normalizeListRowWithProviderPlugin(params: {
  model: ListRowModel;
  context: RowBuilderContext;
}): ListRowModel {
  const normalized = normalizeProviderResolvedModelWithPlugin({
    provider: params.model.provider,
    config: params.context.cfg,
    workspaceDir: params.context.workspaceDir,
    pluginMetadataSnapshot: params.context.metadataSnapshot,
    context: {
      config: params.context.cfg,
      agentDir: params.context.agentDir,
      workspaceDir: params.context.workspaceDir,
      provider: params.model.provider,
      modelId: params.model.id,
      model: params.model as ProviderRuntimeModel,
    },
  });
  if (!normalized) {
    return params.model;
  }
  return {
    ...params.model,
    id: normalized.id,
    name: normalized.name,
    provider: normalized.provider,
    api: normalized.api ?? params.model.api,
    baseUrl: normalized.baseUrl ?? params.model.baseUrl,
    input: toListRowInput(normalized.input),
    contextWindow: normalized.contextWindow,
    contextTokens: normalized.contextTokens,
  };
}

async function appendVisibleRow(params: {
  rows: ModelRow[];
  model: ListRowModel;
  key: string;
  context: RowBuilderContext;
  seenKeys?: Set<string>;
  authEvaluation?: ModelListAuthEvaluation;
  routeIndex?: ModelCatalogLogicalRouteIndex;
  allowAuthAvailabilityOverride?: boolean;
  skipSuppression?: boolean;
  normalizeWithProviderPlugin?: boolean;
}): Promise<boolean> {
  if (params.seenKeys?.has(params.key)) {
    return false;
  }
  const model = params.normalizeWithProviderPlugin
    ? normalizeListRowWithProviderPlugin({
        model: params.model,
        context: params.context,
      })
    : params.model;
  const authEvaluation =
    params.authEvaluation ??
    params.context.authIndex.evaluateModelAuth(
      model.provider,
      toModelAuthRef(model, params.routeIndex),
    );
  const projectedModel = projectListRowModel({
    model,
    evaluation: authEvaluation,
    cfg: params.context.cfg,
    ...(params.routeIndex ? { routeIndex: params.routeIndex } : {}),
  });
  if (!matchesRowFilter(params.context, projectedModel)) {
    return false;
  }
  if (
    !params.skipSuppression &&
    shouldSuppressListModel({ model: projectedModel, context: params.context })
  ) {
    return false;
  }
  params.rows.push(
    await buildRow({
      model,
      key: params.key,
      context: params.context,
      ...(params.routeIndex ? { routeIndex: params.routeIndex } : {}),
      authEvaluation,
      allowAuthAvailabilityOverride: params.allowAuthAvailabilityOverride,
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
    api: params.model.api ?? params.providerConfig.api,
    baseUrl: params.model.baseUrl ?? params.providerConfig.baseUrl,
    input: resolveConfiguredModelInput({ model: params.model }),
    contextWindow: params.model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: params.model.contextTokens,
  };
}

function toListRowInput(input: readonly string[] | undefined): ListRowModel["input"] {
  const parsed = input?.filter(
    (item): item is NonNullable<ListRowModel["input"]>[number] =>
      item === "text" || item === "image" || item === "document",
  );
  return parsed?.length ? parsed : ["text"];
}

function toManifestCatalogListModel(
  row: Pick<
    NormalizedModelCatalogRow,
    "provider" | "id" | "name" | "api" | "baseUrl" | "contextWindow" | "contextTokens"
  > & {
    input?: readonly string[];
  },
): ListRowModel {
  return {
    provider: row.provider,
    id: row.id,
    name: row.name,
    api: row.api,
    baseUrl: row.baseUrl,
    input: toListRowInput(row.input),
    contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: row.contextTokens,
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

/** Appends rows discovered from the loaded model registry. */
export async function appendDiscoveredRows(params: {
  rows: ModelRow[];
  models: Model[];
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
  const preparedModels = sorted.map((model) => {
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
    return { key, model, rowModel };
  });
  const projectionCatalog = preparedModels.map(({ model, rowModel }) =>
    toCatalogProjectionEntry(
      hasSameCatalogRoute(model as ListRowModel, rowModel) ? rowModel : (model as ListRowModel),
    ),
  );
  const routeIndex = createModelCatalogLogicalRouteIndex(projectionCatalog);

  for (const { key, rowModel } of preparedModels) {
    await appendVisibleRow({
      rows: params.rows,
      model: rowModel,
      key,
      context: params.context,
      seenKeys,
      routeIndex,
      skipSuppression: params.skipSuppression,
    });
  }

  return seenKeys;
}

/** Appends models explicitly configured under models.providers. */
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
        allowAuthAvailabilityOverride: true,
        normalizeWithProviderPlugin: true,
      });
    }
  }
}

/** Appends catalog models for providers that have configured auth. */
export async function appendAuthenticatedCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  const { loadModelCatalogSnapshot } = await loadModelCatalogModule();
  const { entries: catalog, routeVariants } = await loadModelCatalogSnapshot({
    config: params.context.cfg,
    readOnly: true,
    metadataSnapshot: params.context.metadataSnapshot,
  });
  const routeIndex = createModelCatalogLogicalRouteIndex(routeVariants);
  for (const entry of catalog) {
    const model = toManifestCatalogListModel(entry);
    const authEvaluation = params.context.authIndex.evaluateModelAuth(
      entry.provider,
      toModelAuthRef(model, routeIndex),
    );
    const hasRunnableSyntheticAuth =
      authEvaluation.availability === undefined && authEvaluation.evidence === "synthetic";
    if (authEvaluation.availability !== true && !hasRunnableSyntheticAuth) {
      continue;
    }
    const key = modelKey(entry.provider, entry.id);
    await appendVisibleRow({
      rows: params.rows,
      model,
      key,
      context: params.context,
      seenKeys: params.seenKeys,
      routeIndex,
      authEvaluation,
      // Synthetic evidence admits local rows but does not override their URL-based availability.
      allowAuthAvailabilityOverride: !hasRunnableSyntheticAuth,
    });
  }
}

/** Appends normalized model catalog rows into the shared row list. */
export async function appendModelCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
  catalogRows: readonly NormalizedModelCatalogRow[];
}): Promise<number> {
  let appended = 0;
  const projectionCatalog = params.catalogRows.map((row) =>
    toCatalogProjectionEntry(toManifestCatalogListModel(row)),
  );
  const routeIndex = createModelCatalogLogicalRouteIndex(projectionCatalog);
  for (const catalogRow of params.catalogRows) {
    const key = modelKey(catalogRow.provider, catalogRow.id);
    if (
      await appendVisibleRow({
        rows: params.rows,
        model: toManifestCatalogListModel(catalogRow),
        key,
        context: params.context,
        seenKeys: params.seenKeys,
        routeIndex,
        allowAuthAvailabilityOverride: true,
      })
    ) {
      appended += 1;
    }
  }
  return appended;
}

/** Appends manifest catalog rows through the generic catalog-row path. */
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

/** Appends catalog rows that are resolvable by the registry but missing from registry output. */
export async function appendCatalogSupplementRows(params: {
  rows: ModelRow[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  const [modelCatalog, { resolveModelWithRegistry }] = await Promise.all([
    loadModelCatalogModule(),
    loadModelResolverModule(),
  ]);
  const { entries: catalog, routeVariants } = await modelCatalog.loadModelCatalogSnapshot({
    config: params.context.cfg,
    readOnly: true,
    metadataSnapshot: params.context.metadataSnapshot,
  });
  const routeIndex = createModelCatalogLogicalRouteIndex(routeVariants);
  for (const entry of catalog) {
    if (!matchesProviderFilter(params.context, entry.provider)) {
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
      routeIndex,
      allowAuthAvailabilityOverride: !params.context.discoveredKeys.has(key),
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

/** Appends model rows returned by provider catalog hooks. */
export async function appendProviderCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
  staticOnly?: boolean;
  catalogModels?: readonly Model[];
}): Promise<number> {
  let appended = 0;
  let catalogModels = params.catalogModels;
  if (catalogModels == null) {
    const { loadProviderCatalogModelsForList } = await loadProviderCatalogModule();
    catalogModels = await loadProviderCatalogModelsForList({
      cfg: params.context.cfg,
      agentDir: params.context.agentDir,
      providerFilter: params.context.filter.provider,
      staticOnly: params.staticOnly,
      metadataSnapshot: params.context.metadataSnapshot,
    });
  }
  const projectionCatalog = catalogModels.map((model) =>
    toCatalogProjectionEntry(model as ListRowModel),
  );
  const routeIndex = createModelCatalogLogicalRouteIndex(projectionCatalog);
  for (const model of catalogModels) {
    const key = modelKey(model.provider, model.id);
    if (
      await appendVisibleRow({
        rows: params.rows,
        model,
        key,
        context: params.context,
        seenKeys: params.seenKeys,
        routeIndex,
        allowAuthAvailabilityOverride: !params.context.discoveredKeys.has(key),
      })
    ) {
      appended += 1;
    }
  }
  return appended;
}

/** Appends rows from default/fallback/configured model references. */
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
    if (!matchesProviderFilter(params.context, entry.ref.provider)) {
      continue;
    }
    const resolvedModel =
      params.modelRegistry && resolveModelWithRegistry
        ? resolveModelWithRegistry({
            provider: entry.ref.provider,
            modelId: entry.ref.model,
            modelRegistry: params.modelRegistry,
            cfg: params.context.cfg,
          })
        : toFallbackConfiguredListModel(entry, params.context.cfg);
    const model = resolvedModel
      ? normalizeListRowWithProviderPlugin({ model: resolvedModel, context: params.context })
      : resolvedModel;
    if (params.context.filter.local && !model) {
      continue;
    }
    const authEvaluation = model
      ? params.context.authIndex.evaluateModelAuth(model.provider, toModelAuthRef(model))
      : undefined;
    const projectedModel =
      model && authEvaluation
        ? projectListRowModel({ model, evaluation: authEvaluation, cfg: params.context.cfg })
        : model;
    if (
      params.context.filter.local &&
      projectedModel &&
      !isLocalBaseUrl(projectedModel.baseUrl ?? "")
    ) {
      continue;
    }
    if (
      projectedModel &&
      shouldSuppressListModel({ model: projectedModel, context: params.context })
    ) {
      continue;
    }
    params.rows.push(
      toModelRow({
        model: projectedModel,
        key: entry.key,
        tags: Array.from(entry.tags),
        aliases: entry.aliases,
        availableKeys: params.context.availableKeys,
        authAvailability: authEvaluation?.availability,
        authAvailabilityAuthoritative:
          Boolean(
            model && !params.context.discoveredKeys.has(modelKey(model.provider, model.id)),
          ) ||
          normalizeProviderIdForAuth(model?.provider ?? entry.ref.provider) === "openai" ||
          (authEvaluation !== undefined && authEvaluation.routeResolution !== null),
      }),
    );
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
