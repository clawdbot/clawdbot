import { resolveBundledChannelGatewayAuthBypassPaths } from "../channels/plugins/gateway-auth-bypass.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import type { PluginNodeCapabilitySurface } from "./plugin-node-capability.js";
import {
  isProtectedPluginRoutePathFromContext,
  type PluginRoutePathContext,
} from "./server/plugins-http/path-context.js";

export type PluginGatewayDispatchContext = {
  gatewayAuthSatisfied?: boolean;
  gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
  gatewayRequestOperatorScopes?: readonly string[];
  gatewayRequestClientIp?: string;
};

export type ResolvePluginNodeCapabilityRoute = (
  pathContext: PluginRoutePathContext,
) => PluginNodeCapabilitySurface | undefined;

// Bypass paths come from plugin-declared artifacts, not config bytes alone. A
// metadata lifecycle reset can replace that contract while the config object
// identity stays stable, so the cache must roll to a fresh generation on reset
// or a replaced channel plugin keeps its predecessor's HTTP auth exceptions.
let pluginGatewayAuthBypassPathsCache = new WeakMap<OpenClawConfig, Promise<ReadonlySet<string>>>();

registerPluginMetadataProcessMemoLifecycleClear(() => {
  pluginGatewayAuthBypassPathsCache = new WeakMap();
});

async function resolvePluginGatewayAuthBypassPaths(
  configSnapshot: OpenClawConfig,
): Promise<Set<string>> {
  const paths = new Set<string>();
  const configuredChannels = configSnapshot.channels;
  if (!configuredChannels || Object.keys(configuredChannels).length === 0) {
    return paths;
  }
  for (const channelId of Object.keys(configuredChannels)) {
    for (const path of await resolveBundledChannelGatewayAuthBypassPaths({
      channelId,
      cfg: configSnapshot,
    })) {
      paths.add(path);
    }
  }
  return paths;
}

export function getCachedPluginGatewayAuthBypassPaths(
  configSnapshot: OpenClawConfig,
): Promise<ReadonlySet<string>> {
  const cache = pluginGatewayAuthBypassPathsCache;
  const cached = cache.get(configSnapshot);
  if (cached) {
    return cached;
  }
  const resolved = resolvePluginGatewayAuthBypassPaths(configSnapshot).catch((error: unknown) => {
    // Evict from the owning generation only; a stale failure settling after a
    // lifecycle reset must not drop a freshly cached entry.
    cache.delete(configSnapshot);
    throw error;
  });
  cache.set(configSnapshot, resolved);
  return resolved;
}

export function shouldEnforceDefaultPluginGatewayAuth(
  pathContext: PluginRoutePathContext,
): boolean {
  return (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    isProtectedPluginRoutePathFromContext(pathContext)
  );
}
