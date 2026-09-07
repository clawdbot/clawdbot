/**
 * Doctor-only setup promotion lookup through plugin-owned manifests and setup entries.
 *
 * Kept separate so hot Plugin SDK setup helpers never import plugin discovery.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogManifest,
} from "../../plugins/official-external-plugin-catalog.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import { loadSetupChannelPluginFromManifestRecord } from "./setup-entry-loader.js";
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
  const officialManifest = getOfficialExternalPluginCatalogManifest(
    getOfficialExternalPluginCatalogEntry(channelKey) ?? {},
  );
  if (officialManifest?.setupFeatures?.configPromotion === "preserve-root") {
    return { configPromotion: "preserve-root" };
  }
  const owner = registry.plugins.find(
    (plugin) =>
      plugin.channels.includes(channelKey) &&
      plugin.packageManifest?.setupFeatures?.configPromotion === true,
  );
  if (!owner) {
    return null;
  }
  const { plugin } = loadSetupChannelPluginFromManifestRecord({
    record: owner,
    channelId: channelKey,
    env: process.env,
  });
  const setup = plugin?.setupContract ?? plugin?.setup;
  return setup && typeof setup === "object" ? setup : null;
}
