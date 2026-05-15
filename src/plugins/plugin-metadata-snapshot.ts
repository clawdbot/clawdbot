import fs from "node:fs";
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
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
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
  registryState?: PersistedRegistryMemoState;
  snapshot: PluginMetadataSnapshot;
};

type PersistedRegistryMemoState = {
  contextHash: string;
  fastHash: string;
  fingerprint: unknown;
  watchedFilesHash: string;
  watchedFiles: readonly string[];
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
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
    return [filePath, kind, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
  } catch {
    return [filePath, "missing"];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableMemoValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableMemoValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableMemoValue(entry)]),
  );
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function resolvePluginFilePath(
  pluginDir: string,
  filePath: string | undefined,
  options: { allowSymlinkOutsideRoot?: boolean } = {},
):
  | { status: "ok"; path: string }
  | { status: "outside-root"; path: string }
  | { status: "missing-root"; path: string } {
  if (!filePath) {
    return { status: "missing-root", path: "" };
  }
  const rootDir = path.resolve(pluginDir);
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(rootDir, filePath);
  if (!isPathInsideOrEqual(resolved, rootDir)) {
    return { status: "outside-root", path: resolved };
  }
  const rootRealPath = tryRealpath(rootDir);
  const targetRealPath = tryRealpath(resolved);
  if (
    rootRealPath &&
    targetRealPath &&
    !isPathInsideOrEqual(targetRealPath, rootRealPath) &&
    !options.allowSymlinkOutsideRoot
  ) {
    return { status: "outside-root", path: resolved };
  }
  return { status: "ok", path: resolved };
}

function persistedPluginFileFingerprint(
  rootDir: string | undefined,
  filePath: string | undefined,
  options: { allowSymlinkOutsideRoot?: boolean; watchedFiles?: Set<string> } = {},
): unknown {
  if (!filePath) {
    return null;
  }
  if (!rootDir) {
    return [filePath, "missing-root"];
  }
  const resolved = resolvePluginFilePath(rootDir, filePath, {
    allowSymlinkOutsideRoot: options.allowSymlinkOutsideRoot,
  });
  if (resolved.status !== "ok") {
    return [filePath, resolved.status];
  }
  options.watchedFiles?.add(resolved.path);
  return fileFingerprint(resolved.path);
}

function watchedFileFingerprint(filePath: string | undefined, watchedFiles: Set<string>): unknown {
  if (!filePath) {
    return null;
  }
  watchedFiles.add(filePath);
  return fileFingerprint(filePath);
}

function resolveInstallRecordPath(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const normalized = normalizeString(value);
  return normalized ? resolveUserPath(normalized, env) : undefined;
}

function installRecordPathFingerprints(
  env: NodeJS.ProcessEnv,
  records: unknown,
  watchedFiles: Set<string>,
): readonly unknown[] {
  if (!isRecord(records)) {
    return [];
  }
  return Object.entries(records)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([pluginId, rawRecord]) => {
      if (!isRecord(rawRecord)) {
        return [pluginId, rawRecord];
      }
      const installPath = normalizeString(rawRecord.installPath);
      const sourcePath = normalizeString(rawRecord.sourcePath);
      const resolvedInstallPath = resolveInstallRecordPath(rawRecord.installPath, env);
      const resolvedSourcePath = resolveInstallRecordPath(rawRecord.sourcePath, env);
      return [
        pluginId,
        installPath,
        sourcePath,
        watchedFileFingerprint(
          resolvedInstallPath ? path.join(resolvedInstallPath, "package.json") : undefined,
          watchedFiles,
        ),
        watchedFileFingerprint(
          resolvedInstallPath ? path.join(resolvedInstallPath, "openclaw.plugin.json") : undefined,
          watchedFiles,
        ),
        watchedFileFingerprint(resolvedSourcePath, watchedFiles),
        watchedFileFingerprint(
          resolvedSourcePath ? path.join(resolvedSourcePath, "package.json") : undefined,
          watchedFiles,
        ),
        watchedFileFingerprint(
          resolvedSourcePath ? path.join(resolvedSourcePath, "openclaw.plugin.json") : undefined,
          watchedFiles,
        ),
      ];
    });
}

function managedNpmDependencyMetadataFingerprints(
  npmRoot: string,
  watchedFiles: Set<string>,
): readonly unknown[] {
  const rootManifest = readJsonObject(path.join(npmRoot, "package.json"));
  const dependencies = isRecord(rootManifest?.dependencies) ? rootManifest.dependencies : {};
  const nodeModulesRoot = path.join(npmRoot, "node_modules");
  return Object.entries(dependencies)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([packageName, rawSpec]) => {
      const dependencySpec = normalizeString(rawSpec);
      if (!dependencySpec) {
        return [packageName, rawSpec];
      }
      const packageDir = path.resolve(nodeModulesRoot, packageName);
      if (!isPathInsideOrEqual(packageDir, path.resolve(nodeModulesRoot))) {
        return [packageName, dependencySpec, "outside-node-modules"];
      }
      return [
        packageName,
        dependencySpec,
        watchedFileFingerprint(path.join(packageDir, "package.json"), watchedFiles),
        watchedFileFingerprint(path.join(packageDir, "openclaw.plugin.json"), watchedFiles),
      ];
    });
}

function resolveRecordPackageJsonPath(record: Record<string, unknown>): string | undefined {
  const packageJson = record.packageJson;
  if (!isRecord(packageJson)) {
    return undefined;
  }
  return normalizeString(packageJson.path);
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

function resolvePersistedRegistryFastMemoFingerprint(params: {
  env: NodeJS.ProcessEnv;
  preferPersisted?: boolean;
  stateDir?: string;
}): Record<string, unknown> {
  const disabledByEnv = params.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY?.trim().toLowerCase();
  const disabled =
    params.preferPersisted === false ||
    (Boolean(disabledByEnv) &&
      disabledByEnv !== "0" &&
      disabledByEnv !== "false" &&
      disabledByEnv !== "no");
  if (disabled) {
    return { disabled: true };
  }
  const indexPath = resolveInstalledPluginIndexStorePath({
    env: params.env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
  });
  const npmRoot = params.stateDir
    ? path.join(params.stateDir, "npm")
    : resolveDefaultPluginNpmDir(params.env);
  return {
    index: fileFingerprint(indexPath),
    npmPackageJson: fileFingerprint(path.join(npmRoot, "package.json")),
  };
}

function resolvePersistedRegistryMemoContextHash(params: {
  env: NodeJS.ProcessEnv;
  fastFingerprint: unknown;
  preferPersisted?: boolean;
  stateDir?: string;
}): string {
  return hashJson({
    env: pickMemoRelevantEnv(params.env),
    fastFingerprint: params.fastFingerprint,
    preferPersisted: params.preferPersisted ?? null,
    stateDir: params.stateDir ?? null,
  });
}

function hashWatchedFiles(watchedFiles: readonly string[]): string {
  return hashJson(watchedFiles.map((filePath) => fileFingerprint(filePath)));
}

function resolvePersistedRegistryMemoState(params: {
  env: NodeJS.ProcessEnv;
  index?: InstalledPluginIndex;
  preferPersisted?: boolean;
  stateDir?: string;
}): PersistedRegistryMemoState {
  const fastFingerprint = resolvePersistedRegistryFastMemoFingerprint(params);
  const fastHash = hashJson(fastFingerprint);
  const contextHash = resolvePersistedRegistryMemoContextHash({
    ...params,
    fastFingerprint,
  });
  if (isRecord(fastFingerprint) && fastFingerprint.disabled === true) {
    return {
      contextHash,
      fastHash,
      fingerprint: fastFingerprint,
      watchedFiles: [],
      watchedFilesHash: hashJson([]),
    };
  }
  const indexPath = resolveInstalledPluginIndexStorePath({
    env: params.env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
  });
  const npmRoot = params.stateDir
    ? path.join(params.stateDir, "npm")
    : resolveDefaultPluginNpmDir(params.env);
  const index = params.index ?? readJsonObject(indexPath);
  const plugins = Array.isArray(index?.plugins) ? index.plugins : [];
  const diagnostics = Array.isArray(index?.diagnostics) ? index.diagnostics : [];
  const pluginRootById = new Map<string, string>();
  const watchedFiles = new Set<string>();
  for (const rawPlugin of plugins) {
    if (!isRecord(rawPlugin)) {
      continue;
    }
    const pluginId = normalizeString(rawPlugin.pluginId);
    const rootDir = normalizeString(rawPlugin.rootDir);
    if (pluginId && rootDir) {
      pluginRootById.set(pluginId, rootDir);
    }
  }
  const installRecords =
    params.index?.installRecords ??
    loadInstalledPluginIndexInstallRecordsSync({
      env: params.env,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    });
  const watchedPlugins = plugins.map((rawPlugin) => {
    if (!isRecord(rawPlugin)) {
      return rawPlugin;
    }
    const rootDir = normalizeString(rawPlugin.rootDir);
    const manifestPath = normalizeString(rawPlugin.manifestPath);
    const packageJsonPath = resolveRecordPackageJsonPath(rawPlugin);
    const source = normalizeString(rawPlugin.source);
    const setupSource = normalizeString(rawPlugin.setupSource);
    return [
      normalizeString(rawPlugin.pluginId),
      rootDir,
      rootDir ? fileFingerprint(rootDir) : null,
      manifestPath,
      persistedPluginFileFingerprint(rootDir, manifestPath, { watchedFiles }),
      source,
      persistedPluginFileFingerprint(rootDir, source, { watchedFiles }),
      setupSource,
      persistedPluginFileFingerprint(rootDir, setupSource, { watchedFiles }),
      packageJsonPath,
      persistedPluginFileFingerprint(rootDir, packageJsonPath, {
        allowSymlinkOutsideRoot: true,
        watchedFiles,
      }),
    ];
  });
  const watchedDiagnostics = diagnostics.map((rawDiagnostic) => {
    if (!isRecord(rawDiagnostic)) {
      return rawDiagnostic;
    }
    const pluginId = normalizeString(rawDiagnostic.pluginId);
    const source = normalizeString(rawDiagnostic.source);
    return [
      pluginId,
      source,
      persistedPluginFileFingerprint(pluginId ? pluginRootById.get(pluginId) : undefined, source, {
        watchedFiles,
      }),
    ];
  });
  const installRecordFiles = installRecordPathFingerprints(
    params.env,
    installRecords,
    watchedFiles,
  );
  const managedNpmDependencyFiles = managedNpmDependencyMetadataFingerprints(npmRoot, watchedFiles);
  const watchedFilesList = [...watchedFiles].toSorted();
  return {
    contextHash,
    fastHash,
    fingerprint: {
      ...fastFingerprint,
      indexHash: hashJson(stableMemoValue(index) ?? null),
      installRecords: hashJson(stableMemoValue(installRecords)),
      installRecordFiles,
      managedNpmDependencyFiles,
      npmPackageJson: fileFingerprint(path.join(npmRoot, "package.json")),
      plugins: watchedPlugins,
      diagnostics: watchedDiagnostics,
    },
    watchedFiles: watchedFilesList,
    watchedFilesHash: hashWatchedFiles(watchedFilesList),
  };
}

function resolvePersistedRegistryMemoStateForLookup(
  params: {
    env: NodeJS.ProcessEnv;
    preferPersisted?: boolean;
    stateDir?: string;
  },
  memo: PluginMetadataSnapshotMemo | undefined,
): PersistedRegistryMemoState {
  const fastFingerprint = resolvePersistedRegistryFastMemoFingerprint(params);
  const fastHash = hashJson(fastFingerprint);
  const contextHash = resolvePersistedRegistryMemoContextHash({
    ...params,
    fastFingerprint,
  });
  const registryState = memo?.registryState;
  if (
    registryState &&
    registryState.contextHash === contextHash &&
    registryState.fastHash === fastHash &&
    hashWatchedFiles(registryState.watchedFiles) === registryState.watchedFilesHash
  ) {
    return registryState;
  }
  return resolvePersistedRegistryMemoState(params);
}

function computePluginMetadataSnapshotMemoKey(params: {
  params: LoadPluginMetadataSnapshotParams;
  registryState: PersistedRegistryMemoState;
}): string {
  const { params: snapshotParams, registryState } = params;
  const env = snapshotParams.env ?? process.env;
  const indexFingerprint = snapshotParams.index
    ? resolveInstalledManifestRegistryIndexFingerprint(snapshotParams.index)
    : undefined;
  return hashJson({
    controlPlane: resolvePluginControlPlaneFingerprint({
      config: snapshotParams.config,
      env,
      workspaceDir: snapshotParams.workspaceDir,
      policyHash: resolveInstalledPluginIndexPolicyHash(snapshotParams.config),
      ...(indexFingerprint ? { inventoryFingerprint: indexFingerprint } : {}),
    }),
    cwd: process.cwd(),
    env: pickMemoRelevantEnv(env),
    index: indexFingerprint ?? null,
    pathPolicy: {
      compatibilityHostVersion: resolveCompatibilityHostVersion(env),
      nixMode: resolveIsNixMode(env),
    },
    preferPersisted: snapshotParams.preferPersisted ?? null,
    registry: registryState.fingerprint,
    stateDir: snapshotParams.stateDir ? resolveUserPath(snapshotParams.stateDir, env) : null,
    workspaceDir: snapshotParams.workspaceDir ?? null,
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

// Process-local memoization keeps the hot snapshot work cached while checking
// the persisted metadata files that the installed-index loader consumes.
export function loadPluginMetadataSnapshot(
  params: LoadPluginMetadataSnapshotParams,
): PluginMetadataSnapshot {
  const activeTimelineSpan = getActiveDiagnosticsTimelineSpan();
  const memo = pluginMetadataSnapshotMemo;
  const env = params.env ?? process.env;
  const registryState = resolvePersistedRegistryMemoStateForLookup(
    {
      env,
      ...(params.stateDir ? { stateDir: resolveUserPath(params.stateDir, env) } : {}),
      ...(params.preferPersisted !== undefined ? { preferPersisted: params.preferPersisted } : {}),
    },
    memo,
  );
  const memoKey = computePluginMetadataSnapshotMemoKey({ params, registryState });
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
    const cachedRegistryState =
      result.registrySource === "derived"
        ? resolvePersistedRegistryMemoState({
            env,
            index: result.snapshot.index,
            ...(params.stateDir ? { stateDir: resolveUserPath(params.stateDir, env) } : {}),
            ...(params.preferPersisted !== undefined
              ? { preferPersisted: params.preferPersisted }
              : {}),
          })
        : registryState;
    pluginMetadataSnapshotMemo = {
      key: computePluginMetadataSnapshotMemoKey({ params, registryState: cachedRegistryState }),
      registryState: cachedRegistryState,
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
