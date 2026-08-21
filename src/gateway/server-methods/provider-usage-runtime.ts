// Prepared provider-usage discovery and credential ownership for Gateway status RPCs.
import {
  ensureAuthProfileStore,
  externalCliDiscoveryForConfigStatus,
  getRuntimeAuthProfileStoreSnapshotRevision,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
  fingerprintResolvedProviderAuth,
} from "../../agents/execution-auth-binding.js";
import {
  resolveLegacyInheritedAuthAgentId,
  resolveLegacyInheritedAuthDir,
} from "../../agents/legacy-inherited-auth-dir.js";
import { resolveEnvApiKey } from "../../agents/model-auth-env.js";
import { resolveUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import {
  listProviderUsagePluginDescriptors,
  type ProviderUsagePluginDescriptor,
} from "../../plugins/provider-runtime.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";

type ResolvedDirectApiKey = { apiKey: string; source: string };

type ProviderUsageRuntimeSnapshot = {
  agentDir: string;
  agentId: string;
  configRef: OpenClawConfig;
  credentialKey: string;
  descriptors: ProviderUsagePluginDescriptor[];
  directApiKeys: ReadonlyMap<string, ResolvedDirectApiKey>;
  providerIds: UsageProviderId[];
  store: AuthProfileStore;
};

type ProviderUsageRuntimeGeneration = ProviderUsageRuntimeSnapshot & {
  authStoreGeneration: number;
  pluginRegistryGeneration: number;
};

let current: ProviderUsageRuntimeGeneration | undefined;

function sortedRecordEntries<T>(value: Record<string, T> | undefined) {
  return Object.entries(value ?? {}).toSorted(([left], [right]) => left.localeCompare(right));
}

function fingerprintProviderUsageCredentials(params: {
  cfg: OpenClawConfig;
  directApiKeys: ReadonlyMap<string, ResolvedDirectApiKey>;
  store: AuthProfileStore;
}): string {
  const profiles = Object.entries(params.store.profiles)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([profileId, credential]) => {
      const fingerprint =
        fingerprintAuthProfileCredential({ profileId, credential }) ??
        fingerprintAuthProfileOwnerShape({ profileId, credential });
      return fingerprint ?? `${profileId}:${credential.type}:${credential.provider}`;
    });
  const direct = [...params.directApiKeys]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([provider, resolved]) => [
      provider,
      fingerprintResolvedProviderAuth({ ...resolved, mode: "api-key" }) ?? null,
    ]);
  // Profile selection can switch accounts without changing the profile set.
  // Include every non-secret selector that resolveAuthProfileOrder consults.
  return JSON.stringify({
    profiles,
    direct,
    order: sortedRecordEntries(params.store.order),
    lastGood: sortedRecordEntries(params.store.lastGood),
    usageStats: sortedRecordEntries(params.store.usageStats),
  });
}

function resolveDirectApiKeys(
  config: OpenClawConfig,
  providerIds: readonly UsageProviderId[],
): Map<string, ResolvedDirectApiKey> {
  const directApiKeys = new Map<string, ResolvedDirectApiKey>();
  for (const provider of providerIds) {
    const resolved =
      resolveUsableCustomProviderApiKey({ cfg: config, provider, env: process.env }) ??
      resolveEnvApiKey(provider, process.env, { config });
    if (!resolved) {
      continue;
    }
    directApiKeys.set(provider, resolved);
  }
  return directApiKeys;
}

export function clearProviderUsageRuntimeSnapshot(): void {
  current = undefined;
}

export function getProviderUsageRuntimeSnapshot(params: {
  config: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
  store?: AuthProfileStore;
}): ProviderUsageRuntimeSnapshot {
  const agentId = params.agentId ?? resolveLegacyInheritedAuthAgentId(params.config);
  const agentDir = params.agentDir ?? resolveLegacyInheritedAuthDir(params.config);
  // Config publication replaces the object, so identity is the exact mutation signal.
  const configRef = params.config;
  // Registry publication owns descriptor lifetime; request paths only compare its O(1) counter.
  const pluginRegistryGeneration = getActivePluginRegistryVersion();
  // Auth writers and runtime overlay publishers advance this O(1) process generation.
  const authStoreGeneration = getRuntimeAuthProfileStoreSnapshotRevision(agentDir);
  if (
    current?.configRef === configRef &&
    // Prepared owners can advance before the ambient snapshot; their exact store fences reuse.
    (params.store === undefined || current.store === params.store) &&
    current.agentDir === agentDir &&
    current.agentId === agentId &&
    current.pluginRegistryGeneration === pluginRegistryGeneration &&
    current.authStoreGeneration === authStoreGeneration
  ) {
    return current;
  }

  const store =
    params.store ??
    ensureAuthProfileStore(agentDir, {
      externalCli: externalCliDiscoveryForConfigStatus({ cfg: configRef }),
    });
  const descriptors = listProviderUsagePluginDescriptors({ config: configRef, env: process.env });
  const providerIds = descriptors.map((descriptor) => descriptor.provider);
  const directApiKeys = resolveDirectApiKeys(configRef, providerIds);
  current = {
    agentDir,
    agentId,
    configRef,
    credentialKey: fingerprintProviderUsageCredentials({ cfg: configRef, directApiKeys, store }),
    descriptors,
    directApiKeys,
    providerIds,
    store,
    // Building can publish an external-auth overlay, so bind the finished snapshot to its result.
    authStoreGeneration: getRuntimeAuthProfileStoreSnapshotRevision(agentDir),
    pluginRegistryGeneration,
  };
  return current;
}
