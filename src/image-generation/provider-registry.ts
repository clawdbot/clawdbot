/** Registry for image-generation providers contributed by plugin capabilities. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";

function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, ImageGenerationProviderPlugin>;
  aliases: Map<string, ImageGenerationProviderPlugin>;
} {
  return buildCapabilityProviderMaps(
    capabilityProviderRuntime.resolvePluginCapabilityProviders({
      key: "imageGenerationProviders",
      cfg,
    }),
    normalizeCapabilityProviderId,
  );
}

/** Lists canonical image-generation providers visible for config. */
export function listImageGenerationProviders(
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

/** Resolves an image-generation provider by canonical id or alias. */
export function getImageGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin | undefined {
  const normalized = normalizeCapabilityProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}
