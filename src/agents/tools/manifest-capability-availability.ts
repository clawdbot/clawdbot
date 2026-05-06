import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
} from "../../plugins/manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import {
  hasNonEmptyManifestEnvCandidate,
  manifestConfigSignalPasses,
  manifestPluginSetupProviderEnvVars,
  manifestProviderBaseUrlGuardPasses,
} from "../../plugins/manifest-tool-availability.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
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

export function getCurrentCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): PluginMetadataSnapshot | undefined {
  return getCurrentPluginMetadataSnapshot({
    config: params.config,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

export function loadCapabilityMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Pick<PluginMetadataSnapshot, "index" | "plugins"> {
  return (
    getCurrentPluginMetadataSnapshot({
      config: params.config,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    }) ??
    loadManifestContractSnapshot({
      config: params.config,
      env: params.env,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    })
  );
}

export function hasSnapshotCapabilityAvailability(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  key: CapabilityContractKey;
  config?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): boolean {
  if (params.config?.plugins?.enabled === false) {
    return false;
  }
  for (const plugin of params.snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    const metadataKey = metadataKeyForCapabilityContract(params.key);
    for (const providerId of plugin.contracts?.[params.key] ?? []) {
      const metadata = metadataKey ? plugin[metadataKey]?.[providerId] : undefined;
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
        plugin,
        key: params.key,
        providerId,
      })) {
        if (
          !manifestProviderBaseUrlGuardPasses({
            config: params.config,
            guard: signal.providerBaseUrl,
          })
        ) {
          continue;
        }
        if (
          params.authStore &&
          listProfilesForProvider(params.authStore, signal.provider).length > 0
        ) {
          return true;
        }
        if (
          hasNonEmptyManifestEnvCandidate(
            process.env,
            manifestPluginSetupProviderEnvVars(plugin, signal.provider),
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function hasSnapshotProviderEnvAvailability(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  providerId: string;
  config?: OpenClawConfig;
}): boolean {
  if (params.config?.plugins?.enabled === false) {
    return false;
  }
  for (const plugin of params.snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    if (
      hasNonEmptyManifestEnvCandidate(
        process.env,
        manifestPluginSetupProviderEnvVars(plugin, params.providerId),
      )
    ) {
      return true;
    }
  }
  return false;
}
