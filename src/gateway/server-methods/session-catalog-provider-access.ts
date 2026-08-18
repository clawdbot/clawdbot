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
