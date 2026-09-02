/** Row builders used by `openclaw models list` source orchestration. */
import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import {
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "../../agents/model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import {
  modelKey,
  normalizeConfiguredProviderCatalogModelId,
} from "../../agents/model-ref-shared.js";
import { modelCatalogLogicalKey } from "../../agents/model-selection-shared.js";
import { shouldSuppressBuiltInModelCore } from "../../agents/model-suppression.js";
import { openAIModelCatalogRoutePolicy } from "../../agents/openai-model-routes.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { ModelListAuthEvaluation, ModelListAuthRef } from "./list.auth-index.js";
import { isLocalBaseUrl } from "./list.local-url.js";
import { normalizeConfiguredProviderListRow } from "./list.model-projection.js";
import type { ListRowModel } from "./list.model-row.js";
import { toListRowInput, toModelRow } from "./list.model-row.js";
import type { RowBuilderContext } from "./list.row-context.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";

type ModelCatalogModule = typeof import("../../agents/prepared-model-catalog.js");
type ModelResolverModule = typeof import("../../agents/embedded-agent-runner/model.js");
type ScopedModelCatalogModule = typeof import("./list.scoped-catalog.js");

export type { RowBuilderContext } from "./list.row-context.js";

const modelCatalogModuleLoader = createLazyImportLoader<ModelCatalogModule>(
  () => import("../../agents/prepared-model-catalog.js"),
);
const scopedModelCatalogModuleLoader = createLazyImportLoader<ScopedModelCatalogModule>(
  () => import("./list.scoped-catalog.js"),
);
const modelResolverModuleLoader = createLazyImportLoader<ModelResolverModule>(
  () => import("../../agents/embedded-agent-runner/model.js"),
);
function matchesProviderFilter(context: RowBuilderContext, provider: string): boolean {
  const providerFilter = context.filter.provider;
  if (!providerFilter) {
    return true;
  }
  return context.canonicalizeProvider(provider) === providerFilter;
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

function buildRow(params: {
  model: ListRowModel;
  key: string;
  context: RowBuilderContext;
  authEvaluation: ModelListAuthEvaluation;
  allowAuthAvailabilityOverride?: boolean;
  configuredEntry?: ConfiguredEntry;
}): ModelRow {
  const configured = params.configuredEntry ?? params.context.configuredByKey.get(params.key);
  return toModelRow({
    model: params.model,
    key: params.key,
    tags: configured ? Array.from(configured.tags) : [],
    aliases: configured?.aliases ?? [],
    availableKeys: params.context.availableKeys,
    authAvailability: params.authEvaluation.availability,
    authAvailabilityAuthoritative:
      params.allowAuthAvailabilityOverride === true ||
      normalizeProviderIdForAuth(params.model.provider) === "openai" ||
      params.authEvaluation.routeResolution !== null,
  });
}

function shouldSuppressListModel(params: {
  model: { provider: string; id: string; baseUrl?: string };
  context: RowBuilderContext;
}): boolean {
  return shouldSuppressBuiltInModelCore({
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
  authEvaluation?: ModelListAuthEvaluation;
  routeIndex?: ModelCatalogLogicalRouteIndex;
  allowAuthAvailabilityOverride?: boolean;
  skipSuppression?: boolean;
  normalizeWithProviderPlugin?: boolean;
  configuredEntry?: ConfiguredEntry;
}): Promise<boolean> {
  if (params.seenKeys?.has(params.key)) {
    return false;
  }
  const model = params.normalizeWithProviderPlugin
    ? await normalizeConfiguredProviderListRow({
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
    buildRow({
      model: projectedModel,
      key: params.key,
      context: params.context,
      authEvaluation,
      allowAuthAvailabilityOverride: params.allowAuthAvailabilityOverride,
      ...(params.configuredEntry ? { configuredEntry: params.configuredEntry } : {}),
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

function toPreparedCatalogListModel(
  row: Pick<
    ModelCatalogEntry,
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

function toFallbackConfiguredListModel(
  entry: ConfiguredEntry,
  cfg: OpenClawConfig,
  catalogEntry?: ModelCatalogEntry,
): ListRowModel {
  // Explicit models.providers definitions stay authoritative; the prepared
  // catalog fills plugin-owned refs so this view matches `--all`, and the
  // placeholder is a last resort for refs nothing knows.
  return (
    findConfiguredProviderModel({
      cfg,
      provider: entry.ref.provider,
      modelId: entry.ref.model,
    }) ??
    (catalogEntry ? toPreparedCatalogListModel(catalogEntry) : undefined) ?? {
      provider: entry.ref.provider,
      id: entry.ref.model,
      name: entry.ref.model,
      input: ["text"],
      contextWindow: DEFAULT_CONTEXT_TOKENS,
    }
  );
}

/** Loads the committed catalog generation shared by every model-list row source. */
export async function loadListModelCatalogSnapshot(
  context: RowBuilderContext,
): Promise<ModelCatalogSnapshot> {
  const workspaceDir = context.workspaceDir ?? context.metadataSnapshot?.workspaceDir;
  if (context.providerDiscoveryProviderIds) {
    const { loadScopedListModelCatalogSnapshot } = await scopedModelCatalogModuleLoader.load();
    return loadScopedListModelCatalogSnapshot({
      cfg: context.cfg,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      agentDir: context.agentDir,
      ...(context.inheritedAuthDir ? { inheritedAuthDir: context.inheritedAuthDir } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
      providerIds: context.providerDiscoveryProviderIds,
      runtimeProviderIds: context.providerRuntimeDiscoveryProviderIds,
      manifestFallbackProviderIds: context.providerManifestFallbackProviderIds,
      configuredKeys: [...context.configuredByKey.keys()],
      ...(context.metadataSnapshot ? { metadataSnapshot: context.metadataSnapshot } : {}),
    });
  }
  const { loadPreparedModelCatalogSnapshot } = await modelCatalogModuleLoader.load();
  return loadPreparedModelCatalogSnapshot({
    config: context.cfg,
    ...(context.agentId ? { agentId: context.agentId } : {}),
    agentDir: context.agentDir,
    ...(workspaceDir ? { workspaceDir } : {}),
    readOnly: true,
    refreshFullCatalog: true,
  });
}

/** Indexes a catalog generation by model key so configured refs can reuse its metadata. */
function indexModelCatalogEntriesByKey(
  snapshot: ModelCatalogSnapshot,
): ReadonlyMap<string, ModelCatalogEntry> {
  const byKey = new Map<string, ModelCatalogEntry>();
  for (const entry of [...snapshot.entries, ...(snapshot.staticEntries ?? [])]) {
    const key = modelKey(entry.provider, entry.id);
    if (!byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  return byKey;
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
      ? (await modelResolverModuleLoader.load()).resolveModelWithRegistry
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
  const replaceMode = params.context.cfg.models?.mode === "replace";
  for (const [provider, providerConfig] of Object.entries(
    params.context.cfg.models?.providers ?? {},
  )) {
    for (const configuredModel of providerConfig.models ?? []) {
      if (
        !replaceMode &&
        !shouldListConfiguredProviderModel({ providerConfig, model: configuredModel })
      ) {
        continue;
      }
      // Strip a self-prefix against the source provider before display aliasing.
      // Auth stays on the source provider so alias-backed profiles remain valid.
      const modelId = replaceMode
        ? normalizeConfiguredProviderCatalogModelId(
            provider,
            stripSelfProviderModelPrefix(provider, configuredModel.id),
            {
              manifestPlugins: params.context.metadataSnapshot,
            },
          )
        : configuredModel.id;
      const displayProvider = replaceMode
        ? params.context.canonicalizeProvider(provider)
        : provider;
      const key = modelKey(displayProvider, modelId);
      const model = toConfiguredProviderListModel({
        provider,
        providerConfig,
        model: { ...configuredModel, id: modelId },
      });
      const authEvaluation = replaceMode
        ? params.context.authIndex.evaluateModelAuth(provider, toModelAuthRef(model))
        : undefined;
      await appendVisibleRow({
        rows: params.rows,
        model,
        key,
        context: params.context,
        seenKeys: params.seenKeys,
        ...(authEvaluation ? { authEvaluation } : {}),
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
  catalogSnapshot?: ModelCatalogSnapshot;
}): Promise<void> {
  if (params.context.cfg.models?.mode === "replace") {
    return;
  }
  const { entries: catalog, routeVariants } =
    params.catalogSnapshot ?? (await loadListModelCatalogSnapshot(params.context));
  const routeIndex = createModelCatalogLogicalRouteIndex(routeVariants);
  for (const entry of catalog) {
    const model = toPreparedCatalogListModel(entry);
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

/** Projects every model from the same lifecycle generation used by the Gateway. */
export async function appendPreparedModelCatalogRows(params: {
  rows: ModelRow[];
  context: RowBuilderContext;
  seenKeys: Set<string>;
  catalogSnapshot?: ModelCatalogSnapshot;
}): Promise<void> {
  const catalogSnapshot =
    params.catalogSnapshot ?? (await loadListModelCatalogSnapshot(params.context));
  const staticEntries = catalogSnapshot.staticEntries ?? [];
  const routeVariants = [...catalogSnapshot.routeVariants];
  const seenRouteVariants = new Set(
    routeVariants.map(
      (entry) => `${resolveCatalogLogicalKey(entry)}\0${entry.api ?? ""}\0${entry.baseUrl ?? ""}`,
    ),
  );
  for (const entry of staticEntries) {
    const routeKey = `${resolveCatalogLogicalKey(entry)}\0${entry.api ?? ""}\0${entry.baseUrl ?? ""}`;
    if (!seenRouteVariants.has(routeKey)) {
      routeVariants.push(entry);
      seenRouteVariants.add(routeKey);
    }
  }
  const routeIndex = createModelCatalogLogicalRouteIndex(routeVariants);
  // Static provider hooks belong to this same published generation; omitting
  // them hides valid plugin-owned models from filtered and complete listings.
  for (const entry of [...catalogSnapshot.entries, ...staticEntries]) {
    await appendVisibleRow({
      rows: params.rows,
      model: toPreparedCatalogListModel(entry),
      key: modelKey(entry.provider, entry.id),
      context: params.context,
      seenKeys: params.seenKeys,
      routeIndex,
      allowAuthAvailabilityOverride: !params.context.discoveredKeys.has(
        modelKey(entry.provider, entry.id),
      ),
    });
  }
}

/** Appends rows from default/fallback/configured model references. */
export async function appendConfiguredRows(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry?: ModelRegistry;
  context: RowBuilderContext;
  catalogSnapshot?: ModelCatalogSnapshot;
}): Promise<void> {
  const resolveModelWithRegistry = params.modelRegistry
    ? (await modelResolverModuleLoader.load()).resolveModelWithRegistry
    : undefined;
  const catalogByKey = params.catalogSnapshot
    ? indexModelCatalogEntriesByKey(params.catalogSnapshot)
    : undefined;
  // Route-aware auth/projection keeps configured rows consistent with the
  // catalog rows built from the same snapshot two sources later.
  const routeIndex = params.catalogSnapshot
    ? createModelCatalogLogicalRouteIndex(params.catalogSnapshot.routeVariants)
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
        : toFallbackConfiguredListModel(entry, params.context.cfg, catalogByKey?.get(entry.key));
    if (!resolvedModel) {
      // Registry-resolved refs can miss entirely; the configured view still
      // surfaces the ref as a "missing" row so a typo'd fallback is visible.
      if (!params.context.filter.local) {
        params.rows.push(
          toModelRow({
            key: entry.key,
            tags: Array.from(entry.tags),
            aliases: entry.aliases,
            availableKeys: params.context.availableKeys,
            authAvailability: undefined,
          }),
        );
      }
      continue;
    }
    await appendVisibleRow({
      rows: params.rows,
      model: resolvedModel,
      key: entry.key,
      context: params.context,
      ...(routeIndex ? { routeIndex } : {}),
      configuredEntry: entry,
      normalizeWithProviderPlugin: true,
      allowAuthAvailabilityOverride: !params.context.discoveredKeys.has(
        modelKey(resolvedModel.provider, resolvedModel.id),
      ),
    });
  }
}
