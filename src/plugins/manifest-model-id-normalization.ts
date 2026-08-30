/** Applies manifest-declared model-id normalization policies to provider model refs. */
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeProviderModelIdWithPolicies,
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
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "./runtime-workspace-state.js";

type ManifestModelIdNormalizationLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

function resolveManifestModelIdNormalizationRecords(
  params: ManifestModelIdNormalizationLookupParams = {},
): readonly Pick<PluginManifestRecord, "modelIdNormalization">[] {
  if (params.plugins) {
    return params.plugins;
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
      return currentSnapshot.plugins;
    }
  }
  const snapshot = resolvePluginMetadataSnapshotRuntime({
    config: params.config ?? {},
    env,
    workspaceDir,
    allowWorkspaceScopedCurrent: true,
  });
  return snapshot?.plugins ?? [];
}

/** Normalizes a provider model id using plugin manifest-declared model-id policies. */
export function normalizeProviderModelIdWithManifest(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  context: {
    provider: string;
    modelId: string;
  };
}): string | undefined {
  return normalizeProviderModelIdWithPolicies({
    provider: params.provider,
    policies: collectManifestModelIdNormalizationPolicies(
      resolveManifestModelIdNormalizationRecords(params),
    ),
    context: {
      modelId: params.context.modelId,
    },
  });
}
