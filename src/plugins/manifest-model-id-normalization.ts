import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeProviderModelIdWithPolicies,
} from "../shared/provider-model-id-normalization.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestModelIdNormalizationProvider } from "./manifest.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-workspace-state.js";

type ManifestModelIdNormalizationLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

type ManifestModelIdNormalizationPolicyCache = {
  configFingerprint: string;
  policies: Map<string, PluginManifestModelIdNormalizationProvider>;
};

let cachedPolicies: ManifestModelIdNormalizationPolicyCache | undefined;

function resolveMetadataSnapshotForPolicies(
  params: ManifestModelIdNormalizationLookupParams = {},
): {
  plugins: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  configFingerprint?: string;
  cacheable: boolean;
} {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  if (params.config === undefined) {
    const currentSnapshot = getCurrentPluginMetadataSnapshot({
      env,
      workspaceDir,
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    if (currentSnapshot) {
      return {
        plugins: currentSnapshot.plugins,
        configFingerprint: currentSnapshot.configFingerprint,
        cacheable: true,
      };
    }
  }
  const snapshot = resolvePluginMetadataSnapshot({
    config: params.config ?? {},
    env,
    workspaceDir,
    allowWorkspaceScopedCurrent: true,
  });
  return {
    plugins: snapshot.plugins,
    configFingerprint: snapshot.configFingerprint,
    cacheable: false,
  };
}

function loadManifestModelIdNormalizationPolicies(
  params: ManifestModelIdNormalizationLookupParams = {},
): Map<string, PluginManifestModelIdNormalizationProvider> {
  if (params.plugins) {
    return collectManifestModelIdNormalizationPolicies(params.plugins);
  }
  const { plugins, configFingerprint, cacheable } = resolveMetadataSnapshotForPolicies(params);
  if (cacheable && configFingerprint && cachedPolicies?.configFingerprint === configFingerprint) {
    return cachedPolicies.policies;
  }
  const policies = collectManifestModelIdNormalizationPolicies(plugins);
  if (cacheable && configFingerprint) {
    cachedPolicies = { configFingerprint, policies };
  }
  return policies;
}

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
    policies: loadManifestModelIdNormalizationPolicies(params),
    context: {
      modelId: params.context.modelId,
    },
  });
}
