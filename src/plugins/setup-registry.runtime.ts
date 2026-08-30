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
  params: Partial<SetupCliBackendDescriptorLookupParams> = {},
): SetupCliBackendDescriptorEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const snapshot = resolvePluginMetadataSnapshot({
    ...(params.config ? { config: params.config } : {}),
    env,
    ...(workspaceDir ? { workspaceDir } : {}),
    allowWorkspaceScopedCurrent: true,
  });
  const normalizedBackend =
    params.backend === undefined ? undefined : normalizeProviderId(params.backend);
  return snapshot.plugins.flatMap((plugin) => {
    const backendIds = [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].filter(
      (id) => normalizedBackend === undefined || normalizeProviderId(id) === normalizedBackend,
    );
    // Model-provider probes must not evaluate activation for unrelated plugins;
    // only manifest owners need current enablement policy.
    if (
      backendIds.length === 0 ||
      !isInstalledPluginEnabled(snapshot.index, plugin.id, params.config)
    ) {
      return [];
    }
    return backendIds.map(
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
  return resolveSetupCliBackendDescriptors(params)[0];
}

/** Resolve enabled setup CLI backend ids from one metadata snapshot. */
export function resolvePluginSetupCliBackendIds(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): string[] {
  return resolveSetupCliBackendDescriptors(params).map((entry) => entry.backend.id);
}
