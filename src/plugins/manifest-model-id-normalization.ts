/** Applies manifest-declared model-id normalization policies to provider model refs. */
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeProviderModelIdWithPolicies,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestModelIdNormalizationProvider } from "./manifest.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  resolvePluginMetadataEnvFingerprint,
  resolvePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-workspace-state.js";

type ManifestModelIdNormalizationLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

type ManifestModelIdNormalizationPolicyCache = {
  contextFingerprint: string;
  policies: Map<string, PluginManifestModelIdNormalizationProvider>;
};

let cachedPolicies: ManifestModelIdNormalizationPolicyCache | undefined;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  cachedPolicies = undefined;
});

function resolveMetadataSnapshotForPolicies(
  params: ManifestModelIdNormalizationLookupParams = {},
): {
  plugins: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  contextFingerprint?: string;
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
        contextFingerprint: `${currentSnapshot.configFingerprint}:${resolvePluginMetadataEnvFingerprint(env)}`,
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
    contextFingerprint: `${snapshot.configFingerprint}:${resolvePluginMetadataEnvFingerprint(env)}`,
  };
}

function loadManifestModelIdNormalizationPolicies(
  params: ManifestModelIdNormalizationLookupParams = {},
): Map<string, PluginManifestModelIdNormalizationProvider> {
  if (params.plugins) {
    return collectManifestModelIdNormalizationPolicies(params.plugins);
  }
  const { plugins, contextFingerprint } = resolveMetadataSnapshotForPolicies(params);
  // The control-plane half already binds workspace/source roots, policy, and
  // installed inventory; the environment half covers compatibility context.
  if (contextFingerprint && cachedPolicies?.contextFingerprint === contextFingerprint) {
    return cachedPolicies.policies;
  }
  const policies = collectManifestModelIdNormalizationPolicies(plugins);
  if (contextFingerprint) {
    cachedPolicies = { contextFingerprint, policies };
  }
  return policies;
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
    policies: loadManifestModelIdNormalizationPolicies(params),
    context: {
      modelId: params.context.modelId,
    },
  });
}
