import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
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
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { SessionCatalogListAdmission } from "./session-catalog-list-admission.js";
import type { GatewayClient } from "./types.js";

const MAX_CONCURRENT_SESSION_CATALOG_LISTS = 4;
const MAX_QUEUED_SESSION_CATALOG_LISTS = 32;
const SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS = 500;
const PROCESS_HOME_CATALOG_SKIP_MESSAGE =
  "external session catalog HOME fallback skipped: isolated state; configure an explicit root to enable";

let reportedProcessHomeCatalogSkip = false;

export function normalizeSessionCatalogSearch(search: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(search);
  return normalized
    ? truncateUtf16Safe(normalized, SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS)
    : undefined;
}

export function allowProcessHomeFallback(
  logGateway?: { warn: (message: string, fields?: Record<string, unknown>) => void },
  params?: {
    access: "read" | "mutate";
    client: GatewayClient | null;
    provider: SessionCatalogProvider;
  },
): boolean {
  const scopes = Array.isArray(params?.client?.connect?.scopes) ? params.client.connect.scopes : [];
  const adminRead =
    params?.access === "read" &&
    params.provider.adminProcessHomeRead === true &&
    authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, scopes).allowed;
  const allowed = allowsProcessHomeSessionScan() || adminRead;
  if (!allowed && !reportedProcessHomeCatalogSkip && logGateway) {
    reportedProcessHomeCatalogSkip = true;
    logGateway.warn(PROCESS_HOME_CATALOG_SKIP_MESSAGE, { reason: "isolated_state" });
  }
  return allowed;
}

export function allowCatalogProcessHomeRead(
  provider: SessionCatalogProvider,
  client: GatewayClient | null,
  logGateway?: { warn: (message: string, fields?: Record<string, unknown>) => void },
): boolean {
  return allowProcessHomeFallback(logGateway, { access: "read", client, provider });
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
  return sessionCatalogListAdmission.run(() => {
    params.signal?.throwIfAborted();
    return provider.list(params);
  });
}

function resolveSessionCatalogRegistry(): PluginRegistry | null {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

export type CatalogRegistrationSnapshot = {
  registry: PluginRegistry | null;
  source: PluginRegistry["sessionCatalogs"] | undefined;
  registrations: PluginRegistry["sessionCatalogs"];
  providers: SessionCatalogProvider[];
  shareRoutes: ReadonlyMap<SessionCatalogProvider, SessionCatalogShareRoute>;
};

export function catalogAllowsProcessHomeMutations(
  snapshot: CatalogRegistrationSnapshot,
  provider: SessionCatalogProvider,
): boolean | undefined {
  return snapshot.registrations.find((entry) => entry.provider === provider)
    ?.allowProcessHomeMutations;
}

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
