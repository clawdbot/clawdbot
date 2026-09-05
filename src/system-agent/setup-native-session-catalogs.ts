import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { readLocalOnboardingStateForConfig } from "../state/local-onboarding-state.js";

export type SetupNativeSessionCatalogOption = {
  pluginId: string;
  label: string;
  detail?: string;
};

export function requiresSetupNativeSessionCatalogConsent(params: {
  configPath: string;
  config: OpenClawConfig;
  setupComplete: boolean;
  agentId?: string;
  completedLocalOnboarding?: boolean;
}): boolean {
  if (params.agentId || params.setupComplete) {
    return false;
  }
  if (
    params.config.wizard?.lastRunAt?.trim() ||
    (params.completedLocalOnboarding ??
      readLocalOnboardingStateForConfig(params.configPath, params.config)?.status === "completed")
  ) {
    return false;
  }
  const hasExistingSetup =
    Object.keys(params.config.auth?.profiles ?? {}).length > 0 ||
    Object.keys(params.config.models?.providers ?? {}).length > 0 ||
    Object.keys(params.config.channels ?? {}).length > 0 ||
    Object.keys(params.config.plugins?.entries ?? {}).length > 0 ||
    Object.keys(params.config.plugins?.installs ?? {}).length > 0 ||
    (params.config.agents?.list?.length ?? 0) > 0;
  return !hasExistingSetup;
}

export function resolveSetupNativeSessionCatalogPreference(params: {
  consentRequired: boolean;
  requested?: boolean;
}): boolean | undefined {
  return params.consentRequired ? (params.requested ?? false) : undefined;
}

function supportsNativeSessionCatalog(plugin: PluginMetadataSnapshot["plugins"][number]): boolean {
  const properties = isRecord(plugin.configSchema?.properties)
    ? plugin.configSchema.properties
    : undefined;
  const sessionCatalog = isRecord(properties?.sessionCatalog)
    ? properties.sessionCatalog
    : undefined;
  const sessionProperties = isRecord(sessionCatalog?.properties)
    ? sessionCatalog.properties
    : undefined;
  const enabled = isRecord(sessionProperties?.enabled) ? sessionProperties.enabled : undefined;
  return enabled?.type === "boolean";
}

function nativeSessionCatalogLabel(plugin: PluginMetadataSnapshot["plugins"][number]): string {
  const hint = plugin.configUiHints?.["sessionCatalog.enabled"]?.label?.trim();
  const conciseHint = hint
    ?.replace(/^Discover\s+/u, "")
    .replace(/\s+Sessions?$/u, "")
    .replace(/\s+Session Catalog$/u, "");
  return conciseHint || plugin.name?.trim() || plugin.id;
}

export function listSetupNativeSessionCatalogs(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): SetupNativeSessionCatalogOption[] {
  const snapshot =
    params.metadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: process.env,
    });
  return snapshot.plugins
    .filter(supportsNativeSessionCatalog)
    .map((plugin) => {
      const hint = plugin.configUiHints?.["sessionCatalog.enabled"];
      return {
        pluginId: plugin.id,
        label: nativeSessionCatalogLabel(plugin),
        ...(hint?.help?.trim() ? { detail: hint.help.trim() } : {}),
      };
    })
    .toSorted(
      (a, b) => a.label.localeCompare(b.label, "en") || a.pluginId.localeCompare(b.pluginId, "en"),
    );
}

export function applySetupNativeSessionCatalogPreference(params: {
  config: OpenClawConfig;
  enabled: boolean;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): OpenClawConfig {
  const options = listSetupNativeSessionCatalogs(params);
  if (options.length === 0) {
    return params.config;
  }
  const entries = { ...params.config.plugins?.entries };
  for (const option of options) {
    const entry = entries[option.pluginId] ?? {};
    const config = isRecord(entry.config) ? entry.config : {};
    const sessionCatalog = isRecord(config.sessionCatalog) ? config.sessionCatalog : {};
    entries[option.pluginId] = {
      ...entry,
      config: {
        ...config,
        sessionCatalog: { ...sessionCatalog, enabled: params.enabled },
      },
    };
  }
  return {
    ...params.config,
    plugins: { ...params.config.plugins, entries },
  };
}
