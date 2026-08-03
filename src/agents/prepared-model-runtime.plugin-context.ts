import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  resolvePluginRuntimeLoadContext,
  type PluginRuntimeLoadContext,
} from "../plugins/runtime/load-context.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const preparedPluginRuntimeLoadContext = Symbol("preparedPluginRuntimeLoadContext");
const emptyPluginDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

type PreparedPluginRegistry = PluginRegistry & {
  [preparedPluginRuntimeLoadContext]?: PluginRuntimeLoadContext;
};

function setPreparedPluginRuntimeLoadContext(
  registry: PluginRegistry,
  context: PluginRuntimeLoadContext,
): void {
  (registry as PreparedPluginRegistry)[preparedPluginRuntimeLoadContext] = context;
}

export function preparePluginLoadContext(
  input: PreparedModelRuntimeInput,
  env: NodeJS.ProcessEnv,
  registry: PluginRegistry | undefined,
  metadataSnapshot: PluginMetadataSnapshot,
): PluginRuntimeLoadContext & { metadataSnapshot: PluginMetadataSnapshot } {
  const { config, workspaceDir } = input;
  // The prepared owner already resolved metadata for this exact config/env/workspace tuple.
  // Missing discovery facts stay empty here instead of reopening cold channel discovery.
  const preparedMetadataSnapshot = metadataSnapshot.discovery
    ? metadataSnapshot
    : { ...metadataSnapshot, discovery: emptyPluginDiscovery };
  const context = {
    ...resolvePluginRuntimeLoadContext({
      config,
      env,
      workspaceDir,
      metadataSnapshot: preparedMetadataSnapshot,
      manifestRegistry: metadataSnapshot.manifestRegistry,
    }),
    metadataSnapshot,
    installRecords: extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index),
  };
  if (registry) {
    // The prepared registry is the lifecycle-owned carrier; standalone callers keep the cold path.
    setPreparedPluginRuntimeLoadContext(registry, context);
  }
  return context;
}

/** Reads plugin facts carried by a lifecycle-owned prepared runtime snapshot. */
export const getPreparedPluginRuntimeLoadContext = (
  registry: PluginRegistry | undefined,
): PluginRuntimeLoadContext | undefined =>
  (registry as PreparedPluginRegistry | undefined)?.[preparedPluginRuntimeLoadContext];
