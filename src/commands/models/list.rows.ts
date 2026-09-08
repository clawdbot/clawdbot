/** Composes CLI inventory sources before rendering their shared catalog projection. */
import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { createModelCatalogView, type ModelCatalogView } from "../../agents/model-catalog-view.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import {
  modelKey,
  normalizeConfiguredProviderCatalogModelId,
} from "../../agents/model-ref-shared.js";
import { shouldSuppressBuiltInModelCore } from "../../agents/model-suppression.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "../../agents/openai-model-routes.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type {
  ModelListAuthEvaluation,
  ModelListAuthIndex,
  ModelListAuthRef,
} from "./list.auth-index.js";
import { isLocalBaseUrl } from "./list.local-url.js";
import { normalizeConfiguredProviderListRow } from "./list.model-projection.js";
import { toListRowInput, toModelRow, type ListRowModel } from "./list.model-row.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";

export type ModelListContext = {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  authIndex: ModelListAuthIndex;
  canonicalizeProvider: (provider: string) => string;
  providerDiscoveryProviderIds?: readonly string[];
  providerRuntimeDiscoveryProviderIds?: readonly string[];
  providerManifestFallbackProviderIds?: readonly string[];
  availableKeys?: Set<string>;
  configuredByKey: Map<string, ConfiguredEntry>;
  discoveredKeys: Set<string>;
  filter: { provider?: string; local?: boolean };
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
};

const catalogLoader = createLazyImportLoader(
  () => import("../../agents/prepared-model-catalog.js"),
);
const scopedCatalogLoader = createLazyImportLoader(() => import("./list.scoped-catalog.js"));
const modelResolverLoader = createLazyImportLoader(
  () => import("../../agents/embedded-agent-runner/model.js"),
);

function toCatalogEntry(model: ListRowModel): ModelCatalogEntry {
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

function toCatalogModel(entry: ModelCatalogEntry): ListRowModel {
  return {
    provider: entry.provider,
    id: entry.id,
    name: entry.name,
    api: entry.api,
    baseUrl: entry.baseUrl,
    input: toListRowInput(entry.input),
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: entry.contextTokens,
  };
}

function toProviderModel(
  provider: string,
  providerConfig: Partial<ModelProviderConfig>,
  model: Partial<ModelDefinitionConfig> & Pick<ModelDefinitionConfig, "id">,
): ListRowModel {
  const input =
    model.input?.filter((item): item is "text" | "image" => item === "text" || item === "image") ??
    [];
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    api: model.api ?? providerConfig.api,
    baseUrl: model.baseUrl ?? providerConfig.baseUrl,
    input: input.length > 0 ? input : ["text"],
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: model.contextTokens,
  };
}

type ModelListSource = "registry" | "prepared" | "provider-config" | "configured" | "authenticated";

/** One command owns source precedence, deduplication and its captured catalog load. */
class ModelListCatalog {
  readonly rows: ModelRow[] = [];
  private readonly seen = new Set<string>();
  private readonly emptyView: ModelCatalogView;
  private snapshot: Promise<ModelCatalogSnapshot> | undefined;

  constructor(
    private readonly context: ModelListContext,
    private readonly registry: ModelRegistry | undefined,
  ) {
    this.emptyView = createModelCatalogView({ cfg: context.cfg, catalog: [] });
  }

  private matchesProvider(provider: string) {
    return (
      !this.context.filter.provider ||
      this.context.canonicalizeProvider(provider) === this.context.filter.provider
    );
  }

  private authRef(model: ListRowModel, view: ModelCatalogView): ModelListAuthRef {
    const identity = openAIModelCatalogRoutePolicy.resolveIdentity(model);
    const observedRoutes = view.variantsOf(model)?.map(({ api, baseUrl }) => ({ api, baseUrl }));
    return {
      modelId: identity?.id ?? model.id,
      ...(observedRoutes?.length ? { observedRoutes } : { api: model.api, baseUrl: model.baseUrl }),
    };
  }

  private evaluate(model: ListRowModel, view: ModelCatalogView) {
    return this.context.authIndex.evaluateModelAuth(model.provider, this.authRef(model, view));
  }

  private async append(params: {
    source: ModelListSource;
    model: ListRowModel;
    key: string;
    view?: ModelCatalogView;
    evaluation?: ModelListAuthEvaluation;
    configured?: ConfiguredEntry;
  }) {
    if (this.seen.has(params.key)) {
      return;
    }
    const model =
      params.source === "configured" || params.source === "provider-config"
        ? await normalizeConfiguredProviderListRow({ model: params.model, context: this.context })
        : params.model;
    const view = params.view ?? this.emptyView;
    const evaluation = params.evaluation ?? this.evaluate(model, view);
    const { entry } = view.project(toCatalogEntry(model), evaluation);
    const projected = {
      ...model,
      name: entry.name,
      api: entry.api,
      baseUrl: entry.baseUrl,
      input: entry.input?.filter(
        (item): item is "text" | "image" | "document" =>
          item === "text" || item === "image" || item === "document",
      ),
      contextWindow: entry.contextWindow,
      contextTokens: entry.contextTokens,
    };
    if (
      !this.matchesProvider(projected.provider) ||
      (this.context.filter.local && !isLocalBaseUrl(projected.baseUrl ?? ""))
    ) {
      return;
    }
    const registryOwnsSuppression = params.source === "registry" && this.registry !== undefined;
    if (
      !registryOwnsSuppression &&
      shouldSuppressBuiltInModelCore({
        provider: projected.provider,
        id: projected.id,
        baseUrl: projected.baseUrl,
        config: this.context.cfg,
      })
    ) {
      return;
    }
    const configured = params.configured ?? this.context.configuredByKey.get(params.key);
    const catalogOwnsAvailability =
      params.source === "provider-config" ||
      (params.source === "authenticated" &&
        !(evaluation.availability === undefined && evaluation.evidence === "synthetic")) ||
      ((params.source === "configured" || params.source === "prepared") &&
        !this.context.discoveredKeys.has(modelKey(params.model.provider, params.model.id)));
    this.rows.push(
      toModelRow({
        model: projected,
        key: params.key,
        tags: configured ? [...configured.tags] : [],
        aliases: configured?.aliases ?? [],
        availableKeys: this.context.availableKeys,
        authAvailability: evaluation.availability,
        authAvailabilityAuthoritative:
          catalogOwnsAvailability ||
          evaluation.availabilityAuthoritative === true ||
          normalizeProviderIdForAuth(model.provider) === "openai" ||
          evaluation.routeResolution !== null,
      }),
    );
    this.seen.add(params.key);
  }

  loadSnapshot(): Promise<ModelCatalogSnapshot> {
    return (this.snapshot ??= this.loadCatalog());
  }

  private async loadCatalog(): Promise<ModelCatalogSnapshot> {
    const context = this.context;
    const workspaceDir = context.workspaceDir ?? context.metadataSnapshot?.workspaceDir;
    if (context.providerDiscoveryProviderIds) {
      const { loadScopedListModelCatalogSnapshot } = await scopedCatalogLoader.load();
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
    const { loadPreparedModelCatalogSnapshot } = await catalogLoader.load();
    return loadPreparedModelCatalogSnapshot({
      config: context.cfg,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      agentDir: context.agentDir,
      ...(workspaceDir ? { workspaceDir } : {}),
      readOnly: true,
      refreshFullCatalog: "stale",
    });
  }

  async appendRegistry(models: Model[]) {
    const resolver =
      this.registry && this.context.filter.provider
        ? (await modelResolverLoader.load()).resolveModelWithRegistry
        : undefined;
    const resolved = models
      .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
      .map((model) => {
        const key = modelKey(model.provider, model.id);
        const candidate =
          this.registry && resolver
            ? resolver({
                provider: model.provider,
                modelId: model.id,
                modelRegistry: this.registry,
                cfg: this.context.cfg,
                agentDir: this.context.agentDir,
              })
            : undefined;
        const row =
          candidate && modelKey(candidate.provider, candidate.id) === key ? candidate : model;
        return { key, model, row };
      });
    const view = createModelCatalogView({
      cfg: this.context.cfg,
      catalog: resolved.map(({ model, row }) =>
        toCatalogEntry(model.api === row.api && model.baseUrl === row.baseUrl ? row : model),
      ),
    });
    for (const { key, row } of resolved) {
      await this.append({ source: "registry", model: row, key, view });
    }
  }

  async appendProviderConfig() {
    const replaceMode = this.context.cfg.models?.mode === "replace";
    for (const [provider, providerConfig] of Object.entries(
      this.context.cfg.models?.providers ?? {},
    )) {
      for (const configuredModel of providerConfig.models ?? []) {
        if (!replaceMode && providerConfig.api === undefined && configuredModel.api === undefined) {
          continue;
        }
        // Auth remains attached to the source provider; only the display key is aliased.
        const id = replaceMode
          ? normalizeConfiguredProviderCatalogModelId(
              provider,
              stripSelfProviderModelPrefix(provider, configuredModel.id),
              { manifestPlugins: this.context.metadataSnapshot },
            )
          : configuredModel.id;
        const displayProvider = replaceMode
          ? this.context.canonicalizeProvider(provider)
          : provider;
        const model = toProviderModel(provider, providerConfig, { ...configuredModel, id });
        await this.append({
          source: "provider-config",
          model,
          key: modelKey(displayProvider, id),
          ...(replaceMode ? { evaluation: this.evaluate(model, this.emptyView) } : {}),
        });
      }
    }
  }

  async appendPrepared() {
    const snapshot = await this.loadSnapshot();
    const staticEntries = snapshot.staticEntries ?? [];
    const routeVariants = [...snapshot.routeVariants];
    const routeKey = (entry: ModelCatalogEntry) =>
      `${resolveModelCatalogIdentityKey(entry)}\0${entry.api ?? ""}\0${entry.baseUrl ?? ""}`;
    const seenRoutes = new Set(routeVariants.map(routeKey));
    for (const entry of staticEntries) {
      const key = routeKey(entry);
      if (!seenRoutes.has(key)) {
        routeVariants.push(entry);
        seenRoutes.add(key);
      }
    }
    const view = createModelCatalogView({
      cfg: this.context.cfg,
      catalog: snapshot.entries,
      routeVariants,
    });
    for (const entry of [...view.catalog, ...staticEntries]) {
      await this.append({
        source: "prepared",
        model: toCatalogModel(entry),
        key: modelKey(entry.provider, entry.id),
        view,
      });
    }
  }

  async appendAuthenticated() {
    const snapshot = await this.loadSnapshot();
    const view = createModelCatalogView({
      cfg: this.context.cfg,
      catalog: snapshot.entries,
      routeVariants: snapshot.routeVariants,
    });
    for (const entry of view.catalog) {
      const model = toCatalogModel(entry);
      const evaluation = this.evaluate(model, view);
      if (
        evaluation.availability !== true &&
        !(evaluation.availability === undefined && evaluation.evidence === "synthetic")
      ) {
        continue;
      }
      await this.append({
        source: "authenticated",
        model,
        key: modelKey(entry.provider, entry.id),
        view,
        evaluation,
      });
    }
  }

  async appendConfigured(entries: ConfiguredEntry[], snapshot?: ModelCatalogSnapshot) {
    const resolver = this.registry
      ? (await modelResolverLoader.load()).resolveModelWithRegistry
      : undefined;
    const catalogByKey = new Map<string, ModelCatalogEntry>();
    for (const entry of snapshot ? [...snapshot.entries, ...(snapshot.staticEntries ?? [])] : []) {
      const key = modelKey(entry.provider, entry.id);
      if (!catalogByKey.has(key)) {
        catalogByKey.set(key, entry);
      }
    }
    const view = snapshot
      ? createModelCatalogView({
          cfg: this.context.cfg,
          catalog: snapshot.entries,
          routeVariants: snapshot.routeVariants,
        })
      : this.emptyView;
    for (const configured of entries) {
      if (this.seen.has(configured.key) || !this.matchesProvider(configured.ref.provider)) {
        continue;
      }
      let model: ListRowModel | undefined;
      if (this.registry && resolver) {
        model = resolver({
          provider: configured.ref.provider,
          modelId: configured.ref.model,
          modelRegistry: this.registry,
          cfg: this.context.cfg,
        });
      } else {
        const provider = this.context.cfg.models?.providers?.[configured.ref.provider];
        const authored = provider?.models?.find((entry) => entry.id === configured.ref.model);
        const catalogEntry = catalogByKey.get(configured.key);
        model =
          provider && authored
            ? toProviderModel(configured.ref.provider, provider, authored)
            : catalogEntry
              ? toCatalogModel(catalogEntry)
              : {
                  provider: configured.ref.provider,
                  id: configured.ref.model,
                  name: configured.ref.model,
                  input: ["text"],
                  contextWindow: DEFAULT_CONTEXT_TOKENS,
                };
      }
      if (model) {
        await this.append({ source: "configured", model, key: configured.key, configured, view });
      } else if (!this.context.filter.local) {
        this.rows.push(
          toModelRow({
            key: configured.key,
            tags: [...configured.tags],
            aliases: configured.aliases,
            authAvailability: undefined,
          }),
        );
        this.seen.add(configured.key);
      }
    }
  }
}

/** Builds the command's ordered rows once, leaving acquisition and public output unchanged. */
export async function buildModelListRows(params: {
  includePreparedCatalog: boolean;
  entries: ConfiguredEntry[];
  context: ModelListContext;
  modelRegistry?: ModelRegistry;
  registryModels?: Model[];
}): Promise<ModelRow[]> {
  const catalog = new ModelListCatalog(params.context, params.modelRegistry);
  if (params.includePreparedCatalog) {
    await catalog.appendRegistry(params.registryModels ?? params.modelRegistry?.getAll() ?? []);
    await catalog.appendPrepared();
    await catalog.appendProviderConfig();
    if (params.context.filter.provider) {
      await catalog.appendConfigured(params.entries);
    }
  } else if (params.context.cfg.models?.mode === "replace") {
    await catalog.appendProviderConfig();
  } else {
    await catalog.appendConfigured(params.entries, await catalog.loadSnapshot());
    await catalog.appendProviderConfig();
    await catalog.appendAuthenticated();
  }
  return catalog.rows;
}
