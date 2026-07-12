/** Metadata lookup helpers for plugin setup CLI backend descriptors. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";

type SetupCliBackendDescriptorEntry = {
  pluginId: string;
  backend: {
    id: string;
  };
};

type SetupCliBackendDescriptorLookupParams = {
  backend: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

type SetupCliBackendDescriptorCache = {
  configFingerprint: string;
  entries: SetupCliBackendDescriptorEntry[];
};

let cachedSetupCliBackendDescriptors: SetupCliBackendDescriptorCache | undefined;

/** Test hook for resetting the descriptor cache. */
export const testing = {
  resetDescriptorCache(): void {
    cachedSetupCliBackendDescriptors = undefined;
  },
};

function resolveMetadataSnapshotForSetupCliBackends(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): {
  snapshot: PluginMetadataSnapshot;
  cacheable: boolean;
} {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const snapshot = resolvePluginMetadataSnapshot({
    config: params.config ?? {},
    env,
    ...(workspaceDir !== undefined
      ? {
          workspaceDir,
          allowWorkspaceScopedCurrent: true,
        }
      : {}),
  });
  return {
    snapshot,
    cacheable: true,
  };
}

function resolveSetupCliBackendDescriptors(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): SetupCliBackendDescriptorEntry[] {
  const { snapshot, cacheable } = resolveMetadataSnapshotForSetupCliBackends(params);
  const configFingerprint = snapshot.configFingerprint;
  if (
    cacheable &&
    configFingerprint &&
    cachedSetupCliBackendDescriptors?.configFingerprint === configFingerprint
  ) {
    return cachedSetupCliBackendDescriptors.entries;
  }
  const entries = snapshot.plugins.flatMap((plugin) => {
    if (!isInstalledPluginEnabled(snapshot.index, plugin.id)) {
      return [];
    }
    return [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].map(
      (backendId) =>
        ({
          pluginId: plugin.id,
          backend: { id: backendId },
        }) satisfies SetupCliBackendDescriptorEntry,
    );
  });
  if (cacheable && configFingerprint) {
    cachedSetupCliBackendDescriptors = { configFingerprint, entries };
  }
  return entries;
}

export function resolvePluginSetupCliBackendDescriptor(
  params: SetupCliBackendDescriptorLookupParams,
) {
  const normalized = normalizeProviderId(params.backend);
  return resolveSetupCliBackendDescriptors(params).find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}
