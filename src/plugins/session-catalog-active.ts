import { allowsProcessHomeSessionScan } from "../config/paths.js";
import { getActivePluginSessionExtensionRegistry } from "./runtime.js";
import type { SessionCatalogProvider } from "./session-catalog.js";

export type ActiveSessionCatalog = {
  pluginId: string;
  id: string;
  label: string;
  processHomeFallbackAllowed: boolean;
  list: SessionCatalogProvider["list"];
  read: SessionCatalogProvider["read"];
};

/**
 * Read-only list/read facade over the active registered session catalogs.
 * Deliberately excludes continue/archive/terminal so consumers cannot gain
 * session control through this seam; mutation stays on the gateway RPCs.
 */
export function listActiveSessionCatalogs(): ActiveSessionCatalog[] {
  const registrations = getActivePluginSessionExtensionRegistry()?.sessionCatalogs ?? [];
  const allowProcessHomeFallback = allowsProcessHomeSessionScan();
  return registrations
    .map(({ pluginId, provider }) => ({
      pluginId,
      id: provider.id,
      label: provider.label,
      processHomeFallbackAllowed: allowProcessHomeFallback,
      list: (params: Parameters<SessionCatalogProvider["list"]>[0]) =>
        provider.list({ ...params, allowProcessHomeFallback }),
      read: (params: Parameters<SessionCatalogProvider["read"]>[0]) =>
        provider.read({ ...params, allowProcessHomeFallback }),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
