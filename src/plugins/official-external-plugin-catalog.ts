import officialExternalChannelCatalog from "../../scripts/lib/official-external-channel-catalog.json" with { type: "json" };
import officialExternalPluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import type { PluginPackageInstall } from "./manifest.js";

type ManifestKey = typeof MANIFEST_KEY;

export type OfficialExternalProviderAuthChoice = {
  method?: string;
  choiceId?: string;
  choiceLabel?: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: readonly ("text-inference" | "image-generation")[];
};

export type OfficialExternalProviderCatalogProvider = {
  id?: string;
  name?: string;
  docs?: string;
  categories?: readonly string[];
  authChoices?: readonly OfficialExternalProviderAuthChoice[];
};

export type OfficialExternalWebSearchProvider = {
  id?: string;
  label?: string;
  hint?: string;
  onboardingScopes?: readonly "text-inference"[];
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars?: readonly string[];
  placeholder?: string;
  signupUrl?: string;
  docsUrl?: string;
  credentialPath?: string;
  autoDetectOrder?: number;
};

export type OfficialExternalPluginCatalogManifest = {
  plugin?: {
    id?: string;
    label?: string;
  };
  channel?: {
    id?: string;
    label?: string;
  };
  providers?: readonly OfficialExternalProviderCatalogProvider[];
  webSearchProviders?: readonly OfficialExternalWebSearchProvider[];
  install?: PluginPackageInstall;
};

export type OfficialExternalPluginCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
  source?: string;
  kind?: string;
} & Partial<Record<ManifestKey, OfficialExternalPluginCatalogManifest>>;

const OFFICIAL_CATALOG_SOURCES = [
  officialExternalChannelCatalog,
  officialExternalProviderCatalog,
  officialExternalPluginCatalog,
] as const;

function parseCatalogEntries(raw: unknown): OfficialExternalPluginCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
}

function normalizeDefaultChoice(value: unknown): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "clawhub" || value === "npm" || value === "local" ? value : undefined;
}

export function getOfficialExternalPluginCatalogManifest(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogManifest | undefined {
  const manifest = entry[MANIFEST_KEY];
  return isRecord(manifest) ? manifest : undefined;
}

export function resolveOfficialExternalPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialExternalPluginLookupIds(
  entry: OfficialExternalPluginCatalogEntry,
): string[] {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return [
    normalizeOptionalString(manifest?.plugin?.id),
    normalizeOptionalString(manifest?.channel?.id),
    normalizeOptionalString(manifest?.providers?.[0]?.id),
  ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
}

export function resolveOfficialExternalPluginLabel(
  entry: OfficialExternalPluginCatalogEntry,
): string {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.label) ??
    normalizeOptionalString(manifest?.channel?.label) ??
    normalizeOptionalString(manifest?.providers?.[0]?.name) ??
    normalizeOptionalString(entry.name) ??
    resolveOfficialExternalPluginId(entry) ??
    "plugin"
  );
}

export function resolveOfficialExternalPluginInstall(
  entry: OfficialExternalPluginCatalogEntry,
): PluginPackageInstall | null {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const install = manifest?.install;
  const clawhubSpec = normalizeOptionalString(install?.clawhubSpec);
  const npmSpec = normalizeOptionalString(install?.npmSpec) ?? normalizeOptionalString(entry.name);
  const localPath = normalizeOptionalString(install?.localPath);
  if (!clawhubSpec && !npmSpec && !localPath) {
    return null;
  }
  const defaultChoice =
    normalizeDefaultChoice(install?.defaultChoice) ??
    (npmSpec ? "npm" : clawhubSpec ? "clawhub" : localPath ? "local" : undefined);
  return {
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(install?.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
    ...(install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    ...(install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
  };
}

export function listOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  const entries = OFFICIAL_CATALOG_SOURCES.flatMap((source) => parseCatalogEntries(source));
  const resolved = new Map<string, OfficialExternalPluginCatalogEntry>();
  for (const entry of entries) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const key = pluginId ? `${entry.kind ?? "plugin"}:${pluginId}` : (entry.name ?? "");
    if (key && !resolved.has(key)) {
      resolved.set(key, entry);
    }
  }
  return [...resolved.values()];
}

export function listOfficialExternalChannelCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter((entry) =>
    Boolean(getOfficialExternalPluginCatalogManifest(entry)?.channel),
  );
}

export function listOfficialExternalProviderCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter(
    (entry) => (getOfficialExternalPluginCatalogManifest(entry)?.providers?.length ?? 0) > 0,
  );
}

export function getOfficialExternalPluginCatalogEntry(
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  const normalized = pluginId.trim();
  if (!normalized) {
    return undefined;
  }
  return listOfficialExternalPluginCatalogEntries().find((entry) =>
    resolveOfficialExternalPluginLookupIds(entry).includes(normalized),
  );
}
