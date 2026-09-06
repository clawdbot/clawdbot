import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findPluginHttpRouteRegistrationConflicts } from "./http-route-overlap.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginHttpRouteRegistry } from "./runtime.js";

type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

type PluginHttpRouteRegistrationLease = Pick<PluginRuntimeCapabilityLease, "isActive" | "retain">;
type RouteOwner = {
  entry: PluginHttpRouteRegistration;
  routes: PluginHttpRouteRegistration[];
  holders: Set<() => void>;
  handoffs: Set<Set<RouteOwner>>;
};
type RouteRetention = { owner: RouteOwner };
export type PluginHttpRouteHandoff = {
  park: (lease: PluginHttpRouteRegistrationLease) => void;
  release: () => void;
};

const pluginHttpRouteRegistryScope = new AsyncLocalStorage<{
  registry: PluginRegistry;
  leases: readonly PluginHttpRouteRegistrationLease[];
}>();
const routeOwners = new WeakMap<PluginHttpRouteRegistration, RouteOwner>();
const leasedRoutes = new WeakMap<PluginHttpRouteRegistrationLease, Set<RouteRetention>>();
const noopUnregister = () => {};

function removeOwnedRoute(owner: RouteOwner, successor?: RouteOwner): void {
  const index = owner.routes.indexOf(owner.entry);
  if (index >= 0) {
    owner.routes.splice(index, 1);
  }
  for (const handoff of owner.handoffs) {
    handoff.delete(owner);
    if (successor) {
      handoff.add(successor);
      successor.handoffs.add(handoff);
    }
  }
  owner.handoffs.clear();
  routeOwners.delete(owner.entry);
}

function retireUnheldRoute(owner: RouteOwner): void {
  if (owner.holders.size > 0) {
    return;
  }
  const index = owner.routes.indexOf(owner.entry);
  if (owner.handoffs.size === 0 || index < 0) {
    removeOwnedRoute(owner);
  } else if (!owner.entry.handoff) {
    // Shared ingress serves live holders, then stays retryable while any
    // replacement still owns it. Late unregisters retain this same owner.
    const previous = owner.entry;
    owner.entry = {
      ...previous,
      handoff: true,
      handleUpgrade: undefined,
      handler: (_req, res) => {
        res.statusCode = 503;
        res.setHeader("Retry-After", "1");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("plugin route is restarting; retry");
        return true;
      },
    };
    owner.routes.splice(index, 1, owner.entry);
    routeOwners.delete(previous);
    routeOwners.set(owner.entry, owner);
  }
}

/** Keep retired ingress retryable until a successor claims it or every replacement ends. */
export function createPluginHttpRouteHandoff(): PluginHttpRouteHandoff {
  const routes = new Set<RouteOwner>();
  return {
    park(lease) {
      for (const { owner } of leasedRoutes.get(lease) ?? []) {
        if (owner.routes.includes(owner.entry)) {
          routes.add(owner);
          owner.handoffs.add(routes);
        }
      }
    },
    release() {
      for (const owner of routes) {
        owner.handoffs.delete(routes);
        retireUnheldRoute(owner);
      }
      routes.clear();
    },
  };
}

function hasSameRouteOwner(
  left: Pick<PluginHttpRouteRegistration, "pluginId" | "source" | "auth">,
  right: Pick<PluginHttpRouteRegistration, "pluginId" | "source" | "auth">,
): boolean {
  return (
    left.auth === right.auth &&
    normalizeOptionalString(left.pluginId) === normalizeOptionalString(right.pluginId) &&
    normalizeOptionalString(left.source) === normalizeOptionalString(right.source)
  );
}

export function adoptPluginHttpRouteHandoffs(previous: PluginRegistry, next: PluginRegistry): void {
  if (previous === next) {
    return;
  }
  const transfers = previous.httpRoutes.flatMap((entry) => {
    const owner = routeOwners.get(entry);
    if (!owner || !entry.handoff) {
      return [];
    }
    const conflicts = findPluginHttpRouteRegistrationConflicts(next.httpRoutes, entry);
    if (
      conflicts.authOverlap ||
      conflicts.canonicalMatches.some((route) => !hasSameRouteOwner(route, entry))
    ) {
      throw new Error(`plugin reload cannot replace HTTP route ownership at ${entry.path}`);
    }
    return [{ owner, replacement: conflicts.canonicalMatches[0] }];
  });
  // Validate the complete incoming registry before changing either serving array.
  for (const { owner, replacement } of transfers) {
    if (replacement) {
      removeOwnedRoute(owner, routeOwners.get(replacement));
    } else {
      previous.httpRoutes.splice(previous.httpRoutes.indexOf(owner.entry), 1);
      next.httpRoutes.push(owner.entry);
      owner.routes = next.httpRoutes;
    }
  }
}

// Same-owner reuse creates independent holders so one task cannot evict a route
// while another live task or pending replacement still owns its ingress.
function retainPluginHttpRoute(params: {
  entry: PluginHttpRouteRegistration;
  leases: readonly PluginHttpRouteRegistrationLease[];
}): () => void {
  const owner = routeOwners.get(params.entry);
  // Static API routes belong to the registry; borrowing one cannot give a
  // dynamic caller authority to remove it on unregister or lease expiry.
  if (!owner) {
    return noopUnregister;
  }
  const retention = { owner };
  const leaseReleases: Array<() => void> = [];
  const release = () => {
    if (!owner.holders.delete(release)) {
      return;
    }
    for (const lease of params.leases) {
      leasedRoutes.get(lease)?.delete(retention);
    }
    for (const releaseLease of leaseReleases.splice(0)) {
      releaseLease();
    }
    retireUnheldRoute(owner);
  };
  owner.holders.add(release);
  for (const lease of params.leases) {
    let retentions = leasedRoutes.get(lease);
    if (!retentions) {
      retentions = new Set();
      leasedRoutes.set(lease, retentions);
    }
    retentions.add(retention);
    leaseReleases.push(lease.retain(release));
  }
  return release;
}

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
  // AsyncLocalStorage survives timed-out lifecycle callbacks; expired continuations must not
  // regain route authority, even when they retained an explicit registry reference.
  if (scope?.leases.some((lease) => !lease.isActive())) {
    return rejectRegistration("plugin runtime HTTP route lease is no longer active");
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
  const successor: RouteOwner = { entry, routes, holders: new Set(), handoffs: new Set() };
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
    const mismatchedOwner = canonicalMatches.find((route) => !hasSameRouteOwner(route, params));
    const replaceExisting =
      params.replaceExisting ||
      (!mismatchedOwner && canonicalMatches.every((route) => route.handoff));
    if (!replaceExisting && params.reuseExistingSameOwner) {
      if (requestedOwner !== undefined && requestedSource !== undefined && !mismatchedOwner) {
        params.log?.(
          `plugin: reusing existing webhook path ${normalizedPath} (${routeMatch}) (${requestedOwner}/${requestedSource})`,
        );
        return retainPluginHttpRoute({
          entry: existing,
          leases: scope?.leases ?? [],
        });
      }
      const conflictingOwner = mismatchedOwner ?? existing;
      return rejectRegistration(
        `plugin: route reuse denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${conflictingOwner.pluginId ?? "unknown-plugin"} (${conflictingOwner.source ?? "unknown-source"})`,
      );
    }
    if (!replaceExisting) {
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
      const owner = routeOwners.get(route);
      if (owner) {
        // The first replacement may stop while a shared sibling is still
        // starting. Transfer its pending handoffs, not its retired live holders.
        removeOwnedRoute(owner, successor);
      }
      const index = routes.indexOf(route);
      if (index >= 0) {
        routes.splice(index, 1);
      }
    }
  }

  routeOwners.set(entry, successor);
  routes.push(entry);
  return retainPluginHttpRoute({
    entry,
    leases: scope?.leases ?? [],
  });
}
