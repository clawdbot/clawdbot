import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import {
  finalizePluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
  rebasePluginMetadataSnapshotManifestRegistry,
  resolvePluginMetadataSnapshot,
  resolvePluginMetadataSnapshotCacheKey,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function mergeRegistries(registries: readonly PluginManifestRegistry[]): PluginManifestRegistry {
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
  // Registry order carries origin precedence for channel schema ownership.
  // Preserve first discovery order while deduplicating repeated workspace views.
  return { plugins, diagnostics };
}

type ResolveConfigWidePluginMetadataParams = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  allowCurrent?: boolean;
};

export function resolveConfigWidePluginMetadataSnapshot(
  params: ResolveConfigWidePluginMetadataParams,
): PluginMetadataSnapshot {
  if (params.allowCurrent === false && getPluginCache().kind !== "operation") {
    return withPluginCache(createPluginCache(), () =>
      resolveConfigWidePluginMetadataSnapshot(params),
    );
  }
  if (params.allowCurrent !== false && params.stateDir === undefined) {
    const gatewaySnapshot = getGatewayPluginMetadataSnapshot();
    if (gatewaySnapshot) {
      return gatewaySnapshot;
    }
  }
  const env = params.env ?? process.env;
  const dirs = listAgentWorkspaceDirs(params.config, env);
  const workspaceDirs: Array<string | undefined> = dirs.length ? dirs : [undefined];
  const cache = getPluginCache();
  const key = JSON.stringify([
    "config-wide",
    resolvePluginMetadataSnapshotCacheKey(params),
    workspaceDirs,
  ]);
  const cached = cache.metadata.snapshots.get(key);
  if (cached) {
    return cached;
  }
  const snapshot = resolveConfigWidePluginMetadataSnapshotImpl(params, workspaceDirs);
  cache.metadata.snapshots.set(key, snapshot);
  return snapshot;
}

function resolveConfigWidePluginMetadataSnapshotImpl(
  params: ResolveConfigWidePluginMetadataParams,
  workspaceDirs: Array<string | undefined>,
): PluginMetadataSnapshot {
  const env = params.env ?? process.env;
  const resolveSnapshot = (workspaceDir: string | undefined) =>
    resolvePluginMetadataSnapshot({
      config: params.config,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      env,
      allowCurrent: params.allowCurrent,
      allowWorkspaceScopedCurrent: true,
    });
  const firstSnapshot = resolveSnapshot(workspaceDirs[0]);
  const snapshots = [firstSnapshot, ...workspaceDirs.slice(1).map(resolveSnapshot)];
  if (snapshots.length === 1) {
    return firstSnapshot;
  }
  const manifestRegistry = mergeRegistries(snapshots.map((snapshot) => snapshot.manifestRegistry));
  const selectedPlugins = new Map(
    manifestRegistry.plugins.map((plugin) => [normalizePluginPolicyId(plugin.id), plugin]),
  );
  // Merge only the runtime inventory; registryIndex retains the original persistence scope.
  // Later scopes must not lose secondary plugins or resurrect ambiguous owners.
  const indexPlugins = new Map(
    snapshots.flatMap((snapshot) =>
      snapshot.index.plugins.flatMap((record) => {
        const id = normalizePluginPolicyId(record.pluginId);
        const selected = selectedPlugins.get(id);
        return selected && selected.manifestPath === record.manifestPath
          ? [[id, record] as const]
          : [];
      }),
    ),
  );
  const index = {
    ...firstSnapshot.index,
    plugins: [...indexPlugins.values()],
    installRecords: Object.fromEntries(
      snapshots.flatMap((snapshot) => Object.entries(snapshot.index.installRecords)),
    ),
    diagnostics: manifestRegistry.diagnostics,
  };
  const sources = new Set(manifestRegistry.plugins.map((plugin) => plugin.source));
  const discovery = snapshots.every((snapshot) => snapshot.discovery)
    ? {
        candidates: [
          ...new Map(
            snapshots.flatMap((snapshot) =>
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
        diagnostics: snapshots.flatMap((snapshot) => snapshot.discovery?.diagnostics ?? []),
      }
    : undefined;
  const sumMetric = (key: keyof PluginMetadataSnapshot["metrics"]) =>
    snapshots.reduce((total, snapshot) => total + snapshot.metrics[key], 0);
  return finalizePluginMetadataSnapshot(
    rebasePluginMetadataSnapshotManifestRegistry(
      {
        ...firstSnapshot,
        index,
        discovery,
        configFingerprint: resolvePluginControlPlaneFingerprint({
          config: params.config,
          env,
          index,
          workspaceDir: firstSnapshot.workspaceDir,
        }),
        registryDiagnostics: snapshots.flatMap((snapshot) => snapshot.registryDiagnostics),
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

export function resolveConfigWidePluginManifestRegistry(
  params: ResolveConfigWidePluginMetadataParams & { pluginIds?: readonly string[] },
): PluginManifestRegistry {
  const snapshot = resolveConfigWidePluginMetadataSnapshot(params);
  return projectPluginMetadataSnapshot(snapshot, params.pluginIds).manifestRegistry;
}
