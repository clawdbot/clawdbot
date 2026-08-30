import {
  listAgentEntries,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDirsById } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBundledDiscoveryMode } from "./bundled-discovery-state.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import {
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import {
  getInstalledPluginIndexInitializationGeneration,
  getInstalledPluginIndexInstallRecordsCacheGeneration,
} from "./installed-plugin-index-record-cache.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";
import {
  adoptProcessPluginCache,
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  getProcessPluginCache,
  getScopedPluginMetadataCollection,
  withPluginCache,
  type PluginCache,
} from "./plugin-cache.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { preparePluginChannelCatalogs } from "./plugin-metadata-catalog.js";
import type {
  ConfigWidePluginMetadataView,
  PluginMetadataOwner,
  PluginMetadataScope,
  PreparePluginMetadataParams,
  PreparedPluginMetadata,
} from "./plugin-metadata-collection.types.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-env.js";
import {
  buildPluginMetadataOwnerMaps,
  completePluginMetadataSnapshot,
  freezePluginMetadataValue,
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
  rebasePluginMetadataSnapshotManifestRegistry,
  restorePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

export { getCurrentPluginMetadataOwner } from "./current-plugin-metadata-state.js";
export type {
  ConfigWidePluginMetadataView,
  PluginMetadataOwner,
  PreparedPluginMetadata,
} from "./plugin-metadata-collection.types.js";

export function getScopedPluginMetadata(
  env: NodeJS.ProcessEnv = process.env,
): PreparedPluginMetadata | undefined {
  const metadata = getScopedPluginMetadataCollection();
  return metadata?.envFingerprint === resolvePluginMetadataEnvFingerprint(env)
    ? metadata
    : undefined;
}

/** Keeps control-plane callbacks on their prepared union and exact workspace graph. */
export function withPluginMetadataCollectionScope<T>(
  metadata: PreparedPluginMetadata,
  run: () => T,
  params: {
    config: OpenClawConfig;
    compatibleConfigs?: readonly OpenClawConfig[];
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
  },
): T {
  const snapshot = getPluginMetadataWorkspaceSnapshot(metadata, params);
  return withPluginCache(
    getPluginMetadataSnapshotCache(metadata),
    () =>
      withPluginMetadataSnapshotScope(snapshot, run, {
        ...params,
        preparedConfigFingerprint: snapshot.configFingerprint,
      }),
    metadata,
  );
}

function mergeManifestRegistries(
  registries: readonly PluginManifestRegistry[],
): PluginManifestRegistry {
  const grouped = new Map<
    string,
    { plugin: PluginManifestRegistry["plugins"][number]; sources: Set<string> }
  >();
  const diagnostics = registries.flatMap((registry) => registry.diagnostics);
  for (const registry of registries) {
    for (const plugin of registry.plugins) {
      const id = normalizePluginPolicyId(plugin.id);
      const group = grouped.get(id) ?? { plugin, sources: new Set<string>() };
      group.plugin = plugin;
      group.sources.add(plugin.source);
      grouped.set(id, group);
    }
  }
  // Discovery order owns schema precedence; distinct sources cannot silently
  // turn one workspace's plugin into another workspace's execution owner.
  const plugins = [...grouped.entries()].flatMap(([pluginId, group]) => {
    if (group.sources.size === 1) {
      return [group.plugin];
    }
    diagnostics.push({
      level: "error",
      pluginId,
      message: `plugin id ${JSON.stringify(pluginId)} is present in multiple agent workspaces: ${[...group.sources].toSorted().join(", ")}`,
    });
    return [];
  });
  return { plugins, diagnostics };
}

function createManifestView(
  registries: readonly PluginManifestRegistry[],
): ConfigWidePluginMetadataView {
  const manifestRegistry = mergeManifestRegistries(registries);
  return freezePluginMetadataValue({
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    diagnostics: manifestRegistry.diagnostics,
    byPluginId: new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    owners: buildPluginMetadataOwnerMaps(manifestRegistry.plugins),
  });
}

function resolveProjectionIds(snapshot: PluginMetadataSnapshot, scope: PluginMetadataScope) {
  return scope.pluginIds ?? scope.pluginIdScope?.resolve({ index: snapshot.index });
}

/** Selects a prepared execution workspace; undefined is an explicit shared-root view. */
export function getPluginMetadataWorkspaceSnapshot(
  metadata: PreparedPluginMetadata,
  params: PluginMetadataScope & { workspaceDir?: string } = {},
): PluginMetadataSnapshot {
  const workspaceDir = Object.hasOwn(params, "workspaceDir")
    ? params.workspaceDir
    : metadata.selectedSnapshot.workspaceDir;
  const snapshot = metadata.workspaces.get(workspaceDir);
  if (!snapshot) {
    throw new Error("Plugin metadata workspace was not prepared by the current operation");
  }
  return projectPluginMetadataSnapshot(snapshot, resolveProjectionIds(snapshot, params));
}

// The union and its index agree on ambiguous source rejection. Auxiliary execution
// workspaces remain separately retained and cannot alter config schema ownership.
function buildUnionSnapshot(params: {
  snapshots: readonly PluginMetadataSnapshot[];
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): PluginMetadataSnapshot {
  const [first, ...rest] = params.snapshots;
  if (!first) {
    throw new Error("Plugin metadata requires a shared-root inventory");
  }
  if (rest.length === 0) {
    return first;
  }
  const manifestRegistry = mergeManifestRegistries(
    params.snapshots.map((snapshot) => snapshot.manifestRegistry),
  );
  const selected = new Map(
    manifestRegistry.plugins.map((plugin) => [normalizePluginPolicyId(plugin.id), plugin]),
  );
  const indexPlugins = new Map(
    params.snapshots.flatMap((snapshot) =>
      snapshot.index.plugins.flatMap((record) => {
        const id = normalizePluginPolicyId(record.pluginId);
        return selected.get(id)?.manifestPath === record.manifestPath
          ? [[id, record] as const]
          : [];
      }),
    ),
  );
  const index = {
    ...first.index,
    plugins: [...indexPlugins.values()],
    installRecords: Object.fromEntries(
      params.snapshots.flatMap((snapshot) => Object.entries(snapshot.index.installRecords)),
    ),
    diagnostics: manifestRegistry.diagnostics,
  };
  const sources = new Set(manifestRegistry.plugins.map((plugin) => plugin.source));
  const discovery = params.snapshots.every((snapshot) => snapshot.discovery)
    ? {
        candidates: [
          ...new Map(
            params.snapshots.flatMap((snapshot) =>
              (snapshot.discovery?.candidates ?? [])
                .filter((candidate) => sources.has(candidate.source))
                .map(
                  (candidate) =>
                    [
                      `${candidate.effectivePluginId ?? candidate.idHint}\0${candidate.source}`,
                      candidate,
                    ] as const,
                ),
            ),
          ).values(),
        ],
        diagnostics: params.snapshots.flatMap((snapshot) => snapshot.discovery?.diagnostics ?? []),
      }
    : undefined;
  const sumMetric = (key: keyof PluginMetadataSnapshot["metrics"]) =>
    params.snapshots.reduce((total, snapshot) => total + snapshot.metrics[key], 0);
  return restorePluginMetadataSnapshot(
    rebasePluginMetadataSnapshotManifestRegistry(
      {
        ...first,
        index,
        discovery,
        configFingerprint: resolvePluginControlPlaneFingerprint({
          config: params.config,
          env: params.env,
          index,
          workspaceDir: first.workspaceDir,
        }),
        registryDiagnostics: params.snapshots.flatMap((snapshot) => snapshot.registryDiagnostics),
        metrics: {
          registrySnapshotMs: sumMetric("registrySnapshotMs"),
          manifestRegistryMs: sumMetric("manifestRegistryMs"),
          ownerMapsMs: sumMetric("ownerMapsMs"),
          totalMs: sumMetric("totalMs"),
          indexPluginCount: index.plugins.length,
          manifestPluginCount: manifestRegistry.plugins.length,
        },
      },
      manifestRegistry,
    ),
  );
}

function resolvePreparationKey(params: PreparePluginMetadataParams): string {
  return hashJson({
    stateDir: params.stateDir,
    env: resolvePluginMetadataEnvFingerprint(params.env),
    policy: resolveInstalledPluginIndexPolicyHash(params.config),
    loadPaths: params.config.plugins?.load?.paths,
    agents: listAgentEntries(params.config).map(({ id, workspace }) => ({ id, workspace })),
    defaultWorkspace: params.config.agents?.defaults?.workspace,
    owner: tryResolveAmbientOwnerAgentId(params.config),
    inheritedWorkspaceOwner: tryResolveLegacyCompatibilityAgentId(params.config),
    workspaceDir: params.workspaceDir,
    additionalWorkspaceDirs: params.additionalWorkspaceDirs,
  });
}

function resolvePreparationInputs(params: PreparePluginMetadataParams) {
  const env = params.env ?? process.env;
  const agentWorkspaceDirs = resolveAgentWorkspaceDirsById(params.config, env);
  const selectedWorkspace = resolvePluginControlPlaneWorkspace({
    config: params.config,
    env,
    workspaceDir: params.workspaceDir,
  }).workspaceDir;
  const configured = [...new Set(agentWorkspaceDirs.values())];
  const configWorkspaceDirs: Array<string | undefined> = configured.length
    ? configured
    : [undefined];
  if (params.workspaceDir === undefined && !configWorkspaceDirs.includes(selectedWorkspace)) {
    configWorkspaceDirs.push(selectedWorkspace);
  }
  // Retain shared roots and explicit execution workspaces without making an
  // auxiliary workspace part of configured validation or collision ownership.
  const workspaceDirs = [
    ...new Set([
      undefined,
      ...configWorkspaceDirs,
      selectedWorkspace,
      ...(params.additionalWorkspaceDirs ?? []),
    ]),
  ];
  return { env, agentWorkspaceDirs, selectedWorkspace, configWorkspaceDirs, workspaceDirs };
}

type RetainedMetadata = {
  key: string;
  metadata: PreparedPluginMetadata;
  configIdentities: WeakSet<OpenClawConfig>;
};

/** One PluginCache owns a boot inventory and its replaceable activation/config views. */
export function createPluginMetadataOwner(
  initialCache: PluginCache = createPluginCache(),
): PluginMetadataOwner {
  let cache = initialCache;
  let active: RetainedMetadata | undefined;
  let observed: RetainedMetadata | undefined;
  let boot: PreparedPluginMetadata | undefined;
  let epoch = 0;
  let cacheSourceGeneration = getInstalledPluginIndexInstallRecordsCacheGeneration();
  let refreshRequired = false;
  let disposed = false;
  const preparedEpochs = new WeakMap<PreparedPluginMetadata, number>();
  // Completed operations keep their first inventory across ledger writes. A database
  // open still fences earlier read-only preparation, including foreign seeded views.
  const resolveReadSourceGeneration = () =>
    cache.kind === "operation" &&
    observed &&
    observed.metadata.installRecordsGeneration >= getInstalledPluginIndexInitializationGeneration()
      ? observed.metadata.installRecordsGeneration
      : getInstalledPluginIndexInstallRecordsCacheGeneration();
  const isPreparedAtSource = (metadata: PreparedPluginMetadata, sourceGeneration: number) =>
    !disposed &&
    preparedEpochs.get(metadata) === epoch &&
    (boot
      ? metadata.unionSnapshot === boot.unionSnapshot &&
        getPluginMetadataSnapshotCache(metadata) === cache
      : metadata.installRecordsGeneration === sourceGeneration);
  const isPreparedCurrent = (metadata: PreparedPluginMetadata) =>
    isPreparedAtSource(metadata, getInstalledPluginIndexInstallRecordsCacheGeneration());
  const isPreparedReadable = (metadata: PreparedPluginMetadata) =>
    isPreparedAtSource(metadata, resolveReadSourceGeneration());

  const replaceCache = (next: PluginCache) => {
    const ownsProcess = getProcessPluginCache().metadata.collectionOwner === owner;
    if (cache.metadata.collectionOwner === owner) {
      cache.metadata.collectionOwner = undefined;
    }
    cache = next;
    cache.metadata.collectionOwner ??= owner;
    cacheSourceGeneration = getInstalledPluginIndexInstallRecordsCacheGeneration();
    refreshRequired = false;
    if (ownsProcess) {
      adoptProcessPluginCache(cache);
    }
  };

  const projectBootWorkspace = (workspaceDir: string | undefined) => {
    const snapshot = boot!.workspaces.get(workspaceDir);
    if (snapshot) {
      return snapshot;
    }
    // A newly selected workspace has no discovered plugins until restart. Only the
    // startup shared roots are available; another agent's workspace never substitutes.
    const shared = boot!.workspaces.get(undefined)!;
    const projected = freezePluginMetadataValue({ ...shared, workspaceDir });
    bindPluginMetadataSnapshotCache(projected, cache);
    return projected;
  };

  const prepareBootView = (params: PreparePluginMetadataParams): PreparedPluginMetadata => {
    const bootMetadata = boot!;
    const inputs = resolvePreparationInputs(params);
    const workspaces = new Map(bootMetadata.workspaces);
    for (const workspaceDir of inputs.workspaceDirs) {
      workspaces.set(workspaceDir, projectBootWorkspace(workspaceDir));
    }
    const channelCatalog = Object.freeze({
      read(readParams: Parameters<PreparedPluginMetadata["channelCatalog"]["read"]>[0]) {
        return bootMetadata.channelCatalog.read({
          ...readParams,
          workspaceDir: bootMetadata.workspaces.has(readParams.workspaceDir)
            ? readParams.workspaceDir
            : undefined,
        });
      },
    });
    return freezePluginMetadataValue({
      ...bootMetadata,
      workspaces,
      channelCatalog,
      agentWorkspaceDirs: inputs.agentWorkspaceDirs,
      configWorkspaceDirs: inputs.configWorkspaceDirs,
      selectedSnapshot: workspaces.get(inputs.selectedWorkspace)!,
    });
  };

  const owner: PluginMetadataOwner = {
    prepare(params) {
      if (disposed) {
        throw new Error("Plugin metadata owner has been disposed");
      }
      const fresh = params.allowCurrent === false || params.stateDir !== undefined;
      if (boot && fresh) {
        return createPluginMetadataOwner().prepare(params);
      }
      const suppliedCache = params.seed ? getPluginMetadataSnapshotCache(params.seed) : undefined;
      if (
        !boot &&
        params.allowCurrent !== false &&
        params.stateDir === undefined &&
        params.seed &&
        suppliedCache?.metadata.current.owner === "gateway" &&
        params.seed.envFingerprint === resolvePluginMetadataEnvFingerprint(params.env) &&
        getProcessPluginCache().metadata.collectionOwner !== owner
      ) {
        // Scoped config callbacks borrow exact boot facts without acquiring publication
        // or disposal of their producer. Explicit fresh management never enters this path.
        replaceCache(suppliedCache);
        boot = params.seed;
      }
      const key = resolvePreparationKey(params);
      const previous = fresh
        ? undefined
        : [active, observed].find(
            (entry) => entry?.key === key && isPreparedReadable(entry.metadata),
          );
      if (previous) {
        return previous.metadata;
      }
      const preparationEpoch = epoch;
      const sourceGeneration = getInstalledPluginIndexInstallRecordsCacheGeneration();
      const installRecordsGeneration = fresh ? sourceGeneration : resolveReadSourceGeneration();
      let metadata: PreparedPluginMetadata;
      if (boot) {
        metadata = prepareBootView(params);
      } else {
        const seedCache = params.seed ? getPluginMetadataSnapshotCache(params.seed) : undefined;
        const seed =
          params.allowCurrent !== false &&
          params.stateDir === undefined &&
          params.seed?.installRecordsGeneration === installRecordsGeneration &&
          params.seed.envFingerprint === resolvePluginMetadataEnvFingerprint(params.env) &&
          seedCache?.metadata.current.owner !== "gateway" &&
          (getProcessPluginCache().metadata.collectionOwner !== owner ||
            !seedCache?.metadata.collectionOwner ||
            seedCache.metadata.collectionOwner === owner)
            ? params.seed
            : undefined;
        if (
          refreshRequired ||
          cacheSourceGeneration !== installRecordsGeneration ||
          (fresh && observed)
        ) {
          replaceCache(createPluginCache());
        } else if (seed && !observed && !active) {
          replaceCache(getPluginMetadataSnapshotCache(seed));
        }
        // Workspace preparation shares one cache, but its temporary operation mode
        // must not disable fresh reads after this synchronous call returns or throws.
        const previousKind = cache.kind;
        cache.kind = "operation";
        try {
          metadata = withPluginCache(cache, () => {
            const inputs = resolvePreparationInputs(params);
            const workspaces = new Map<string | undefined, PluginMetadataSnapshot>();
            for (const workspaceDir of inputs.workspaceDirs) {
              const candidate = fresh
                ? undefined
                : [
                    seed?.workspaces.get(workspaceDir),
                    observed?.metadata.installRecordsGeneration === installRecordsGeneration
                      ? observed.metadata.workspaces.get(workspaceDir)
                      : undefined,
                  ].find(
                    (snapshot) =>
                      snapshot &&
                      isPluginMetadataSnapshotCompatible({
                        snapshot,
                        config: params.config,
                        env: inputs.env,
                        workspaceDir,
                        allowScopedSnapshot: true,
                      }),
                  );
              const snapshot =
                candidate ??
                loadPluginMetadataSnapshot({
                  config: params.config,
                  env: inputs.env,
                  workspaceDir,
                  stateDir: params.stateDir,
                  allowCurrent: false,
                });
              workspaces.set(
                workspaceDir,
                completePluginMetadataSnapshot({
                  snapshot,
                  config: params.config,
                  env: inputs.env,
                  workspaceDir,
                })!,
              );
            }
            const { catalog, discoveries } = preparePluginChannelCatalogs({
              config: params.config,
              env: inputs.env,
              stateDir: params.stateDir,
              workspaces,
            });
            for (const [workspaceDir, snapshot] of workspaces) {
              if (!snapshot.discovery) {
                const withDiscovery = freezePluginMetadataValue({
                  ...snapshot,
                  discovery: discoveries.get(workspaceDir)!,
                });
                bindPluginMetadataSnapshotCache(withDiscovery, cache);
                workspaces.set(workspaceDir, withDiscovery);
              }
            }
            const unionSnapshot = buildUnionSnapshot({
              snapshots: inputs.configWorkspaceDirs.map((workspaceDir) =>
                workspaces.get(workspaceDir)!,
              ),
              config: params.config,
              env: inputs.env,
            });
            return freezePluginMetadataValue({
              ...createManifestView([unionSnapshot.manifestRegistry]),
              unionSnapshot,
              workspaces,
              agentWorkspaceDirs: inputs.agentWorkspaceDirs,
              configWorkspaceDirs: inputs.configWorkspaceDirs,
              envFingerprint: resolvePluginMetadataEnvFingerprint(inputs.env),
              installRecordsGeneration,
              bundledDiscoveryMode: readBundledDiscoveryMode({
                env: inputs.env,
                path: resolveInstalledPluginIndexStorePath({
                  env: inputs.env,
                  stateDir: params.stateDir,
                }),
              }),
              selectedSnapshot: workspaces.get(inputs.selectedWorkspace)!,
              channelCatalog: catalog,
            });
          });
        } finally {
          cache.kind = previousKind;
        }
      }
      if (
        disposed ||
        preparationEpoch !== epoch ||
        (!boot && sourceGeneration !== getInstalledPluginIndexInstallRecordsCacheGeneration())
      ) {
        throw new Error("Plugin metadata preparation was superseded");
      }
      bindPluginMetadataSnapshotCache(metadata, cache);
      preparedEpochs.set(metadata, epoch);
      observed = { key, metadata, configIdentities: new WeakSet() };
      return metadata;
    },
    publish(metadata, params) {
      if (!isPreparedCurrent(metadata) || cache.metadata.collectionOwner !== owner) {
        throw new Error("Plugin metadata preparation was superseded before publication");
      }
      const sourceConfig = params.sourceConfig ?? params.config;
      if (!boot) {
        setGatewayPluginMetadataSnapshot(metadata.unionSnapshot, {
          config: sourceConfig,
          compatibleConfigs: [params.config],
          env: params.env,
        });
        boot = metadata;
      }
      active = {
        key: resolvePreparationKey({ config: sourceConfig, env: params.env }),
        metadata,
        configIdentities: new WeakSet([sourceConfig, params.config]),
      };
      if (observed?.metadata === metadata) {
        observed = undefined;
      }
    },
    getActive: () => active?.metadata,
    isPreparedCurrent,
    readSnapshot(params) {
      if (
        params.allowCurrent === false ||
        params.preferPersisted === false ||
        params.stateDir !== undefined
      ) {
        return undefined;
      }
      if (boot && active) {
        const workspaceDir = Object.hasOwn(params, "workspaceDir")
          ? params.workspaceDir
          : params.config && active.configIdentities.has(params.config)
            ? active.metadata.selectedSnapshot.workspaceDir
            : params.config
              ? resolvePluginControlPlaneWorkspace({ config: params.config, env: params.env })
                  .workspaceDir
              : params.allowWorkspaceScopedCurrent
                ? active.metadata.selectedSnapshot.workspaceDir
                : undefined;
        const snapshot =
          active.metadata.workspaces.get(workspaceDir) ?? projectBootWorkspace(workspaceDir);
        return projectPluginMetadataSnapshot(snapshot, resolveProjectionIds(snapshot, params));
      }
      for (const entry of [active, observed]) {
        if (
          !entry ||
          !isPreparedReadable(entry.metadata) ||
          entry.metadata.envFingerprint !== resolvePluginMetadataEnvFingerprint(params.env)
        ) {
          continue;
        }
        const workspaceDir =
          params.workspaceDir ??
          (params.allowWorkspaceScopedCurrent
            ? entry.metadata.selectedSnapshot.workspaceDir
            : undefined);
        const snapshot = entry.metadata.workspaces.get(workspaceDir);
        if (!snapshot || (params.index && params.index !== snapshot.index)) {
          continue;
        }
        if (
          !(params.config && entry.configIdentities.has(params.config)) &&
          !isPluginMetadataSnapshotCompatible({
            snapshot,
            config: params.config,
            env: params.env,
            workspaceDir,
          })
        ) {
          continue;
        }
        return projectPluginMetadataSnapshot(snapshot, resolveProjectionIds(snapshot, params));
      }
      return undefined;
    },
    readConfigWide(params) {
      if (
        params.allowCurrent === false ||
        params.stateDir !== undefined ||
        (boot && boot.envFingerprint !== resolvePluginMetadataEnvFingerprint(params.env))
      ) {
        return undefined;
      }
      // Before publication this prepares through the owner; afterward it only
      // projects the fixed inventory into the requested config/workspace mapping.
      return owner.prepare(params);
    },
    invalidatePreparation() {
      epoch += 1;
      observed = undefined;
      refreshRequired = !boot;
    },
    dispose() {
      if (cache.metadata.collectionOwner === owner) {
        cache.metadata.collectionOwner = undefined;
      }
      active = undefined;
      observed = undefined;
      boot = undefined;
      disposed = true;
      epoch += 1;
    },
  };
  cache.metadata.collectionOwner ??= owner;
  return owner;
}

/** Kernels share the process owner; explicit management scopes keep their operation owner. */
export function getOrCreatePluginMetadataOwner(): PluginMetadataOwner {
  const cache = getPluginCache();
  return cache.metadata.collectionOwner ?? createPluginMetadataOwner(cache);
}

/** Explicit management scopes acquire their own owner without replacing the running inventory. */
export function preparePluginMetadata(params: PreparePluginMetadataParams): PreparedPluginMetadata {
  const cache = getPluginCache();
  const owner =
    params.allowCurrent === false && cache.kind !== "operation"
      ? createPluginMetadataOwner()
      : (cache.metadata.collectionOwner ?? createPluginMetadataOwner(cache));
  return owner.prepare(params);
}
