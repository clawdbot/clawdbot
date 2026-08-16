import { getActivePluginSessionExtensionRegistry } from "./runtime.js";
import type { SessionCatalogProvider } from "./session-catalog.js";

export type ActiveSessionCatalog = {
  pluginId: string;
  id: string;
  label: string;
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
  return registrations
    .map(({ pluginId, provider }) => ({
      pluginId,
      id: provider.id,
      label: provider.label,
      list: provider.list.bind(provider),
      read: provider.read.bind(provider),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
