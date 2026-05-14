import path from "node:path";
import { resolveIsNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../infra/diagnostics-timeline.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { resolveDefaultPluginNpmDir } from "./install-paths.js";
import { hashJson, safeFileSignature } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  loadPluginManifestRegistryForInstalledIndex,
  resolveInstalledManifestRegistryIndexFingerprint,
} from "./manifest-registry-installed.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import type {
  LoadPluginMetadataSnapshotParams,
  PluginMetadataSnapshot,
  PluginMetadataSnapshotOwnerMaps,
} from "./plugin-metadata-snapshot.types.js";
import { createPluginRegistryIdNormalizer } from "./plugin-registry-id-normalizer.js";
import {
  loadPluginRegistrySnapshotWithMetadata,
  type PluginRegistrySnapshotSource,
} from "./plugin-registry.js";

type PluginMetadataSnapshotMemo = {
  key: string;
  snapshot: PluginMetadataSnapshot;
};

let pluginMetadataSnapshotMemo: PluginMetadataSnapshotMemo | undefined;

export function clearLoadPluginMetadataSnapshotMemo(): void {
  pluginMetadataSnapshotMemo = undefined;
}

const MEMO_RELEVANT_ENV_KEYS = [
  "APPDATA",
  "HOME",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_COMPATIBILITY_HOST_VERSION",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS",
  "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY",
  "OPENCLAW_HOME",
  "OPENCLAW_NIX_MODE",
  "OPENCLAW_STATE_DIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
] as const;
export type {
  LoadPluginMetadataSnapshotParams,
  PluginMetadataManifestView,
  PluginMetadataRegistryView,
  PluginMetadataSnapshot,
  PluginMetadataSnapshotMetrics,
  PluginMetadataSnapshotOwnerMaps,
  PluginMetadataSnapshotRegistryDiagnostic,
} from "./plugin-metadata-snapshot.types.js";

function fileFingerprint(filePath: string): unknown {
  const signature = safeFileSignature(filePath);
  if (!signature) {
    return [filePath, "missing"];
  }
  return [filePath, signature.size, signature.mtimeMs, signature.ctimeMs];
}

function pickMemoRelevantEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    MEMO_RELEVANT_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function cloneOwnerMaps(owners: PluginMetadataSnapshotOwnerMaps): PluginMetadataSnapshotOwnerMaps {
  return {
    channels: new Map(owners.channels),
    channelConfigs: new Map(owners.channelConfigs),
    providers: new Map(owners.providers),
    modelCatalogProviders: new Map(owners.modelCatalogProviders),
    cliBackends: new Map(owners.cliBackends),
    setupProviders: new Map(owners.setupProviders),
    commandAliases: new Map(owners.commandAliases),
    contracts: new Map(owners.contracts),
  };
}

function cloneSnapshotValue<T>(value: T): T {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function clonePluginManifestRecord(plugin: PluginManifestRecord): PluginManifestRecord {
  return cloneSnapshotValue(plugin);
}

function clonePluginMetadataSnapshot(snapshot: PluginMetadataSnapshot): PluginMetadataSnapshot {
  const plugins = snapshot.plugins.map(clonePluginManifestRecord);
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const diagnostics = snapshot.diagnostics.map(cloneSnapshotValue);
  return {
    ...snapshot,
    index: {
      ...snapshot.index,
      installRecords: cloneSnapshotValue(snapshot.index.installRecords ?? {}),
      plugins: snapshot.index.plugins.map(cloneSnapshotValue),
      diagnostics: snapshot.index.diagnostics.map(cloneSnapshotValue),
    },
    registryDiagnostics: snapshot.registryDiagnostics.map(cloneSnapshotValue),
    manifestRegistry: {
      ...snapshot.manifestRegistry,
      plugins,
      diagnostics,
    },
    plugins,
    diagnostics,
    byPluginId: new Map(
      [...snapshot.byPluginId.entries()].map(([pluginId, plugin]) => [
        pluginId,
        pluginsById.get(plugin.id) ?? clonePluginManifestRecord(plugin),
      ]),
    ),
    owners: cloneOwnerMaps(snapshot.owners),
    metrics: { ...snapshot.metrics },
  };
}

function resolvePersistedRegistryMemoFingerprint(params: {
  env: NodeJS.ProcessEnv;
  preferPersisted?: boolean;
  stateDir?: string;
}): unknown {
  const indexPath = resolveInstalledPluginIndexStorePath({
    env: params.env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
  });
  const npmRoot = params.stateDir
    ? path.join(params.stateDir, "npm")
    : resolveDefaultPluginNpmDir(params.env);
  return {
    disabled:
      params.preferPersisted === false || params.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY,
    index: fileFingerprint(indexPath),
    npmPackageJson: fileFingerprint(path.join(npmRoot, "package.json")),
  };
}

function computePluginMetadataSnapshotMemoKey(params: LoadPluginMetadataSnapshotParams): string {
  const env = params.env ?? process.env;
  const indexFingerprint = params.index
    ? resolveInstalledManifestRegistryIndexFingerprint(params.index)
    : undefined;
  return hashJson({
    controlPlane: resolvePluginControlPlaneFingerprint({
      config: params.config,
      env,
      workspaceDir: params.workspaceDir,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      ...(indexFingerprint ? { inventoryFingerprint: indexFingerprint } : {}),
    }),
    cwd: process.cwd(),
    env: pickMemoRelevantEnv(env),
    index: indexFingerprint ?? null,
    pathPolicy: {
      compatibilityHostVersion: resolveCompatibilityHostVersion(env),
      nixMode: resolveIsNixMode(env),
    },
    preferPersisted: params.preferPersisted ?? null,
    registry: resolvePersistedRegistryMemoFingerprint({
      env,
      ...(params.stateDir ? { stateDir: resolveUserPath(params.stateDir, env) } : {}),
      ...(params.preferPersisted !== undefined ? { preferPersisted: params.preferPersisted } : {}),
    }),
    stateDir: params.stateDir ? resolveUserPath(params.stateDir, env) : null,
    workspaceDir: params.workspaceDir ?? null,
  });
}

function resolvePluginMetadataControlPlaneFingerprint(
  params: Pick<LoadPluginMetadataSnapshotParams, "config" | "env" | "workspaceDir"> & {
    index?: InstalledPluginIndex;
    policyHash?: string;
  },
): string {
  return resolvePluginControlPlaneFingerprint(params);
}

function indexesMatch(
  left: InstalledPluginIndex | undefined,
  right: InstalledPluginIndex | undefined,
): boolean {
  if (!left || !right) {
    return true;
  }
  return (
    resolveInstalledManifestRegistryIndexFingerprint(left) ===
    resolveInstalledManifestRegistryIndexFingerprint(right)
  );
}

function normalizeInstalledPluginIndex(index: InstalledPluginIndex): InstalledPluginIndex {
  return {
    version: index.version ?? 1,
    hostContractVersion: index.hostContractVersion ?? "",
    compatRegistryVersion: index.compatRegistryVersion ?? "",
    migrationVersion: index.migrationVersion ?? 1,
    policyHash: index.policyHash ?? "",
    generatedAtMs: index.generatedAtMs ?? 0,
    installRecords: index.installRecords ?? {},
    plugins: index.plugins ?? [],
    diagnostics: index.diagnostics ?? [],
    ...(index.warning ? { warning: index.warning } : {}),
    ...(index.refreshReason ? { refreshReason: index.refreshReason } : {}),
  } as InstalledPluginIndex;
}

export function isPluginMetadataSnapshotCompatible(params: {
  snapshot: Pick<
    PluginMetadataSnapshot,
    "configFingerprint" | "index" | "policyHash" | "workspaceDir"
  >;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  index?: InstalledPluginIndex;
}): boolean {
  const env = params.env ?? process.env;
  return (
    params.snapshot.policyHash === resolveInstalledPluginIndexPolicyHash(params.config) &&
    (!params.snapshot.configFingerprint ||
      params.snapshot.configFingerprint ===
        resolvePluginMetadataControlPlaneFingerprint({
          config: params.config,
          env,
          index: params.index ?? params.snapshot.index,
          policyHash: params.snapshot.policyHash,
          workspaceDir: params.workspaceDir,
        })) &&
    (params.snapshot.workspaceDir ?? "") === (params.workspaceDir ?? "") &&
    indexesMatch(params.snapshot.index, params.index)
  );
}

function appendOwner(owners: Map<string, string[]>, ownedId: string, pluginId: string): void {
  const existing = owners.get(ownedId);
  if (existing) {
    existing.push(pluginId);
    return;
  }
  owners.set(ownedId, [pluginId]);
}

function freezeOwnerMap(owners: Map<string, string[]>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    [...owners.entries()].map(([ownedId, pluginIds]) => [ownedId, Object.freeze([...pluginIds])]),
  );
}

function buildPluginMetadataOwnerMaps(
  plugins: readonly PluginManifestRecord[],
): PluginMetadataSnapshotOwnerMaps {
  const channels = new Map<string, string[]>();
  const channelConfigs = new Map<string, string[]>();
  const providers = new Map<string, string[]>();
  const modelCatalogProviders = new Map<string, string[]>();
  const cliBackends = new Map<string, string[]>();
  const setupProviders = new Map<string, string[]>();
  const commandAliases = new Map<string, string[]>();
  const contracts = new Map<string, string[]>();

  for (const plugin of plugins) {
    for (const channelId of plugin.channels ?? []) {
      appendOwner(channels, channelId, plugin.id);
    }
    for (const channelId of Object.keys(plugin.channelConfigs ?? {})) {
      appendOwner(channelConfigs, channelId, plugin.id);
    }
    for (const providerId of plugin.providers ?? []) {
      appendOwner(providers, providerId, plugin.id);
    }
    for (const providerId of Object.keys(plugin.modelCatalog?.providers ?? {})) {
      appendOwner(modelCatalogProviders, providerId, plugin.id);
    }
    for (const providerId of Object.keys(plugin.modelCatalog?.aliases ?? {})) {
      appendOwner(modelCatalogProviders, providerId, plugin.id);
    }
    for (const cliBackendId of plugin.cliBackends ?? []) {
      appendOwner(cliBackends, cliBackendId, plugin.id);
    }
    for (const cliBackendId of plugin.setup?.cliBackends ?? []) {
      appendOwner(cliBackends, cliBackendId, plugin.id);
    }
    for (const setupProvider of plugin.setup?.providers ?? []) {
      appendOwner(setupProviders, setupProvider.id, plugin.id);
    }
    for (const commandAlias of plugin.commandAliases ?? []) {
      appendOwner(commandAliases, commandAlias.name, plugin.id);
    }
    for (const [contract, values] of Object.entries(plugin.contracts ?? {})) {
      if (Array.isArray(values) && values.length > 0) {
        appendOwner(contracts, contract, plugin.id);
      }
    }
  }

  return {
    channels: freezeOwnerMap(channels),
    channelConfigs: freezeOwnerMap(channelConfigs),
    providers: freezeOwnerMap(providers),
    modelCatalogProviders: freezeOwnerMap(modelCatalogProviders),
    cliBackends: freezeOwnerMap(cliBackends),
    setupProviders: freezeOwnerMap(setupProviders),
    commandAliases: freezeOwnerMap(commandAliases),
    contracts: freezeOwnerMap(contracts),
  };
}

export function listPluginOriginsFromMetadataSnapshot(
  snapshot: Pick<PluginMetadataSnapshot, "plugins">,
): ReadonlyMap<string, PluginManifestRecord["origin"]> {
  return new Map(snapshot.plugins.map((record) => [record.id, record.origin]));
}

// Process-local memoization is keyed by stable registry/config/env inputs. It
// intentionally does not watch arbitrary direct plugin file edits after a
// persisted registry has been accepted; registry refreshes and process restarts
// are the freshness boundaries for that broader edit flow.
export function loadPluginMetadataSnapshot(
  params: LoadPluginMetadataSnapshotParams,
): PluginMetadataSnapshot {
  const activeTimelineSpan = getActiveDiagnosticsTimelineSpan();
  const memoKey = computePluginMetadataSnapshotMemoKey(params);
  const memo = pluginMetadataSnapshotMemo;
  if (memo?.key === memoKey) {
    return measureDiagnosticsTimelineSpanSync(
      "plugins.metadata.scan",
      () => clonePluginMetadataSnapshot(memo.snapshot),
      {
        phase: activeTimelineSpan?.phase ?? "startup",
        config: params.config,
        env: params.env,
        attributes: {
          cacheHit: true,
          hasWorkspaceDir: params.workspaceDir !== undefined,
          hasInstalledIndex: params.index !== undefined,
        },
      },
    );
  }

  const result = measureDiagnosticsTimelineSpanSync(
    "plugins.metadata.scan",
    () => loadPluginMetadataSnapshotImpl(params),
    {
      phase: activeTimelineSpan?.phase ?? "startup",
      config: params.config,
      env: params.env,
      attributes: {
        hasWorkspaceDir: params.workspaceDir !== undefined,
        hasInstalledIndex: params.index !== undefined,
      },
    },
  );
  if (canMemoizePluginMetadataSnapshotResult(result)) {
    pluginMetadataSnapshotMemo = {
      key: memoKey,
      snapshot: clonePluginMetadataSnapshot(result.snapshot),
    };
  }
  return result.snapshot;
}

function canMemoizePluginMetadataSnapshotResult(result: {
  registrySource: PluginRegistrySnapshotSource;
  snapshot: PluginMetadataSnapshot;
}): boolean {
  if (result.snapshot.index.plugins.length === 0) {
    return false;
  }
  if (result.registrySource !== "derived") {
    return true;
  }
  return (
    result.snapshot.registryDiagnostics.length > 0 &&
    result.snapshot.registryDiagnostics.every(
      (diagnostic) => diagnostic.code === "persisted-registry-stale-policy",
    )
  );
}

function loadPluginMetadataSnapshotImpl(params: LoadPluginMetadataSnapshotParams): {
  snapshot: PluginMetadataSnapshot;
  registrySource: PluginRegistrySnapshotSource;
} {
  const totalStartedAt = performance.now();
  const registryStartedAt = performance.now();
  const registryResult = loadPluginRegistrySnapshotWithMetadata({
    config: params.config,
    workspaceDir: params.workspaceDir,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    env: params.env,
    ...(params.preferPersisted !== undefined ? { preferPersisted: params.preferPersisted } : {}),
    ...(params.index ? { index: params.index } : {}),
  }) ?? {
    source: "derived" as const,
    snapshot: { plugins: [] },
    diagnostics: [],
  };
  const registrySnapshotMs = performance.now() - registryStartedAt;
  const index = normalizeInstalledPluginIndex(registryResult.snapshot);
  const manifestStartedAt = performance.now();
  const manifestRegistry =
    index.plugins.length === 0
      ? loadPluginManifestRegistry({
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          diagnostics: [...index.diagnostics],
          installRecords: index.installRecords,
        })
      : loadPluginManifestRegistryForInstalledIndex({
          index,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: params.env,
          includeDisabled: true,
        });
  const manifestRegistryMs = performance.now() - manifestStartedAt;
  const normalizePluginId = createPluginRegistryIdNormalizer(index, { manifestRegistry });
  const byPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
  const ownerMapsStartedAt = performance.now();
  const owners = buildPluginMetadataOwnerMaps(manifestRegistry.plugins);
  const ownerMapsMs = performance.now() - ownerMapsStartedAt;
  const totalMs = performance.now() - totalStartedAt;

  return {
    registrySource: registryResult.source,
    snapshot: {
      policyHash: index.policyHash,
      configFingerprint: resolvePluginMetadataControlPlaneFingerprint({
        config: params.config,
        env: params.env,
        index,
        policyHash: index.policyHash,
        workspaceDir: params.workspaceDir,
      }),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      index,
      registryDiagnostics: registryResult.diagnostics,
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      diagnostics: manifestRegistry.diagnostics,
      byPluginId,
      normalizePluginId,
      owners,
      metrics: {
        registrySnapshotMs,
        manifestRegistryMs,
        ownerMapsMs,
        totalMs,
        indexPluginCount: index.plugins.length,
        manifestPluginCount: manifestRegistry.plugins.length,
      },
    },
  };
}
