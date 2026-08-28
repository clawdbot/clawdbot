/** Metadata lookup helpers for plugin setup CLI backend descriptors. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
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

function resolveSetupCliBackendDescriptors(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): SetupCliBackendDescriptorEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const snapshot = resolvePluginMetadataSnapshot({
    ...(params.config ? { config: params.config } : {}),
    env,
    ...(workspaceDir ? { workspaceDir } : {}),
    allowWorkspaceScopedCurrent: true,
  });
  return snapshot.plugins.flatMap((plugin) => {
    if (!isInstalledPluginEnabled(snapshot.index, plugin.id, params.config)) {
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
}

export function resolvePluginSetupCliBackendDescriptor(
  params: SetupCliBackendDescriptorLookupParams,
) {
  const normalized = normalizeProviderId(params.backend);
  return resolveSetupCliBackendDescriptors(params).find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}

/** Resolve enabled setup CLI backend ids from one metadata snapshot. */
export function resolvePluginSetupCliBackendIds(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): string[] {
  return resolveSetupCliBackendDescriptors(params).map((entry) => entry.backend.id);
}
