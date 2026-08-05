// Video provider registry stores video generation provider factories by id.
import type { OpenClawConfig } from "../config/types.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, VideoGenerationProviderPlugin>;
  aliases: Map<string, VideoGenerationProviderPlugin>;
} {
  return buildCapabilityProviderMaps(
    capabilityProviderRuntime.resolvePluginCapabilityProviders({
      key: "videoGenerationProviders",
      cfg,
    }),
    normalizeCapabilityProviderId,
  );
}

export function listVideoGenerationProviders(
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

export function getVideoGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin | undefined {
  const normalized = normalizeCapabilityProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
