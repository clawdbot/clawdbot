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

function resolveSetupCliBackendSnapshot(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  return resolvePluginMetadataSnapshot({
    ...(params.config ? { config: params.config } : {}),
    env,
    ...(workspaceDir ? { workspaceDir } : {}),
    allowWorkspaceScopedCurrent: true,
  });
}

export function resolvePluginSetupCliBackendDescriptor(
  params: SetupCliBackendDescriptorLookupParams,
): SetupCliBackendDescriptorEntry | undefined {
  const normalized = normalizeProviderId(params.backend);
  const snapshot = resolveSetupCliBackendSnapshot(params);
  // The immutable owner map preserves declaration order; only activation uses live policy.
  const pluginId = snapshot.owners.cliBackends
    .get(normalized)
    ?.find((id) => isInstalledPluginEnabled(snapshot.index, id, params.config));
  const plugin = pluginId ? snapshot.byPluginId.get(pluginId) : undefined;
  if (!plugin) {
    return undefined;
  }
  const backendId = [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].find(
    (id) => normalizeProviderId(id) === normalized,
  );
  return backendId ? { pluginId: plugin.id, backend: { id: backendId } } : undefined;
}

/** Resolve enabled setup CLI backend ids from one metadata snapshot. */
export function resolvePluginSetupCliBackendIds(
  params: Omit<SetupCliBackendDescriptorLookupParams, "backend"> = {},
): string[] {
  const snapshot = resolveSetupCliBackendSnapshot(params);
  return snapshot.plugins.flatMap((plugin) => {
    const ids = plugin.cliBackends.concat(plugin.setup?.cliBackends ?? []);
    return ids.length > 0 && isInstalledPluginEnabled(snapshot.index, plugin.id, params.config)
      ? ids
      : [];
  });
}
