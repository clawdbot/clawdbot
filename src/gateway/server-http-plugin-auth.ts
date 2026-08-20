import { resolveBundledChannelGatewayAuthBypassPaths } from "../channels/plugins/gateway-auth-bypass.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

const pluginGatewayAuthBypassPathsCache = new WeakMap<
  OpenClawConfig,
  Promise<ReadonlySet<string>>
>();

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
  const cached = pluginGatewayAuthBypassPathsCache.get(configSnapshot);
  if (cached) {
    return cached;
  }
  const resolved = resolvePluginGatewayAuthBypassPaths(configSnapshot).catch((error: unknown) => {
    pluginGatewayAuthBypassPathsCache.delete(configSnapshot);
    throw error;
  });
  pluginGatewayAuthBypassPathsCache.set(configSnapshot, resolved);
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
