/** Applies manifest-declared model-id normalization policies to provider model refs. */
import {
  collectManifestModelIdNormalizationPolicies,
  type ManifestModelIdNormalizationProvider,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
// Snapshot reads go through the registration-slot bridge so this module stays
// off the control-plane/kysely graph; doctor closures cold-load it via
// parseModelRef consumers.
import {
  getCurrentPluginMetadataSnapshotRuntime,
  resolvePluginMetadataSnapshotRuntime,
} from "./plugin-metadata-snapshot.runtime.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "./runtime-workspace-state.js";

/** Caller-owned declarations or facts from an already selected metadata snapshot. */
export type ManifestModelIdNormalizationSource =
  | readonly Pick<PluginManifestRecord, "modelIdNormalization">[]
  | { owners: Pick<PluginMetadataSnapshot["owners"], "modelIdNormalizationPolicies"> };

type ManifestModelIdNormalizationLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: ManifestModelIdNormalizationSource;
};

export function resolveManifestModelIdNormalizationPolicies(
  params: ManifestModelIdNormalizationLookupParams = {},
): ReadonlyMap<string, ManifestModelIdNormalizationProvider> {
  if (params.plugins) {
    // Prepared views keep their selected generation; caller-owned arrays remain live inputs.
    return "owners" in params.plugins
      ? params.plugins.owners.modelIdNormalizationPolicies
      : collectManifestModelIdNormalizationPolicies(params.plugins);
  }
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromStateCore();
  if (params.config === undefined) {
    const currentSnapshot = getCurrentPluginMetadataSnapshotRuntime({
      env,
      workspaceDir,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    if (currentSnapshot) {
      return currentSnapshot.owners.modelIdNormalizationPolicies;
    }
  }
  const snapshot = resolvePluginMetadataSnapshotRuntime({
    config: params.config ?? {},
    env,
    workspaceDir,
    allowWorkspaceScopedCurrent: true,
  });
  return snapshot ? snapshot.owners.modelIdNormalizationPolicies : new Map();
}
