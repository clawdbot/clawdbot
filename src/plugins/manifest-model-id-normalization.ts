/** Applies manifest-declared model-id normalization policies to provider model refs. */
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeProviderModelIdWithPolicies,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestModelIdNormalizationProvider } from "./manifest.js";
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
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromStateCore();
  if (params.config === undefined) {
    const currentSnapshot = getCurrentPluginMetadataSnapshotRuntime({
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
  const snapshot = resolvePluginMetadataSnapshotRuntime({
    config: params.config ?? {},
    env,
    workspaceDir,
    allowWorkspaceScopedCurrent: true,
  });
  if (!snapshot) {
    return { plugins: [], cacheable: false };
  }
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
