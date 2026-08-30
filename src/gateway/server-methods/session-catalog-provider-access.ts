import { isControlUiReservedRouteSegment } from "@openclaw/session-url-contract";
import {
  validateSessionCatalogShareRoute,
  type SessionCatalogShareRoute,
} from "../../../packages/gateway-protocol/src/index.js";
import { allowsProcessHomeSessionScan } from "../../config/paths.js";
import { getPluginRegistryRuntime } from "../../plugins/registry-runtime-binding.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type {
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { SessionCatalogListAdmission } from "./session-catalog-list-admission.js";

const MAX_CONCURRENT_SESSION_CATALOG_LISTS = 4;
const MAX_QUEUED_SESSION_CATALOG_LISTS = 32;
const PROCESS_HOME_CATALOG_SKIP_MESSAGE =
  "external session catalog HOME fallback skipped: isolated state; configure an explicit root to enable";

let reportedProcessHomeCatalogSkip = false;

export function allowProcessHomeFallback(logGateway?: {
  warn: (message: string, fields?: Record<string, unknown>) => void;
}): boolean {
  const allowed = allowsProcessHomeSessionScan();
  if (!allowed && !reportedProcessHomeCatalogSkip && logGateway) {
    reportedProcessHomeCatalogSkip = true;
    logGateway.warn(PROCESS_HOME_CATALOG_SKIP_MESSAGE, { reason: "isolated_state" });
  }
  return allowed;
}

// Catalog adapters may scan local databases or invoke external CLIs. Bound the
// expensive provider operation itself so adding providers cannot multiply the cap.
const sessionCatalogListAdmission = new SessionCatalogListAdmission(
  MAX_CONCURRENT_SESSION_CATALOG_LISTS,
  MAX_QUEUED_SESSION_CATALOG_LISTS,
);

export function listSessionCatalogProvider(
  provider: SessionCatalogProvider,
  params: SessionCatalogListProviderParams,
) {
  return sessionCatalogListAdmission.run(() => provider.list(params));
}

export function resolveSessionCatalogRegistry(): PluginRegistry | null {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

export type CatalogRegistrationSnapshot = {
  registry: PluginRegistry | null;
  source: PluginRegistry["sessionCatalogs"] | undefined;
  registrations: PluginRegistry["sessionCatalogs"];
  providers: SessionCatalogProvider[];
  shareRoutes: ReadonlyMap<SessionCatalogProvider, SessionCatalogShareRoute>;
};

let cachedCatalogRegistrations: CatalogRegistrationSnapshot | undefined;

export function catalogRegistrationSnapshot(): CatalogRegistrationSnapshot {
  const registry = resolveSessionCatalogRegistry();
  const source = registry?.sessionCatalogs;
  if (
    cachedCatalogRegistrations?.registry === registry &&
    cachedCatalogRegistrations.source === source
  ) {
    return cachedCatalogRegistrations;
  }
  const sortedRegistrations = (source ?? []).toSorted((left, right) =>
    left.provider.id.localeCompare(right.provider.id),
  );
  const providerList = sortedRegistrations.map((entry) => entry.provider);
  const validRoutes = providerList.flatMap((provider) =>
    provider.shareRoute &&
    validateSessionCatalogShareRoute(provider.shareRoute) &&
    !isControlUiReservedRouteSegment(provider.shareRoute.routeSegment)
      ? [{ provider, route: provider.shareRoute }]
      : [],
  );
  const routeCounts = new Map<string, number>();
  for (const { route } of validRoutes) {
    routeCounts.set(route.routeSegment, (routeCounts.get(route.routeSegment) ?? 0) + 1);
  }
  const shareRoutes = new Map(
    validRoutes
      .filter(({ route }) => routeCounts.get(route.routeSegment) === 1)
      .map(({ provider, route }) => [provider, route] as const),
  );
  // Plugin registration arrays are process-stable until the active registry seam changes. Hoisting
  // this sort avoids rebuilding identical order every poll; registry/list identity invalidates it.
  // A stale snapshot would route requests to retired plugin instances, so callers share this owner.
  cachedCatalogRegistrations = {
    registry,
    source,
    registrations: sortedRegistrations,
    providers: providerList,
    shareRoutes,
  };
  return cachedCatalogRegistrations;
}

export function createSessionCatalogRequestNodeSnapshot(): NonNullable<
  SessionCatalogListProviderParams["listNodes"]
> {
  const registry = resolveSessionCatalogRegistry();
  const nodes = registry ? getPluginRegistryRuntime(registry)?.nodes : undefined;
  let request: ReturnType<NonNullable<SessionCatalogListProviderParams["listNodes"]>> | undefined;
  return () => {
    // Every provider sees the same promise so one catalog request cannot multiply the
    // pairing-store scans performed by the Gateway node.list runtime.
    request ??=
      nodes?.list() ??
      Promise.reject(new Error("Plugin node runtime is only available inside the Gateway."));
    return request;
  };
}
