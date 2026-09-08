import {
  getOfficialExternalPluginCatalogEntryForPackage,
  isOfficialExternalPluginId,
  resolveOfficialExternalPluginId,
} from "./official-external-plugin-catalog.js";
import type { PluginRecord } from "./registry-types.js";

type PluginPublicIdentityInput = Pick<
  PluginRecord,
  "id" | "origin" | "packageName" | "trustedOfficialInstall"
>;

/** True when a plugin identity is already public and safe to report. */
export function isPubliclyKnownPluginId(plugin: PluginPublicIdentityInput): boolean {
  if (plugin.origin === "bundled" || plugin.trustedOfficialInstall === true) {
    return true;
  }
  if (!isOfficialExternalPluginId(plugin.id)) {
    return false;
  }
  const catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(plugin.packageName);
  return catalogEntry !== undefined && resolveOfficialExternalPluginId(catalogEntry) === plugin.id;
}
