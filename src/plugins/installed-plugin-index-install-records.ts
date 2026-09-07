/** Normalizes durable plugin install records into installed-index metadata and back. */
import {
  createPluginInstallRecordMap,
  parsePluginInstallRecordMap,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { getInstalledPluginIndexFacts } from "./installed-plugin-index-facts.js";
import type {
  InstalledPluginIndex,
  InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";

/** Normalizes raw plugin install records into index-safe install record metadata. */
export function normalizeInstallRecordMap(
  records: Record<string, PluginInstallRecord> | undefined,
): Record<string, InstalledPluginInstallRecordInfo> {
  const normalized = parsePluginInstallRecordMap(records ?? {});
  if (!normalized) {
    throw new Error("Invalid plugin install record map");
  }
  return normalized;
}

function restoreInstallRecordMap(
  records: Readonly<Record<string, InstalledPluginInstallRecordInfo>> | undefined,
): Record<string, PluginInstallRecord> {
  const restored = parsePluginInstallRecordMap(records ?? {});
  if (!restored) {
    throw new Error("Invalid persisted plugin install record map");
  }
  return restored;
}

/** Extracts raw plugin install records from either current or legacy installed-index shapes. */
export function extractPluginInstallRecordsFromInstalledPluginIndex(
  index: InstalledPluginIndex | null | undefined,
): Record<string, PluginInstallRecord> {
  const facts = index ? getInstalledPluginIndexFacts(index) : undefined;
  if (!facts) {
    return restoreInstallRecordMap(indexInstallRecords(index));
  }
  const parsed = (facts.installRecords ??= restoreInstallRecordMap(indexInstallRecords(index)));
  const records = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const [pluginId, record] of Object.entries(parsed)) {
    // Match schema parsing's copies of known structured fields; passthrough fields stay intact.
    setPluginInstallRecordMapEntry(records, pluginId, {
      ...record,
      ...(record.clawhubTrustReasons
        ? { clawhubTrustReasons: [...record.clawhubTrustReasons] }
        : {}),
      ...(record.acceptedSurface
        ? { acceptedSurface: structuredClone(record.acceptedSurface) }
        : {}),
    });
  }
  return records;
}

function indexInstallRecords(index: InstalledPluginIndex | null | undefined) {
  if (index && Object.hasOwn(index, "installRecords")) {
    return index.installRecords;
  }
  const records = createPluginInstallRecordMap<PluginInstallRecord>();
  for (const plugin of index?.plugins ?? []) {
    if (plugin.installRecord) {
      setPluginInstallRecordMapEntry(records, plugin.pluginId, plugin.installRecord);
    }
  }
  return records;
}
