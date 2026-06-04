// Defines official external install records for plugins.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginInstall,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";

function resolveNpmSpecPackageName(spec: string | undefined): string | undefined {
  return spec ? parseRegistryNpmSpec(spec)?.name : undefined;
}

function resolveClawHubSpecPackageName(spec: string | undefined): string | undefined {
  return spec ? parseClawHubPluginSpec(spec)?.name : undefined;
}

function resolveOfficialPackageNames(params: {
  entry: OfficialExternalPluginCatalogEntry;
  npmSpec?: string;
  clawhubSpec?: string;
}): string[] {
  return [
    resolveClawHubSpecPackageName(params.clawhubSpec),
    resolveNpmSpecPackageName(params.npmSpec),
    params.entry.name,
  ].filter((value): value is string => Boolean(value));
}

function resolveRecordedClawHubPackageNames(record: PluginInstallRecord): string[] {
  return [record.clawhubPackage, resolveClawHubSpecPackageName(record.spec)].filter(
    (value): value is string => Boolean(value),
  );
}

function isOfficialClawHubInstallRecord(record: PluginInstallRecord): boolean {
  if (record.source !== "clawhub" || record.clawhubChannel !== "official") {
    return false;
  }
  return (record.clawhubUrl ?? "").replace(/\/+$/, "") === "https://clawhub.ai";
}

/** Resolves the official npm spec when an install record matches the trusted catalog package. */
export function resolveTrustedSourceLinkedOfficialNpmSpec(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): string | undefined {
  if (params.record.source !== "npm") {
    return undefined;
  }
  const entry = getOfficialExternalPluginCatalogEntry(params.pluginId);
  if (!entry) {
    return undefined;
  }
  const officialSpec = resolveOfficialExternalPluginInstall(entry)?.npmSpec;
  const officialPackageName = resolveNpmSpecPackageName(officialSpec);
  if (!officialSpec || !officialPackageName) {
    return undefined;
  }
  const recordedPackageNames = [
    params.record.resolvedName,
    resolveNpmSpecPackageName(params.record.spec),
    resolveNpmSpecPackageName(params.record.resolvedSpec),
  ].filter((value): value is string => Boolean(value));
  return recordedPackageNames.includes(officialPackageName) ? officialSpec : undefined;
}

/** Resolves the official ClawHub spec when a trusted-source install record matches. */
export function resolveTrustedSourceLinkedOfficialClawHubSpec(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): string | undefined {
  return resolveTrustedSourceLinkedOfficialClawHubInstall(params)?.clawhubSpec;
}

/** Resolves official ClawHub/npm specs linked to a trusted-source install record. */
export function resolveTrustedSourceLinkedOfficialClawHubInstall(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): { clawhubSpec?: string; npmSpec?: string } | undefined {
  if (params.record.source !== "clawhub") {
    return undefined;
  }
  const entry = getOfficialExternalPluginCatalogEntry(params.pluginId);
  if (!entry) {
    return undefined;
  }
  const install = resolveOfficialExternalPluginInstall(entry);
  const officialClawHubSpec = install?.clawhubSpec;
  const officialNpmSpec = install?.npmSpec;
  const officialNames = resolveOfficialPackageNames({
    entry,
    npmSpec: officialNpmSpec,
    clawhubSpec: officialClawHubSpec,
  });
  if (officialNames.length === 0) {
    return undefined;
  }
  const recordedPackageNames = resolveRecordedClawHubPackageNames(params.record);
  const matchesOfficialPackage = recordedPackageNames.some((name) => officialNames.includes(name));
  if (!matchesOfficialPackage) {
    return undefined;
  }
  if (officialClawHubSpec || isOfficialClawHubInstallRecord(params.record)) {
    return {
      ...(officialClawHubSpec ? { clawhubSpec: officialClawHubSpec } : {}),
      ...(officialNpmSpec ? { npmSpec: officialNpmSpec } : {}),
    };
  }
  return undefined;
}
