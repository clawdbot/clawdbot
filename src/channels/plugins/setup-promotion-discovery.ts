/**
 * Doctor-only setup promotion surface discovery.
 *
 * Doctor processes never load the runtime plugin registry, so promotion
 * declarations must come from the same read-only manifest/setup-entry
 * resolution the rest of doctor uses. That path covers external installed
 * channel plugins; the bundled lookup stays as the fallback for channels
 * without an installed setup entry.
 *
 * Kept separate so hot Plugin SDK setup helpers never import discovery.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveReadOnlyChannelPluginsForConfig } from "./read-only.js";
import { resolveBundledChannelSetupPromotionSurface } from "./setup-promotion-bundled.js";
import type { ChannelSetupPromotionSurface } from "./setup-promotion-helpers.js";

function asPromotionSurface(value: unknown): ChannelSetupPromotionSurface | null {
  return value && typeof value === "object" ? (value as ChannelSetupPromotionSurface) : null;
}

/**
 * Compose read-only installed-plugin discovery with the bundled fallback into
 * one lazily-resolved promotion surface resolver for doctor config migration.
 */
export function createDiscoveredChannelSetupPromotionSurfaceResolver(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): (channelKey: string) => ChannelSetupPromotionSurface | null {
  let surfacesByChannelId: Map<string, ChannelSetupPromotionSurface | null> | undefined;
  const resolveSurfacesByChannelId = () => {
    if (surfacesByChannelId) {
      return surfacesByChannelId;
    }
    surfacesByChannelId = new Map();
    try {
      const { plugins } = resolveReadOnlyChannelPluginsForConfig(cfg, {
        ...(options.env ? { env: options.env } : {}),
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      });
      for (const plugin of plugins) {
        // Mirror the channel contract precedence: the owned setup contract is
        // the preferred surface; the legacy setup adapter is deprecated.
        surfacesByChannelId.set(
          plugin.id,
          asPromotionSurface(plugin.setupContract ?? plugin.setup),
        );
      }
    } catch {
      // Discovery must never break doctor repair; the bundled fallback still applies.
    }
    return surfacesByChannelId;
  };
  return (channelKey) =>
    // An installed plugin's setup surface is authoritative for its channel id:
    // when it declares no promotion keys, promotion stays deferred rather than
    // borrowing bundled declarations the installed plugin did not sanction.
    // The bundled lookup only covers channels with no installed setup entry.
    resolveSurfacesByChannelId().get(channelKey) ??
    resolveBundledChannelSetupPromotionSurface(channelKey);
}
