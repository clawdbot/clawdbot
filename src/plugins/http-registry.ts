import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
// Tracks plugin HTTP registry context for current async execution.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizePluginHttpPath } from "./http-path.js";
import { findPluginHttpRouteRegistrationConflicts } from "./http-route-overlap.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginHttpRouteRegistry } from "./runtime.js";

type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

type PluginHttpRouteRegistrationLease = {
  isActive: () => boolean;
  retain: (unregister: () => void) => () => void;
};

export type PluginCapabilityLease = PluginHttpRouteRegistrationLease & {
  assertActive: (capability: string) => void;
  revoke: () => void;
};

// One lease per runtime lifetime (plugin service, channel account task, ...).
// Registrations retain their unregister through it, so revoke reclaims the
// lifetime's routes; assertActive gates capability-issued work.
export function createPluginCapabilityLease(): PluginCapabilityLease {
  let active = true;
  const cleanups = new Set<() => void>();
  const assertActive = (capability: string) => {
    if (!active) {
      throw new Error(`plugin service ${capability} is no longer active`);
    }
  };
  const retain = (cleanup: () => void): (() => void) => {
    if (!active) {
      cleanup();
      assertActive("capability lease");
    }
    const release = () => {
      if (cleanups.delete(release)) {
        cleanup();
      }
    };
    cleanups.add(release);
    return release;
  };
  return {
    isActive: () => active,
    assertActive,
    retain,
    revoke: () => {
      if (!active) {
        return;
      }
      active = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

const pluginHttpRouteRegistryScope = new AsyncLocalStorage<{
  registry: PluginRegistry;
  leases: readonly PluginHttpRouteRegistrationLease[];
}>();
const noopUnregister = () => {};

export function withPluginHttpRouteRegistry<T>(
  registry: PluginRegistry,
  run: () => T,
  lease?: PluginHttpRouteRegistrationLease,
): T {
  const inherited = pluginHttpRouteRegistryScope.getStore()?.leases ?? [];
  const leases = lease && !inherited.includes(lease) ? [...inherited, lease] : inherited;
  return pluginHttpRouteRegistryScope.run({ registry, leases }, run);
}

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  auth: PluginHttpRouteRegistration["auth"];
  match?: PluginHttpRouteRegistration["match"];
  gatewayRuntimeScopeSurface?: PluginHttpRouteRegistration["gatewayRuntimeScopeSurface"];
  /** Replace an existing canonical route owned by the same plugin and compatible route source. */
  replaceExisting?: boolean;
  /** Reuse an existing canonical route only when its nonempty plugin and source owners match. */
  reuseExistingSameOwner?: boolean;
  /** Throw when the route cannot be registered instead of returning a no-op cleanup. */
  throwOnFailure?: boolean;
  pluginId?: string;
  /** Stable same-plugin sub-owner for replacement; omit consistently for legacy behavior. */
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
}): () => void {
  const scope = pluginHttpRouteRegistryScope.getStore();
  const registry = params.registry ?? scope?.registry ?? requireActivePluginHttpRouteRegistry();
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  const rejectRegistration = (message: string): (() => void) => {
    params.log?.(message);
    if (params.throwOnFailure) {
      throw new Error(message);
    }
    return noopUnregister;
  };
  // AsyncLocalStorage survives timed-out service callbacks; expired continuations must not
  // regain route authority, even when they retained an explicit registry reference.
  if (scope?.leases.some((lease) => !lease.isActive())) {
    return rejectRegistration("plugin service HTTP route lease is no longer active");
  }

  const routes = registry.httpRoutes ?? [];
  registry.httpRoutes = routes;
  const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
  if (!normalizedPath) {
    return rejectRegistration(`plugin: webhook path missing${suffix}`);
  }
  const routeMatch = params.match ?? "exact";
  const candidate = {
    path: normalizedPath,
    match: routeMatch,
    auth: params.auth,
  };
  const { authOverlap, canonicalMatches } = findPluginHttpRouteRegistrationConflicts(
    routes,
    candidate,
  );
  if (authOverlap) {
    return rejectRegistration(
      `plugin: route overlap denied at ${normalizedPath} (${routeMatch}, ${params.auth})${suffix}; ` +
        `overlaps ${authOverlap.path} (${authOverlap.match}, ${authOverlap.auth}) ` +
        `owned by ${authOverlap.pluginId ?? "unknown-plugin"} (${authOverlap.source ?? "unknown-source"})`,
    );
  }
  // Canonical aliases occupy one Gateway route even when their configured
  // bytes differ. Nested same-auth prefix chains remain separate routes.
  const existingIndex = canonicalMatches[0] ? routes.indexOf(canonicalMatches[0]) : -1;
  if (existingIndex >= 0) {
    const existing = routes[existingIndex];
    if (!existing) {
      return rejectRegistration(
        `plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}`,
      );
    }
    const requestedOwner = normalizeOptionalString(params.pluginId);
    const requestedSource = normalizeOptionalString(params.source);
    const mismatchedOwner = canonicalMatches.find(
      (route) =>
        normalizeOptionalString(route.pluginId) !== requestedOwner ||
        normalizeOptionalString(route.source) !== requestedSource,
    );
    if (!params.replaceExisting && params.reuseExistingSameOwner) {
      if (requestedOwner !== undefined && requestedSource !== undefined && !mismatchedOwner) {
        params.log?.(
          `plugin: reusing existing webhook path ${normalizedPath} (${routeMatch}) (${requestedOwner}/${requestedSource})`,
        );
        return noopUnregister;
      }
      const conflictingOwner = mismatchedOwner ?? existing;
      return rejectRegistration(
        `plugin: route reuse denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${conflictingOwner.pluginId ?? "unknown-plugin"} (${conflictingOwner.source ?? "unknown-source"})`,
      );
    }
    if (!params.replaceExisting) {
      return rejectRegistration(
        `plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`,
      );
    }
    // Source-less same-plugin replacement shipped before route-source ownership.
    // Preserve it only when both sides omit source; otherwise require an exact source match.
    const incompatibleReplacement = canonicalMatches.find(
      (route) =>
        normalizeOptionalString(route.pluginId) !== requestedOwner ||
        (requestedOwner !== undefined && normalizeOptionalString(route.source) !== requestedSource),
    );
    if (incompatibleReplacement) {
      return rejectRegistration(
        `plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${incompatibleReplacement.pluginId ?? "unknown-plugin"} (${incompatibleReplacement.source ?? "unknown-source"})`,
      );
    }
    const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
    params.log?.(
      `plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`,
    );
    for (const route of canonicalMatches.toReversed()) {
      const index = routes.indexOf(route);
      if (index >= 0) {
        routes.splice(index, 1);
      }
    }
  }

  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: params.handler,
    auth: params.auth,
    match: routeMatch,
    ...(params.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
      : {}),
    pluginId: params.pluginId,
    source: params.source,
  };
  routes.push(entry);

  const releases: Array<() => void> = [];
  const unregister = () => {
    const index = routes.indexOf(entry);
    if (index >= 0) {
      routes.splice(index, 1);
    }
    for (const release of releases.splice(0)) {
      release();
    }
  };
  scope?.leases.forEach((lease) => releases.push(lease.retain(unregister)));
  return unregister;
}
