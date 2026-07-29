// Builds plugin registry inputs from installed plugin index records.
import { normalizePluginsConfig } from "./config-state.js";
import {
  discoverOpenClawPlugins,
  type PluginCandidate,
  type PluginDiscoveryResult,
} from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { LoadInstalledPluginIndexParams } from "./installed-plugin-index-types.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";

/** Resolves discovery candidates and manifest registry for installed plugin index loading. */
export function resolveInstalledPluginIndexRegistry(params: LoadInstalledPluginIndexParams): {
  registry: PluginManifestRegistry;
  candidates: readonly PluginCandidate[];
  discovery?: PluginDiscoveryResult;
} {
  const suppliedCandidates = params.candidates;
  const installRecords = suppliedCandidates
    ? params.installRecords
    : (params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({ env: params.env }));
  const discovery = suppliedCandidates
    ? { candidates: suppliedCandidates, diagnostics: params.diagnostics ?? [] }
    : (params.discovery ??
      discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalizePluginsConfig(params.config?.plugins).loadPaths,
        env: params.env,
        installRecords,
      }));
  return {
    candidates: discovery.candidates,
    ...(suppliedCandidates ? {} : { discovery }),
    registry: loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
      installRecords,
    }),
  };
}
