import type { PluginInstallRecord } from "../config/types.plugins.js";
import { readJsonFile, readJsonFileSync } from "../infra/json-files.js";
import {
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneInstallRecords(
  records: Record<string, PluginInstallRecord> | undefined,
): Record<string, PluginInstallRecord> {
  return structuredClone(records ?? {});
}

function readRecordMap(value: unknown): Record<string, PluginInstallRecord> | null {
  if (!isRecord(value)) {
    return null;
  }
  const records: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (isRecord(record) && typeof record.source === "string") {
      records[pluginId] = structuredClone(record) as PluginInstallRecord;
    }
  }
  return records;
}

export function extractPluginInstallRecordsFromPersistedInstalledPluginIndex(
  index: unknown,
): Record<string, PluginInstallRecord> | null {
  if (!isRecord(index) || !Array.isArray(index.plugins)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(index, "installRecords")) {
    return readRecordMap(index.installRecords) ?? {};
  }
  const records: Record<string, PluginInstallRecord> = {};
  for (const entry of index.plugins) {
    if (!isRecord(entry) || typeof entry.pluginId !== "string" || !isRecord(entry.installRecord)) {
      continue;
    }
    records[entry.pluginId] = structuredClone(entry.installRecord) as PluginInstallRecord;
  }
  return records;
}

export async function readPersistedInstalledPluginIndexInstallRecords(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<Record<string, PluginInstallRecord> | null> {
  const parsed = await readJsonFile<unknown>(resolveInstalledPluginIndexStorePath(options));
  return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(parsed);
}

export function readPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> | null {
  const parsed = readJsonFileSync(resolveInstalledPluginIndexStorePath(options));
  return extractPluginInstallRecordsFromPersistedInstalledPluginIndex(parsed);
}

export async function loadInstalledPluginIndexInstallRecords(
  params: InstalledPluginIndexStoreOptions = {},
): Promise<Record<string, PluginInstallRecord>> {
  return cloneInstallRecords((await readPersistedInstalledPluginIndexInstallRecords(params)) ?? {});
}

export function loadInstalledPluginIndexInstallRecordsSync(
  params: InstalledPluginIndexStoreOptions = {},
): Record<string, PluginInstallRecord> {
  return cloneInstallRecords(readPersistedInstalledPluginIndexInstallRecordsSync(params) ?? {});
}
