import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { enablePluginInConfig } from "./enable.js";
import type { PluginPackageInstall } from "./manifest.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
  type OfficialExternalWebSearchProvider,
} from "./official-external-plugin-catalog.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

export type WebSearchInstallCatalogEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
  provider: PluginWebSearchProviderEntry;
  trustedSourceLinkedOfficialInstall?: boolean;
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(normalizeString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function normalizeOnboardingScopes(
  value: OfficialExternalWebSearchProvider["onboardingScopes"],
): readonly "text-inference"[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const scopes = value.filter((entry): entry is "text-inference" => entry === "text-inference");
  return scopes.length > 0 ? scopes : undefined;
}

function pathSegments(path: string): string[] {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function getConfigPath(config: OpenClawConfig | undefined, path: string): unknown {
  let current: unknown = config;
  for (const segment of pathSegments(path)) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setConfigPath(target: OpenClawConfig, path: string, value: unknown): void {
  const segments = pathSegments(path);
  let current: Record<string, unknown> = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf) {
    current[leaf] = value;
  }
}

function buildProviderEntry(params: {
  pluginId: string;
  provider: OfficialExternalWebSearchProvider;
}): PluginWebSearchProviderEntry | null {
  const providerId = normalizeString(params.provider.id);
  const label = normalizeString(params.provider.label);
  const hint = normalizeString(params.provider.hint);
  const credentialPath =
    normalizeString(params.provider.credentialPath) ??
    `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  const envVars = normalizeStringList(params.provider.envVars);
  const placeholder = normalizeString(params.provider.placeholder);
  const signupUrl = normalizeString(params.provider.signupUrl);
  if (!providerId || !label || !hint || envVars.length === 0 || !placeholder || !signupUrl) {
    return null;
  }
  return {
    id: providerId,
    pluginId: params.pluginId,
    label,
    hint,
    envVars,
    placeholder,
    signupUrl,
    credentialPath,
    ...(normalizeOnboardingScopes(params.provider.onboardingScopes)
      ? { onboardingScopes: normalizeOnboardingScopes(params.provider.onboardingScopes) }
      : {}),
    ...(params.provider.requiresCredential === false ? { requiresCredential: false } : {}),
    ...(normalizeString(params.provider.credentialLabel)
      ? { credentialLabel: normalizeString(params.provider.credentialLabel) }
      : {}),
    ...(normalizeString(params.provider.docsUrl)
      ? { docsUrl: normalizeString(params.provider.docsUrl) }
      : {}),
    ...(typeof params.provider.autoDetectOrder === "number"
      ? { autoDetectOrder: params.provider.autoDetectOrder }
      : {}),
    getCredentialValue: (searchConfig?: Record<string, unknown>) => searchConfig?.apiKey,
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => {
      searchConfigTarget.apiKey = value;
    },
    getConfiguredCredentialValue: (config?: OpenClawConfig) =>
      getConfigPath(config, credentialPath),
    setConfiguredCredentialValue: (configTarget: OpenClawConfig, value: unknown) => {
      setConfigPath(configTarget, credentialPath, value);
    },
    applySelectionConfig: (config: OpenClawConfig) =>
      enablePluginInConfig(config, params.pluginId).config,
    createTool: () => null,
  };
}

export function resolveWebSearchInstallCatalogEntries(): WebSearchInstallCatalogEntry[] {
  const entries: WebSearchInstallCatalogEntry[] = [];
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const pluginId = normalizeString(manifest?.plugin?.id);
    const install = resolveOfficialExternalPluginInstall(entry);
    if (!manifest || !pluginId || !install) {
      continue;
    }
    for (const provider of manifest.webSearchProviders ?? []) {
      const providerEntry = buildProviderEntry({ pluginId, provider });
      if (!providerEntry) {
        continue;
      }
      entries.push({
        pluginId,
        label: resolveOfficialExternalPluginLabel(entry),
        install,
        provider: providerEntry,
        trustedSourceLinkedOfficialInstall: true,
      });
    }
  }
  return entries.toSorted(
    (left, right) =>
      left.provider.label.localeCompare(right.provider.label) ||
      left.provider.id.localeCompare(right.provider.id),
  );
}

export function resolveWebSearchInstallCatalogEntry(params: {
  providerId?: string;
  pluginId?: string;
}): WebSearchInstallCatalogEntry | undefined {
  const providerId = normalizeString(params.providerId);
  const pluginId = normalizeString(params.pluginId);
  return resolveWebSearchInstallCatalogEntries().find(
    (entry) =>
      (!providerId || entry.provider.id === providerId) &&
      (!pluginId || entry.pluginId === pluginId),
  );
}
