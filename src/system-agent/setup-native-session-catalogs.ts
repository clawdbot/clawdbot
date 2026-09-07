import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import {
  applyNativeSessionCatalogPreference,
  hasLegacyNativeSessionCatalogDefault,
  readNativeSessionCatalogPreference,
  shippedNativeSessionCatalogs,
} from "../plugins/native-session-catalog-config.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

export type SetupNativeSessionCatalogOption = {
  pluginId: string;
  label: string;
  detail?: string;
};

type CatalogOptions = {
  config: OpenClawConfig;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
};

export function requiresSetupNativeSessionCatalogConsent(params: {
  configExists: boolean;
  config: OpenClawConfig;
  catalogs: readonly SetupNativeSessionCatalogOption[];
}): boolean {
  if (params.catalogs.length === 0) {
    return false;
  }
  // A fresh writer records false before any plugin runs. Legacy missing or mixed
  // preferences remain untouched. Doctor and baseline setup metadata do not establish consent.
  return params.catalogs.every(({ pluginId }) => {
    const enabled = readNativeSessionCatalogPreference(params.config, pluginId);
    return (
      enabled === false ||
      (enabled === undefined &&
        (!params.configExists || !hasLegacyNativeSessionCatalogDefault(pluginId)))
    );
  });
}

export function resolveSetupNativeSessionCatalogPreference(params: {
  consentRequired: boolean;
  requested?: boolean;
}): boolean | undefined {
  return params.consentRequired ? (params.requested ?? false) : undefined;
}

export function listSetupNativeSessionCatalogs(
  params: CatalogOptions,
): SetupNativeSessionCatalogOption[] {
  const snapshot =
    params.metadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: process.env,
    });
  const catalogs = new Map(
    shippedNativeSessionCatalogs.map((catalog) => [catalog.pluginId, catalog]),
  );
  for (const plugin of snapshot.plugins) {
    if (plugin.setup?.nativeSessionCatalog) {
      catalogs.set(plugin.id, { pluginId: plugin.id, ...plugin.setup.nativeSessionCatalog });
    }
  }
  return [...catalogs.values()]
    .map(({ pluginId, label, description }) => {
      const option: SetupNativeSessionCatalogOption = { pluginId, label };
      if (description) {
        option.detail = description;
      }
      return option;
    })
    .toSorted(
      (a, b) => a.label.localeCompare(b.label, "en") || a.pluginId.localeCompare(b.pluginId, "en"),
    );
}

export function applySetupNativeSessionCatalogPreference(
  params: CatalogOptions & {
    enabled: boolean;
  },
): OpenClawConfig {
  return applyNativeSessionCatalogPreference(
    params.config,
    listSetupNativeSessionCatalogs(params).map(({ pluginId }) => pluginId),
    params.enabled,
  );
}
