// Defines official external install records for plugins.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLegacyIds,
  resolveOfficialExternalPluginLegacyNpmPackageNames,
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

function resolveUnanimousRecordedNpmPackageName(record: PluginInstallRecord): string | undefined {
  if (record.source !== "npm") {
    return undefined;
  }
  const packageNames: string[] = [];
  const fields = [
    [record.spec, resolveNpmSpecPackageName],
    [record.resolvedName, resolveExactNpmPackageName],
    [record.resolvedSpec, resolveNpmSpecPackageName],
  ] as const;
  for (const [value, resolvePackageName] of fields) {
    if (value === undefined) {
      continue;
    }
    const packageName = resolvePackageName(value);
    if (!packageName) {
      return undefined;
    }
    packageNames.push(packageName);
  }
  return packageNames.length > 0 && new Set(packageNames).size === 1 ? packageNames[0] : undefined;
}

function hasTrustedOfficialNpmProvenance(record: PluginInstallRecord): boolean {
  return (
    record.source === "npm" && record.artifactKind === undefined && record.sourcePath === undefined
  );
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

/** Resolves one package identity from a current trusted official ClawHub install record. */
export function resolveTrustedOfficialClawHubPackageName(
  record: PluginInstallRecord,
): string | undefined {
  if (!isOfficialClawHubInstallRecord(record)) {
    return undefined;
  }
  const packageNames = resolveRecordedClawHubPackageNames(record);
  if (!packageNames || packageNames.length === 0 || new Set(packageNames).size !== 1) {
    return undefined;
  }
  return packageNames[0];
}

/** Binds official trust to the actual package and consistent recorded source identity. */
export function isTrustedOfficialPluginInstallRecord(params: {
  pluginId: string;
  packageName?: string;
  record: PluginInstallRecord;
}): boolean {
  const packageName = params.packageName?.trim();
  const entry = packageName
    ? getOfficialExternalPluginCatalogEntryForPackage(packageName)
    : undefined;
  if (
    !entry ||
    (resolveOfficialExternalPluginId(entry) !== params.pluginId &&
      !resolveOfficialExternalPluginLegacyIds(entry).includes(params.pluginId))
  ) {
    return false;
  }
  const install = resolveOfficialExternalPluginInstall(entry);
  const record = params.record;
  if (record.source === "npm") {
    // Local npm-pack archives also persist source="npm". Catalog identity alone
    // cannot turn a local artifact or conflicting source record into official trust.
    return (
      hasTrustedOfficialNpmProvenance(record) &&
      resolveNpmSpecPackageName(install?.npmSpec) === packageName &&
      resolveUnanimousRecordedNpmPackageName(record) === packageName &&
      (record.clawhubPackage === undefined ||
        resolveExactNpmPackageName(record.clawhubPackage) === packageName)
    );
  }
  return (
    Boolean(install?.clawhubSpec || install?.npmSpec) &&
    (record.clawhubPackage !== undefined || record.spec !== undefined) &&
    resolveTrustedOfficialClawHubPackageName(record) === packageName
  );
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

type TrustedSourceLinkedOfficialNpmInstall = {
  expectedIntegrity?: string;
  npmSpec: string;
  pluginId: string;
  replacementPluginId?: string;
  // Package-name cutovers must rewrite the install spec even without --all.
  replaceNpmPackage?: true;
};

function resolveOfficialNpmInstallIdentity(params: {
  requestPluginId: string;
  entry: OfficialExternalPluginCatalogEntry;
  expectedIntegrity?: string;
  npmSpec: string;
  replaceNpmPackage?: true;
}): TrustedSourceLinkedOfficialNpmInstall {
  const canonicalPluginId = resolveOfficialExternalPluginId(params.entry);
  const pluginId =
    canonicalPluginId && canonicalPluginId !== params.requestPluginId
      ? canonicalPluginId
      : params.requestPluginId;
  return {
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    npmSpec: params.npmSpec,
    pluginId,
    ...(pluginId !== params.requestPluginId ? { replacementPluginId: pluginId } : {}),
    ...(params.replaceNpmPackage ? { replaceNpmPackage: true as const } : {}),
  };
}

/** True when the expected id is a catalog lookup alias for the replacement plugin. */
export function isOfficialCatalogLookupPluginIdReplacement(params: {
  expectedPluginId: string;
  expectedReplacementPluginId: string;
}): boolean {
  if (params.expectedPluginId === params.expectedReplacementPluginId) {
    return false;
  }
  const entry = getOfficialExternalPluginCatalogEntry(params.expectedPluginId);
  return Boolean(
    entry && resolveOfficialExternalPluginId(entry) === params.expectedReplacementPluginId,
  );
}

/** True when a lookup alias can be dropped because the canonical record is trusted official. */
export function isTrustedOfficialCatalogLookupDuplicate(params: {
  pluginId: string;
  replacementPluginId: string;
  replacementRecord: PluginInstallRecord | undefined;
}): boolean {
  if (
    !params.replacementRecord ||
    !isOfficialCatalogLookupPluginIdReplacement({
      expectedPluginId: params.pluginId,
      expectedReplacementPluginId: params.replacementPluginId,
    })
  ) {
    return false;
  }
  const canonicalEntry = getOfficialExternalPluginCatalogEntry(params.replacementPluginId);
  const officialPackageName = resolveNpmSpecPackageName(
    canonicalEntry ? resolveOfficialExternalPluginInstall(canonicalEntry)?.npmSpec : undefined,
  );
  return Boolean(
    officialPackageName &&
    isTrustedOfficialPluginInstallRecord({
      pluginId: params.replacementPluginId,
      packageName: officialPackageName,
      record: params.replacementRecord,
    }),
  );
}

/** Resolves exact package-bound official npm identity and any declared id migration. */
export function resolveTrustedSourceLinkedOfficialNpmInstall(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): TrustedSourceLinkedOfficialNpmInstall | undefined {
  if (!hasTrustedOfficialNpmProvenance(params.record)) {
    return undefined;
  }
  const canonicalEntry = getOfficialExternalPluginCatalogEntry(params.pluginId);
  if (canonicalEntry) {
    const officialInstall = resolveOfficialExternalPluginInstall(canonicalEntry);
    const officialSpec = officialInstall?.npmSpec;
    const packageName = resolveNpmSpecPackageName(officialSpec);
    const recordedPackageNames = [
      params.record.resolvedName,
      resolveNpmSpecPackageName(params.record.spec),
      resolveNpmSpecPackageName(params.record.resolvedSpec),
    ].filter((value): value is string => Boolean(value));
    if (officialSpec && packageName && recordedPackageNames.includes(packageName)) {
      return resolveOfficialNpmInstallIdentity({
        requestPluginId: params.pluginId,
        entry: canonicalEntry,
        expectedIntegrity: officialInstall.expectedIntegrity,
        npmSpec: officialSpec,
      });
    }
    const recordedPackageName = resolveUnanimousRecordedNpmPackageName(params.record);
    if (
      officialSpec &&
      recordedPackageName &&
      resolveOfficialExternalPluginLegacyNpmPackageNames(canonicalEntry).includes(
        recordedPackageName,
      )
    ) {
      return resolveOfficialNpmInstallIdentity({
        requestPluginId: params.pluginId,
        entry: canonicalEntry,
        expectedIntegrity: officialInstall.expectedIntegrity,
        npmSpec: officialSpec,
        replaceNpmPackage: true,
      });
    }
  }

  // Replacing a legacy id is more sensitive than refreshing a canonical record:
  // every populated package identity must be valid and agree on the catalog package.
  const packageName = resolveUnanimousRecordedNpmPackageName(params.record);
  const entry = packageName
    ? getOfficialExternalPluginCatalogEntryForPackage(packageName)
    : undefined;
  if (!entry) {
    return undefined;
  }
  const officialInstall = resolveOfficialExternalPluginInstall(entry);
  const officialSpec = officialInstall?.npmSpec;
  const officialPackageName = resolveNpmSpecPackageName(officialSpec);
  const canonicalPluginId = resolveOfficialExternalPluginId(entry);
  if (
    !packageName ||
    !officialSpec ||
    officialPackageName !== packageName ||
    !canonicalPluginId ||
    params.pluginId === canonicalPluginId ||
    !resolveOfficialExternalPluginLegacyIds(entry).includes(params.pluginId)
  ) {
    return undefined;
  }
  return resolveOfficialNpmInstallIdentity({
    requestPluginId: params.pluginId,
    entry,
    expectedIntegrity: officialInstall.expectedIntegrity,
    npmSpec: officialSpec,
  });
}

/** Resolves the official npm spec when an install record matches the trusted catalog package. */
export function resolveTrustedSourceLinkedOfficialNpmSpec(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): string | undefined {
  return resolveTrustedSourceLinkedOfficialNpmInstall(params)?.npmSpec;
}

export function hasOfficialNpmIdReplacement(params: {
  pluginId: string;
  record?: PluginInstallRecord;
}): boolean {
  return (
    params.record !== undefined &&
    resolveTrustedSourceLinkedOfficialNpmInstall({
      pluginId: params.pluginId,
      record: params.record,
    })?.replacementPluginId !== undefined
  );
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
