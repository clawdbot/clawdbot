import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import {
  hasNonEmptyManifestEnvCandidate,
  manifestConfigSignalPasses,
  manifestPluginSetupProviderEnvVars,
  manifestProviderBaseUrlGuardPasses,
} from "../../plugins/manifest-tool-availability.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../../plugins/runtime-state.js";
import { listProfilesForProvider } from "../auth-profiles/profile-list.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

export type CapabilityContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "mediaUnderstandingProviders";

type CapabilityProviderMetadataKey =
  | "imageGenerationProviderMetadata"
  | "videoGenerationProviderMetadata"
  | "musicGenerationProviderMetadata";

type CapabilityMetadataSnapshot = Pick<PluginMetadataSnapshot, "index" | "plugins">;

function metadataKeyForCapabilityContract(
  key: CapabilityContractKey,
): CapabilityProviderMetadataKey | undefined {
  switch (key) {
    case "imageGenerationProviders":
      return "imageGenerationProviderMetadata";
    case "videoGenerationProviders":
      return "videoGenerationProviderMetadata";
    case "musicGenerationProviders":
      return "musicGenerationProviderMetadata";
    case "mediaUnderstandingProviders":
      return undefined;
  }
  return undefined;
}

function listCapabilityAuthSignals(params: {
  plugin: PluginManifestRecord;
  key: CapabilityContractKey;
  providerId: string;
}): Array<{
  provider: string;
  providerBaseUrl?: NonNullable<
    NonNullable<PluginManifestRecord["imageGenerationProviderMetadata"]>[string]["authSignals"]
  >[number]["providerBaseUrl"];
}> {
  const metadataKey = metadataKeyForCapabilityContract(params.key);
  const metadata = metadataKey ? params.plugin[metadataKey]?.[params.providerId] : undefined;
  if (metadata?.authSignals?.length) {
    return metadata.authSignals;
  }
  return [params.providerId, ...(metadata?.aliases ?? []), ...(metadata?.authProviders ?? [])].map(
    (provider) => ({ provider }),
  );
}

function isPluginAvailableForCapability(params: {
  snapshot: CapabilityMetadataSnapshot;
  plugin: PluginManifestRecord;
  config?: OpenClawConfig;
}): boolean {
  return isManifestPluginAvailableForControlPlane({
    snapshot: params.snapshot,
    plugin: params.plugin,
    config: params.config,
  });
}

function hasAvailableCapabilityPlugin(
  params: {
    snapshot: CapabilityMetadataSnapshot;
    config?: OpenClawConfig;
  },
  accepts: (plugin: PluginManifestRecord) => boolean,
): boolean {
  if (params.config?.plugins?.enabled === false) {
    return false;
  }
  for (const plugin of params.snapshot.plugins) {
    if (
      !isPluginAvailableForCapability({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    if (accepts(plugin)) {
      return true;
    }
  }
  return false;
}

function hasConfiguredCapabilityProviderSignal(params: {
  plugin: PluginManifestRecord;
  key: CapabilityContractKey;
  providerId: string;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  const metadataKey = metadataKeyForCapabilityContract(params.key);
  const metadata = metadataKey ? params.plugin[metadataKey]?.[params.providerId] : undefined;
  if (
    metadata?.configSignals?.some((signal) =>
      manifestConfigSignalPasses({
        config: params.config,
        env: process.env,
        signal,
      }),
    )
  ) {
    return true;
  }
  for (const signal of listCapabilityAuthSignals({
    plugin: params.plugin,
    key: params.key,
    providerId: params.providerId,
  })) {
    if (
      !manifestProviderBaseUrlGuardPasses({
        config: params.config,
        guard: signal.providerBaseUrl,
      })
    ) {
      continue;
    }
    if (params.authStore && listProfilesForProvider(params.authStore, signal.provider).length > 0) {
      return true;
    }
    if (
      hasNonEmptyManifestEnvCandidate(
        process.env,
        manifestPluginSetupProviderEnvVars(params.plugin, signal.provider),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function getCurrentCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): PluginMetadataSnapshot | undefined {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  return getCurrentPluginMetadataSnapshot({
    config: params.config,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

export function loadCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Pick<PluginMetadataSnapshot, "index" | "plugins"> {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  return resolvePluginMetadataSnapshot({
    config: params.config ?? {},
    env: params.env ?? process.env,
    ...(workspaceDir ? { workspaceDir } : {}),
  });
}

export function hasSnapshotCapabilityAvailability(params: {
  snapshot: CapabilityMetadataSnapshot;
  key: CapabilityContractKey;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  return hasAvailableCapabilityPlugin(params, (plugin) =>
    (plugin.contracts?.[params.key] ?? []).some((providerId) =>
      hasConfiguredCapabilityProviderSignal({
        plugin,
        key: params.key,
        providerId,
        config: params.config,
        authStore: params.authStore,
      }),
    ),
  );
}

export function hasSnapshotProviderEnvAvailability(params: {
  snapshot: CapabilityMetadataSnapshot;
  providerId: string;
  config?: OpenClawConfig;
}): boolean {
  return hasAvailableCapabilityPlugin(params, (plugin) =>
    hasNonEmptyManifestEnvCandidate(
      process.env,
      manifestPluginSetupProviderEnvVars(plugin, params.providerId),
    ),
  );
}

export function hasSnapshotCapabilityProviderAvailability(params: {
  snapshot: CapabilityMetadataSnapshot;
  key: CapabilityContractKey;
  providerId: string;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  return hasAvailableCapabilityPlugin(params, (plugin) => {
    if (!plugin.contracts?.[params.key]?.includes(params.providerId)) {
      return false;
    }
    return hasConfiguredCapabilityProviderSignal({
      plugin,
      key: params.key,
      providerId: params.providerId,
      config: params.config,
      authStore: params.authStore,
    });
  });
}
