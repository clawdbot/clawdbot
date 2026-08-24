import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshotPluginIdScope } from "../plugins/plugin-metadata-snapshot.types.js";
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

export function resolveConfigWidePluginManifestRegistry(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  allowCurrent?: boolean;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
}): PluginManifestRegistry {
  const env = params.env ?? process.env;
  const dirs = listAgentWorkspaceDirs(params.config, env);
  return mergeRegistries(
    (dirs.length ? dirs : [undefined]).map(
      (workspaceDir) =>
        resolvePluginMetadataSnapshot({
          config: params.config,
          ...(workspaceDir ? { workspaceDir } : {}),
          ...(params.stateDir ? { stateDir: params.stateDir } : {}),
          env,
          allowCurrent: params.allowCurrent,
          allowWorkspaceScopedCurrent: true,
          ...(params.pluginIds !== undefined ? { pluginIds: params.pluginIds } : {}),
          ...(params.pluginIdScope ? { pluginIdScope: params.pluginIdScope } : {}),
        }).manifestRegistry,
    ),
  );
}
