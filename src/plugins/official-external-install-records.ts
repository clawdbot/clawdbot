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

function resolveExactNpmPackageName(value: string): string | undefined {
  const packageName = resolveNpmSpecPackageName(value);
  return packageName && value.trim() === packageName ? packageName : undefined;
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

function resolveRecordedClawHubPackageNames(record: PluginInstallRecord): string[] | undefined {
  // Source switches can leave legacy resolution fields in durable records. Treat every
  // populated identity as corroborating evidence so one conflicting field fails closed.
  const packageNames: string[] = [];
  if (record.clawhubPackage !== undefined) {
    const packageName = resolveExactNpmPackageName(record.clawhubPackage);
    if (!packageName) {
      return undefined;
    }
    packageNames.push(packageName);
  }
  if (record.spec !== undefined) {
    const packageName = resolveClawHubSpecPackageName(record.spec);
    if (!packageName) {
      return undefined;
    }
    packageNames.push(packageName);
  }
  if (record.resolvedSpec !== undefined) {
    const packageName =
      resolveClawHubSpecPackageName(record.resolvedSpec) ??
      resolveNpmSpecPackageName(record.resolvedSpec);
    if (!packageName) {
      return undefined;
    }
    packageNames.push(packageName);
  }
  if (record.resolvedName !== undefined) {
    const packageName = resolveExactNpmPackageName(record.resolvedName);
    if (!packageName) {
      return undefined;
    }
    packageNames.push(packageName);
  }
  return packageNames;
}

function isOfficialClawHubInstallRecord(record: PluginInstallRecord): boolean {
  if (record.source !== "clawhub" || record.clawhubChannel !== "official") {
    return false;
  }
  return (record.clawhubUrl ?? "").trim().replace(/\/+$/, "") === "https://clawhub.ai";
}

function hasTrustedClawHubSourceAuthority(
  record: PluginInstallRecord,
  officialClawHubSpec: string | undefined,
): boolean {
  const hasAuthorityMetadata =
    record.clawhubUrl !== undefined || record.clawhubChannel !== undefined;
  if (hasAuthorityMetadata) {
    return isOfficialClawHubInstallRecord(record);
  }
  // Older official installs persisted only their catalog-backed ClawHub spec.
  // Preserve that shipped shape, but do not let package-only records claim it.
  return Boolean(
    officialClawHubSpec &&
    record.spec &&
    resolveClawHubSpecPackageName(record.spec) ===
      resolveClawHubSpecPackageName(officialClawHubSpec),
  );
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
  if (!officialClawHubSpec && !officialNpmSpec) {
    return undefined;
  }
  const officialNames = resolveOfficialPackageNames({
    entry,
    npmSpec: officialNpmSpec,
    clawhubSpec: officialClawHubSpec,
  });
  if (officialNames.length === 0) {
    return undefined;
  }
  // resolvedSpec can survive a source switch, so it may corroborate but cannot establish
  // ClawHub provenance without either the requested spec or resolved package identity.
  if (params.record.clawhubPackage === undefined && params.record.spec === undefined) {
    return undefined;
  }
  const recordedPackageNames = resolveRecordedClawHubPackageNames(params.record);
  if (
    !hasTrustedClawHubSourceAuthority(params.record, officialClawHubSpec) ||
    !recordedPackageNames ||
    recordedPackageNames.length === 0 ||
    !recordedPackageNames.every((name) => officialNames.includes(name))
  ) {
    return undefined;
  }
  return {
    ...(officialClawHubSpec ? { clawhubSpec: officialClawHubSpec } : {}),
    ...(officialNpmSpec ? { npmSpec: officialNpmSpec } : {}),
  };
}
