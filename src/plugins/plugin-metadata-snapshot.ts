import fs from "node:fs";
import path from "node:path";
import { resolveIsNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getActiveDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../infra/diagnostics-timeline.js";
import { isRecord } from "../shared/record-coerce.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { resolveDefaultPluginNpmDir } from "./install-paths.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  loadPluginManifestRegistryForInstalledIndex,
  resolveInstalledManifestRegistryIndexFingerprint,
} from "./manifest-registry-installed.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import type {
  LoadPluginMetadataSnapshotParams,
  PluginMetadataSnapshot,
  PluginMetadataSnapshotOwnerMaps,
  ResolvePluginMetadataSnapshotParams,
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
};

const MAX_PLUGIN_METADATA_SNAPSHOT_MEMOS = 8;

let pluginMetadataSnapshotMemos: PluginMetadataSnapshotMemo[] = [];

export function clearLoadPluginMetadataSnapshotMemo(): void {
  pluginMetadataSnapshotMemos = [];
}

registerPluginMetadataProcessMemoLifecycleClear(clearLoadPluginMetadataSnapshotMemo);

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
  ResolvePluginMetadataSnapshotParams,
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

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

function pickMemoRelevantEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    MEMO_RELEVANT_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function throwReadonlyPluginMetadataMutation(): never {
  throw new TypeError("Plugin metadata snapshots are immutable");
}

function freezeSnapshotValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      freezeSnapshotValue(key, seen);
      freezeSnapshotValue(entry, seen);
    }
    Object.defineProperties(value, {
      clear: { value: throwReadonlyPluginMetadataMutation },
      delete: { value: throwReadonlyPluginMetadataMutation },
      set: { value: throwReadonlyPluginMetadataMutation },
    });
    return Object.freeze(value);
  }
  if (value instanceof Set) {
    for (const entry of value) {
      freezeSnapshotValue(entry, seen);
    }
    Object.defineProperties(value, {
      add: { value: throwReadonlyPluginMetadataMutation },
      clear: { value: throwReadonlyPluginMetadataMutation },
      delete: { value: throwReadonlyPluginMetadataMutation },
    });
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) {
    freezeSnapshotValue(entry, seen);
  }
  return Object.freeze(value);
}

function freezePluginMetadataSnapshot(snapshot: PluginMetadataSnapshot): PluginMetadataSnapshot {
  return freezeSnapshotValue(snapshot);
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
    };
  }
  const indexPath = resolveInstalledPluginIndexStorePath({
    env: params.env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
  });
  const index = params.index ?? readJsonObject(indexPath);
  return {
    contextHash,
    fastHash,
    fingerprint: {
      ...fastFingerprint,
      indexHash: hashJson(stableMemoValue(index) ?? null),
    },
  };
}

function resolvePersistedRegistryMemoStateForLookup(
  params: {
    env: NodeJS.ProcessEnv;
    preferPersisted?: boolean;
    stateDir?: string;
  },
  memos: readonly PluginMetadataSnapshotMemo[],
): PersistedRegistryMemoState {
  const fastFingerprint = resolvePersistedRegistryFastMemoFingerprint(params);
  const fastHash = hashJson(fastFingerprint);
  const contextHash = resolvePersistedRegistryMemoContextHash({
    ...params,
    fastFingerprint,
  });
  for (const memo of memos) {
    const registryState = memo.registryState;
    if (
      registryState &&
      registryState.contextHash === contextHash &&
      registryState.fastHash === fastHash
    ) {
      // Plugin files are immutable for a running gateway; plugin edits require
      // an explicit reload/restart, so hot lookups only validate the registry envelope.
      return registryState;
    }
  }
  return resolvePersistedRegistryMemoState(params);
}

function resolveProvidedIndexMemoState(index: InstalledPluginIndex): PersistedRegistryMemoState {
  const fingerprint = {
    providedIndex: resolveInstalledManifestRegistryIndexFingerprint(index),
  };
  const fingerprintHash = hashJson(fingerprint);
  return {
    contextHash: fingerprintHash,
    fastHash: fingerprintHash,
    fingerprint,
  };
}

function findPluginMetadataSnapshotMemo(key: string): PluginMetadataSnapshotMemo | undefined {
  const index = pluginMetadataSnapshotMemos.findIndex((memo) => memo.key === key);
  if (index === -1) {
    return undefined;
  }
  const [memo] = pluginMetadataSnapshotMemos.splice(index, 1);
  if (!memo) {
    return undefined;
  }
  pluginMetadataSnapshotMemos.unshift(memo);
  return memo;
}

function rememberPluginMetadataSnapshotMemo(memo: PluginMetadataSnapshotMemo): void {
  pluginMetadataSnapshotMemos = [
    memo,
    ...pluginMetadataSnapshotMemos.filter((existing) => existing.key !== memo.key),
  ].slice(0, MAX_PLUGIN_METADATA_SNAPSHOT_MEMOS);
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

function cloneSnapshotInput<T>(value: T): T {
  return value && typeof value === "object" ? structuredClone(value) : value;
}

function normalizeInstalledPluginIndex(index: InstalledPluginIndex): InstalledPluginIndex {
  return {
    version: index.version ?? 1,
    hostContractVersion: index.hostContractVersion ?? "",
    compatRegistryVersion: index.compatRegistryVersion ?? "",
    migrationVersion: index.migrationVersion ?? 1,
    policyHash: index.policyHash ?? "",
    generatedAtMs: index.generatedAtMs ?? 0,
    installRecords: cloneSnapshotInput(index.installRecords ?? {}),
    plugins: (index.plugins ?? []).map(cloneSnapshotInput),
    diagnostics: (index.diagnostics ?? []).map(cloneSnapshotInput),
    ...(index.warning ? { warning: index.warning } : {}),
    ...(index.refreshReason ? { refreshReason: index.refreshReason } : {}),
  } as InstalledPluginIndex;
}

export function isPluginMetadataSnapshotCompatible(params: {
  snapshot: Pick<
    PluginMetadataSnapshot,
    "configFingerprint" | "index" | "policyHash" | "workspaceDir"
  >;
  config?: OpenClawConfig;
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
  const env = params.env ?? process.env;
  const registryState = params.index
    ? resolveProvidedIndexMemoState(params.index)
    : resolvePersistedRegistryMemoStateForLookup(
        {
          env,
          ...(params.stateDir ? { stateDir: resolveUserPath(params.stateDir, env) } : {}),
          ...(params.preferPersisted !== undefined
            ? { preferPersisted: params.preferPersisted }
            : {}),
        },
        pluginMetadataSnapshotMemos,
      );
  const memoKey = computePluginMetadataSnapshotMemoKey({ params, registryState });
  const memo = findPluginMetadataSnapshotMemo(memoKey);
  if (memo?.key === memoKey) {
    return measureDiagnosticsTimelineSpanSync("plugins.metadata.scan", () => memo.snapshot, {
      phase: activeTimelineSpan?.phase ?? "startup",
      config: params.config,
      env: params.env,
      attributes: {
        cacheHit: true,
        hasWorkspaceDir: params.workspaceDir !== undefined,
        hasInstalledIndex: params.index !== undefined,
      },
    });
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
  const snapshot = freezePluginMetadataSnapshot(result.snapshot);
  if (canMemoizePluginMetadataSnapshotResult(result)) {
    const cachedRegistryState =
      result.registrySource === "derived"
        ? resolvePersistedRegistryMemoState({
            env,
            index: snapshot.index,
            ...(params.stateDir ? { stateDir: resolveUserPath(params.stateDir, env) } : {}),
            ...(params.preferPersisted !== undefined
              ? { preferPersisted: params.preferPersisted }
              : {}),
          })
        : registryState;
    rememberPluginMetadataSnapshotMemo({
      key: computePluginMetadataSnapshotMemoKey({ params, registryState: cachedRegistryState }),
      registryState: cachedRegistryState,
      snapshot,
    });
  }
  return snapshot;
}

function canMemoizePluginMetadataSnapshotResult(result: {
  registrySource: PluginRegistrySnapshotSource;
  snapshot: PluginMetadataSnapshot;
}): boolean {
  const snapshot = result.snapshot;
  const hasCompleteSnapshotShape =
    Array.isArray(snapshot.plugins) &&
    Array.isArray(snapshot.diagnostics) &&
    Array.isArray(snapshot.registryDiagnostics) &&
    Array.isArray(snapshot.manifestRegistry.plugins) &&
    Array.isArray(snapshot.manifestRegistry.diagnostics) &&
    Array.isArray(snapshot.index.plugins) &&
    Array.isArray(snapshot.index.diagnostics);
  const hasPluginMetadata = snapshot.plugins.length > 0 || snapshot.index.plugins.length > 0;
  return hasCompleteSnapshotShape && hasPluginMetadata;
}

export function resolvePluginMetadataSnapshot(
  params: ResolvePluginMetadataSnapshotParams,
): PluginMetadataSnapshot {
  const canUseCurrentSnapshot =
    params.allowCurrent !== false &&
    params.stateDir === undefined &&
    params.preferPersisted !== false;
  if (canUseCurrentSnapshot) {
    const current = getCurrentPluginMetadataSnapshot({
      config: params.config,
      env: params.env,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.allowWorkspaceScopedCurrent === true
        ? { allowWorkspaceScopedSnapshot: true }
        : {}),
    });
    if (!current) {
      return loadPluginMetadataSnapshot(params);
    }
    if (!params.index) {
      return current;
    }
    if (
      isPluginMetadataSnapshotCompatible({
        snapshot: current,
        config: params.config,
        env: params.env,
        workspaceDir:
          params.workspaceDir ??
          (params.allowWorkspaceScopedCurrent === true ? current.workspaceDir : undefined),
        index: params.index,
      })
    ) {
      return current;
    }
  }
  return loadPluginMetadataSnapshot(params);
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
      registrySource: registryResult.source,
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
      discovery: registryResult.discovery,
    },
  };
}
