// Plugin HTTP route capability helpers discover node-authorized route surfaces from plugin registrations.
import type { PluginRegistry } from "../../../plugins/registry.js";
import {
  resolvePluginNodeCapabilityTtlMs,
  type PluginNodeCapabilitySurface,
} from "../../plugin-node-capability.js";
import type { PluginRoutePathContext } from "./path-context.js";
import { findMatchingPluginHttpRoutes } from "./route-match.js";

/**
 * Node-capability route discovery for plugin HTTP routes.
 */
type PluginHttpRouteEntry = NonNullable<PluginRegistry["httpRoutes"]>[number];

/** Registered plugin route enriched with its node capability surface. */
export type PluginNodeCapabilityRoute = PluginHttpRouteEntry & {
  nodeCapability: PluginNodeCapabilitySurface;
};

function hasNodeCapabilityRoute(route: PluginHttpRouteEntry): route is PluginNodeCapabilityRoute {
  return Boolean(route.nodeCapability?.surface?.trim());
}

function resolvePluginNodeCapabilityRouteSurface(
  route: PluginNodeCapabilityRoute,
): PluginNodeCapabilitySurface {
  const surface = route.nodeCapability.surface.trim();
  const owner = route.pluginId?.trim() || route.source?.trim();
  return {
    ...route.nodeCapability,
    surface,
    ...(owner ? { scopeKey: `${owner}:${surface}` } : {}),
  };
}

/** Lists all node-capability routes matching the already canonicalized path context. */
function findMatchingPluginNodeCapabilityRoutes(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginNodeCapabilityRoute[] {
  return findMatchingPluginHttpRoutes(registry, context)
    .filter(hasNodeCapabilityRoute)
    .map((route) =>
      Object.assign({}, route, {
        nodeCapability: resolvePluginNodeCapabilityRouteSurface(route),
      }),
    );
}

/** Returns the highest-priority node-capability route for a plugin HTTP path. */
export function findMatchingPluginNodeCapabilityRoute(
  registry: PluginRegistry,
  context: PluginRoutePathContext,
): PluginNodeCapabilityRoute | undefined {
  return findMatchingPluginNodeCapabilityRoutes(registry, context)[0];
}

/** Lists unique node-capability surfaces, preferring the shortest TTL per surface. */
export function listPluginNodeCapabilities(
  registry: PluginRegistry,
): PluginNodeCapabilitySurface[] {
  const surfaces = new Map<string, PluginNodeCapabilitySurface>();
  for (const route of registry.httpRoutes ?? []) {
    const surface = route.nodeCapability?.surface?.trim();
    if (surface) {
      const next = resolvePluginNodeCapabilityRouteSurface(route as PluginNodeCapabilityRoute);
      const existing = surfaces.get(surface);
      if (!existing || resolveTtlMs(next) < resolveTtlMs(existing)) {
        surfaces.set(surface, next);
      }
    }
  }
  return [...surfaces.values()].toSorted((a, b) => a.surface.localeCompare(b.surface));
}

function resolveTtlMs(surface: PluginNodeCapabilitySurface) {
  return resolvePluginNodeCapabilityTtlMs(surface);
}
