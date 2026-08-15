import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
/** Dependency-light model catalog snapshots for default model-list views. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  loadManifestCatalogRowsForList,
  loadStaticManifestCatalogRowsForList,
  resolveManifestCatalogCoverageForList,
} from "./list.manifest-catalog.js";

type PersistedCatalogModule = typeof import("./list.persisted-catalog.js");
type PreparedScopedCatalogModule =
  typeof import("../../agents/prepared-model-runtime.scoped-catalog.js");

const persistedCatalogModuleLoader = createLazyImportLoader<PersistedCatalogModule>(
  () => import("./list.persisted-catalog.js"),
);
const preparedScopedCatalogModuleLoader = createLazyImportLoader<PreparedScopedCatalogModule>(
  () => import("../../agents/prepared-model-runtime.scoped-catalog.js"),
);

function toCatalogEntry(row: NormalizedModelCatalogRow): ModelCatalogEntry {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    api: row.api,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
    reasoning: row.reasoning,
    input: [...row.input],
    ...(row.compat ? { compat: row.compat } : {}),
    ...(row.mediaInput ? { mediaInput: row.mediaInput } : {}),
    status: row.status,
    ...(row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.replaces ? { replaces: [...row.replaces] } : {}),
    ...(row.replacedBy ? { replacedBy: row.replacedBy } : {}),
  };
}

function selectProviderRows(
  rows: readonly NormalizedModelCatalogRow[],
  providerIds: ReadonlySet<string>,
): NormalizedModelCatalogRow[] {
  return rows.filter((row) => providerIds.has(normalizeProviderId(row.provider)));
}

function entryKey(entry: Pick<ModelCatalogEntry, "provider" | "id">): string {
  return modelKey(normalizeProviderId(entry.provider), entry.id.trim().toLowerCase());
}

function routeKey(entry: ModelCatalogEntry): string {
  return `${entryKey(entry)}\0${entry.api ?? ""}\0${entry.baseUrl ?? ""}`;
}

function resolveConfiguredProviderCoverage(
  cfg: OpenClawConfig,
  providerIds: ReadonlySet<string>,
  ownedProviderIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const coveredProviders = new Set<string>();
  for (const [provider, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    const normalizedProvider = normalizeProviderId(provider);
    if (
      providerIds.has(normalizedProvider) &&
      !ownedProviderIds.has(normalizedProvider) &&
      (providerConfig.models ?? []).some(
        (model) => providerConfig.api !== undefined || model.api !== undefined,
      )
    ) {
      // Unowned custom providers have no runtime catalog beyond their explicit rows.
      // Plugin-owned providers remain discoverable unless models.mode is replace.
      coveredProviders.add(normalizedProvider);
    }
  }
  return coveredProviders;
}

function enrichPersistedEntry(
  entry: ModelCatalogEntry,
  manifestEntry: ModelCatalogEntry | undefined,
): ModelCatalogEntry {
  if (!manifestEntry) {
    return entry;
  }
  return {
    ...manifestEntry,
    ...entry,
    name: entry.name || manifestEntry.name,
    ...(entry.contextWindow === undefined && manifestEntry.contextWindow !== undefined
      ? { contextWindow: manifestEntry.contextWindow }
      : {}),
    ...(entry.contextTokens === undefined && manifestEntry.contextTokens !== undefined
      ? { contextTokens: manifestEntry.contextTokens }
      : {}),
    ...(entry.reasoning === undefined && manifestEntry.reasoning !== undefined
      ? { reasoning: manifestEntry.reasoning }
      : {}),
    ...(entry.input === undefined && manifestEntry.input !== undefined
      ? { input: manifestEntry.input }
      : {}),
  };
}

function mergeSnapshotEntries(snapshots: readonly ModelCatalogSnapshot[]): ModelCatalogSnapshot {
  const entries = new Map<string, ModelCatalogEntry>();
  const staticEntries = new Map<string, ModelCatalogEntry>();
  const routeVariants = new Map<string, ModelCatalogEntry>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      entries.set(entryKey(entry), entry);
    }
    for (const entry of snapshot.staticEntries ?? []) {
      staticEntries.set(entryKey(entry), entry);
    }
    for (const entry of snapshot.routeVariants) {
      routeVariants.set(routeKey(entry), entry);
    }
  }
  return {
    entries: [...entries.values()].toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
    ),
    routeVariants: [...routeVariants.values()].toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.id.localeCompare(right.id) ||
        (left.api ?? "").localeCompare(right.api ?? "") ||
        (left.baseUrl ?? "").localeCompare(right.baseUrl ?? ""),
    ),
    staticEntries: [...staticEntries.values()].toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
    ),
  };
}

/** Builds an auth-scoped snapshot from manifest metadata already loaded by the command. */
export async function loadScopedListModelCatalogSnapshot(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  providerIds: readonly string[];
  runtimeProviderIds?: readonly string[];
  manifestFallbackProviderIds?: readonly string[];
  configuredKeys: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ModelCatalogSnapshot> {
  const providerIds = new Set(params.providerIds.map(normalizeProviderId).filter(Boolean));
  if (providerIds.size === 0) {
    return { entries: [], routeVariants: [], staticEntries: [] };
  }
  const loaderParams = {
    cfg: params.cfg,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
  };
  const manifestEntries = selectProviderRows(
    loadManifestCatalogRowsForList(loaderParams),
    providerIds,
  ).map(toCatalogEntry);
  const manifestByKey = new Map(manifestEntries.map((entry) => [entryKey(entry), entry]));
  const configuredKeys = new Set(params.configuredKeys.map((key) => key.trim().toLowerCase()));
  const manifestFallbackProviderIds = new Set(
    (params.manifestFallbackProviderIds ?? [])
      .map(normalizeProviderId)
      .filter((provider) => providerIds.has(provider)),
  );
  const staticEntries = selectProviderRows(
    loadStaticManifestCatalogRowsForList(loaderParams),
    providerIds,
  ).map(toCatalogEntry);
  const { loadPersistedListCatalogEntries } = await persistedCatalogModuleLoader.load();
  const persistedEntries = loadPersistedListCatalogEntries({
    agentDir: params.agentDir,
    providerIds,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
  }).map((entry) => enrichPersistedEntry(entry, manifestByKey.get(entryKey(entry))));
  const { ownedProviderIds, completeProviderIds } = resolveManifestCatalogCoverageForList({
    cfg: params.cfg,
    providerIds,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
  });
  const admittedEntries = new Map<string, ModelCatalogEntry>();
  for (const entry of [...staticEntries, ...persistedEntries]) {
    admittedEntries.set(entryKey(entry), entry);
  }
  for (const entry of manifestEntries) {
    if (
      (configuredKeys.has(entryKey(entry)) ||
        manifestFallbackProviderIds.has(normalizeProviderId(entry.provider))) &&
      !admittedEntries.has(entryKey(entry))
    ) {
      admittedEntries.set(entryKey(entry), entry);
    }
  }
  const admittedKeys = new Set(admittedEntries.keys());
  const routeVariants = [...persistedEntries];
  for (const entry of manifestEntries) {
    if (admittedKeys.has(entryKey(entry))) {
      routeVariants.push(entry);
    }
  }
  const lightweightSnapshot: ModelCatalogSnapshot = {
    entries: [...admittedEntries.values()],
    routeVariants,
    staticEntries,
  };
  const coveredProviders = new Set([
    ...completeProviderIds,
    ...resolveConfiguredProviderCoverage(params.cfg, providerIds, ownedProviderIds),
  ]);
  const runtimeProviderIds = new Set(
    (params.runtimeProviderIds ?? params.providerIds)
      .map(normalizeProviderId)
      .filter((provider) => providerIds.has(provider)),
  );
  const uncoveredProviders = [...runtimeProviderIds].filter(
    (provider) => !coveredProviders.has(provider),
  );
  if (uncoveredProviders.length === 0) {
    return mergeSnapshotEntries([lightweightSnapshot]);
  }
  const { prepareScopedReadOnlyLiveModelCatalog } = await preparedScopedCatalogModuleLoader.load();
  const fallbackSnapshot = await prepareScopedReadOnlyLiveModelCatalog(
    {
      config: params.cfg,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      agentDir: params.agentDir,
      inheritedAuthDir: params.inheritedAuthDir ?? params.agentDir,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      readOnly: true,
    },
    uncoveredProviders,
  );
  return mergeSnapshotEntries([lightweightSnapshot, fallbackSnapshot]);
}
