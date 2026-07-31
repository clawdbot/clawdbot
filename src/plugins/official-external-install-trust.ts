// Resolves trusted official external plugin installs from the OpenClaw-owned catalog.
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

type OfficialExternalPluginLookup = (pluginId: string) =>
  | {
      pluginId: string;
      npmSpec?: string;
      expectedIntegrity?: string;
    }
  | undefined;

type OfficialExternalPackageLookup = (packageName: string) =>
  | {
      pluginId: string;
      npmSpec?: string;
      expectedIntegrity?: string;
    }
  | undefined;

function isBareNpmPackageName(spec: string): boolean {
  const trimmed = spec.trim();
  return /^[a-z0-9][a-z0-9-._~]*$/.test(trimmed);
}

function resolveCatalogInstall(value: string, lookup: "package" | "plugin") {
  const entry =
    lookup === "package"
      ? getOfficialExternalPluginCatalogEntryForPackage(value)
      : getOfficialExternalPluginCatalogEntry(value);
  if (!entry) {
    return undefined;
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  if (!pluginId) {
    return undefined;
  }
  const install = resolveOfficialExternalPluginInstall(entry);
  return {
    pluginId,
    ...(install?.npmSpec ? { npmSpec: install.npmSpec } : {}),
    ...(install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
  };
}

function resolveOfficialExternalInstallPlanBeforeNpm(params: {
  rawSpec: string;
  findOfficialExternalPlugin: OfficialExternalPluginLookup;
}): { pluginId: string; npmSpec: string; expectedIntegrity?: string } | null {
  if (!isBareNpmPackageName(params.rawSpec)) {
    return null;
  }
  const entry = params.findOfficialExternalPlugin(params.rawSpec);
  const npmSpec = entry?.npmSpec?.trim();
  if (!entry?.pluginId || !npmSpec) {
    return null;
  }
  return {
    pluginId: entry.pluginId,
    npmSpec,
    ...(entry.expectedIntegrity ? { expectedIntegrity: entry.expectedIntegrity } : {}),
  };
}

function resolveOfficialExternalNpmPackageTrust(params: {
  npmSpec: string;
  findOfficialExternalPackage: OfficialExternalPackageLookup;
}): {
  pluginId: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall: true;
} | null {
  const parsed = parseRegistryNpmSpec(params.npmSpec);
  if (!parsed) {
    return null;
  }
  const entry = params.findOfficialExternalPackage(parsed.name);
  if (!entry?.pluginId) {
    return null;
  }
  const catalogSpec = entry.npmSpec?.trim();
  const catalogPackageName = catalogSpec ? parseRegistryNpmSpec(catalogSpec)?.name : undefined;
  if (catalogPackageName && catalogPackageName !== parsed.name) {
    return null;
  }
  return {
    pluginId: entry.pluginId,
    ...(entry.expectedIntegrity && catalogSpec === params.npmSpec.trim()
      ? { expectedIntegrity: entry.expectedIntegrity }
      : {}),
    trustedSourceLinkedOfficialInstall: true,
  };
}

export function resolveCatalogOfficialExternalInstallPlan(rawSpec: string) {
  return resolveOfficialExternalInstallPlanBeforeNpm({
    rawSpec,
    findOfficialExternalPlugin: (pluginId) => resolveCatalogInstall(pluginId, "plugin"),
  });
}

export function resolveCatalogOfficialExternalNpmPackageTrust(npmSpec: string) {
  return resolveOfficialExternalNpmPackageTrust({
    npmSpec,
    findOfficialExternalPackage: (packageName) => resolveCatalogInstall(packageName, "package"),
  });
}
