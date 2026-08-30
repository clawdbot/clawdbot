/**
 * Doctor-only static setup promotion lookup, with bundled setup fallback.
 *
 * Kept separate so hot Plugin SDK setup helpers never import plugin discovery.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import { getBundledChannelSetupPlugin, hasBundledChannelPackageSetupFeature } from "./bundled.js";
import type { ChannelSetupPromotionSurface } from "./setup-promotion-helpers.js";

export function resolveDiscoveredChannelSetupPromotionSurface(
  channelKey: string,
  cfg: OpenClawConfig,
): ChannelSetupPromotionSurface | null {
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: cfg,
    includeDisabled: true,
  });
  // Disabled owners still own their saved layout. Static declarations must not
  // require executing an installed plugin just to preserve its configuration.
  if (
    registry.plugins.some(
      (plugin) =>
        plugin.channels.includes(channelKey) &&
        plugin.packageManifest?.setupFeatures?.configPromotion === "preserve-root",
    )
  ) {
    return { configPromotion: "preserve-root" };
  }
  if (!hasBundledChannelPackageSetupFeature(channelKey, "configPromotion")) {
    return null;
  }
  const plugin = getBundledChannelSetupPlugin(channelKey);
  const setup = plugin?.setupContract ?? plugin?.setup;
  return setup && typeof setup === "object" ? setup : null;
}
