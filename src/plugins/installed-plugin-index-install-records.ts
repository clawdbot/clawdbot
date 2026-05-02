import type { PluginInstallRecord } from "../config/types.plugins.js";
import type {
  InstalledPluginIndex,
  InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";

function setInstallStringField<Key extends keyof Omit<InstalledPluginInstallRecordInfo, "source">>(
  target: InstalledPluginInstallRecordInfo,
  key: Key,
  value: PluginInstallRecord[Key],
): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (normalized) {
    target[key] = normalized as InstalledPluginInstallRecordInfo[Key];
  }
}

function setInstallNumberField<Key extends keyof Omit<InstalledPluginInstallRecordInfo, "source">>(
  target: InstalledPluginInstallRecordInfo,
  key: Key,
  value: PluginInstallRecord[Key],
): void {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    target[key] = value as InstalledPluginInstallRecordInfo[Key];
  }
}

function normalizeInstallRecord(
  record: PluginInstallRecord | undefined,
): InstalledPluginInstallRecordInfo | undefined {
  if (!record) {
    return undefined;
  }
  const normalized: InstalledPluginInstallRecordInfo = {
    source: record.source,
  };
  setInstallStringField(normalized, "spec", record.spec);
  setInstallStringField(normalized, "sourcePath", record.sourcePath);
  setInstallStringField(normalized, "installPath", record.installPath);
  setInstallStringField(normalized, "version", record.version);
  setInstallStringField(normalized, "resolvedName", record.resolvedName);
  setInstallStringField(normalized, "resolvedVersion", record.resolvedVersion);
  setInstallStringField(normalized, "resolvedSpec", record.resolvedSpec);
  setInstallStringField(normalized, "integrity", record.integrity);
  setInstallStringField(normalized, "shasum", record.shasum);
  setInstallStringField(normalized, "resolvedAt", record.resolvedAt);
  setInstallStringField(normalized, "installedAt", record.installedAt);
  setInstallStringField(normalized, "clawhubUrl", record.clawhubUrl);
  setInstallStringField(normalized, "clawhubPackage", record.clawhubPackage);
  setInstallStringField(normalized, "clawhubFamily", record.clawhubFamily);
  setInstallStringField(normalized, "clawhubChannel", record.clawhubChannel);
  setInstallStringField(normalized, "clawpackSha256", record.clawpackSha256);
  setInstallNumberField(normalized, "clawpackSpecVersion", record.clawpackSpecVersion);
  setInstallStringField(normalized, "clawpackManifestSha256", record.clawpackManifestSha256);
  setInstallNumberField(normalized, "clawpackSize", record.clawpackSize);
  setInstallStringField(normalized, "gitUrl", record.gitUrl);
  setInstallStringField(normalized, "gitRef", record.gitRef);
  setInstallStringField(normalized, "gitCommit", record.gitCommit);
  setInstallStringField(normalized, "marketplaceName", record.marketplaceName);
  setInstallStringField(normalized, "marketplaceSource", record.marketplaceSource);
  setInstallStringField(normalized, "marketplacePlugin", record.marketplacePlugin);
  return normalized;
}

function restoreInstallRecord(
  record: InstalledPluginInstallRecordInfo | undefined,
): PluginInstallRecord | undefined {
  if (!record?.source) {
    return undefined;
  }
  return structuredClone(record) as PluginInstallRecord;
}

export function normalizeInstallRecordMap(
  records: Record<string, PluginInstallRecord> | undefined,
): Record<string, InstalledPluginInstallRecordInfo> {
  const normalized: Record<string, InstalledPluginInstallRecordInfo> = {};
  for (const [pluginId, record] of Object.entries(records ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const installRecord = normalizeInstallRecord(record);
    if (installRecord) {
      normalized[pluginId] = installRecord;
    }
  }
  return normalized;
}

function restoreInstallRecordMap(
  records: Readonly<Record<string, InstalledPluginInstallRecordInfo>> | undefined,
): Record<string, PluginInstallRecord> {
  const restored: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(records ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const installRecord = restoreInstallRecord(record);
    if (installRecord) {
      restored[pluginId] = installRecord;
    }
  }
  return restored;
}

export function extractPluginInstallRecordsFromInstalledPluginIndex(
  index: InstalledPluginIndex | null | undefined,
): Record<string, PluginInstallRecord> {
  if (index && Object.prototype.hasOwnProperty.call(index, "installRecords")) {
    return restoreInstallRecordMap(index.installRecords);
  }
  const records: Record<string, PluginInstallRecord> = {};
  for (const plugin of index?.plugins ?? []) {
    const record = restoreInstallRecord(plugin.installRecord);
    if (record) {
      records[plugin.pluginId] = record;
    }
  }
  return records;
}
