import { isRecord } from "@openclaw/normalization-core/record-coerce";
import catalogs from "../../scripts/lib/native-session-catalogs.json" with { type: "json" };
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestNativeSessionCatalogSetup } from "./manifest-types.js";

export const shippedNativeSessionCatalogs: readonly (PluginManifestNativeSessionCatalogSetup & {
  pluginId: string;
})[] = catalogs;

/** Only host-generated declarations can carry a shipped implicit-on upgrade contract. */
export function hasLegacyNativeSessionCatalogDefault(pluginId: string): boolean {
  return shippedNativeSessionCatalogs.some(
    (catalog) => catalog.pluginId === pluginId && catalog.legacyDefaultEnabled === true,
  );
}

type NativeCatalogConfig = {
  plugins?: { entries?: Readonly<Record<string, { config?: unknown } | undefined>> };
};

export function readNativeSessionCatalogPreference(config: NativeCatalogConfig, pluginId: string) {
  const entry = config.plugins?.entries?.[pluginId]?.config;
  const catalog =
    isRecord(entry) && isRecord(entry.sessionCatalog) ? entry.sessionCatalog : undefined;
  return typeof catalog?.enabled === "boolean" ? catalog.enabled : undefined;
}

/** A first-write privacy preference alone does not request plugin installation. */
export function isNativeSessionCatalogOptOutOnly(pluginId: string, entry: unknown): boolean {
  if (
    !shippedNativeSessionCatalogs.some((catalog) => catalog.pluginId === pluginId) ||
    !isRecord(entry) ||
    Object.keys(entry).length !== 1 ||
    !isRecord(entry.config) ||
    Object.keys(entry.config).length !== 1
  ) {
    return false;
  }
  const catalog = entry.config.sessionCatalog;
  return isRecord(catalog) && Object.keys(catalog).length === 1 && catalog.enabled === false;
}

export function applyNativeSessionCatalogPreference(
  config: OpenClawConfig,
  pluginIds: readonly string[],
  enabled: boolean,
  onlyUnset = false,
): OpenClawConfig {
  const entries = { ...config.plugins?.entries };
  let changed = false;
  for (const pluginId of pluginIds) {
    const entry = entries[pluginId] ?? {};
    const pluginConfig = isRecord(entry.config) ? entry.config : {};
    const sessionCatalog = isRecord(pluginConfig.sessionCatalog) ? pluginConfig.sessionCatalog : {};
    if (
      sessionCatalog.enabled === enabled ||
      (onlyUnset && Object.hasOwn(sessionCatalog, "enabled"))
    ) {
      continue;
    }
    entries[pluginId] = {
      ...entry,
      config: { ...pluginConfig, sessionCatalog: { ...sessionCatalog, enabled } },
    };
    changed = true;
  }
  return changed ? { ...config, plugins: { ...config.plugins, entries } } : config;
}

/** Called only by the config writer after its snapshot proves the file is absent. */
export function initializeNativeSessionCatalogPreferences(config: OpenClawConfig): OpenClawConfig {
  return applyNativeSessionCatalogPreference(
    config,
    shippedNativeSessionCatalogs.map(({ pluginId }) => pluginId),
    false,
    true,
  );
}
