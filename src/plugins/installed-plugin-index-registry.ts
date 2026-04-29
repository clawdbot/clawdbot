import { normalizePluginsConfig } from "./config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import type { LoadInstalledPluginIndexParams } from "./installed-plugin-index-types.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";

export function resolveInstalledPluginIndexRegistry(params: LoadInstalledPluginIndexParams): {
  registry: PluginManifestRegistry;
  candidates: readonly PluginCandidate[];
} {
  if (params.candidates) {
    return {
      candidates: params.candidates,
      registry: loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        installRecords: params.installRecords,
      }),
    };
  }

  const normalized = normalizePluginsConfig(params.config?.plugins);
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    extraPaths: normalized.loadPaths,
    env: params.env,
  });
  return {
    candidates: discovery.candidates,
    registry: loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
      installRecords: params.installRecords,
    }),
  };
}
