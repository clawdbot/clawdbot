import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "../config/plugin-install-record-map.js";
import { readPersistedInstalledPluginIndexRowSync } from "./installed-plugin-index-row.js";
import {
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import type { PersistedInstalledPluginIndexCacheEntry } from "./plugin-cache-management.js";
import { getPluginCache } from "./plugin-cache.js";

function readPersistedInstalledPluginIndexState(
  options: InstalledPluginIndexStoreOptions,
): PersistedInstalledPluginIndexCacheEntry["state"] {
  // The row reader owns unreadable-state failures; never cache them as missing or invalid.
  const row = readPersistedInstalledPluginIndexRowSync(options);
  return row ? { status: "present", value: safeParseJson(row.value_json) } : { status: "missing" };
}

/** Share the SQLite row while validating install records independently from index metadata. */
export function getPersistedInstalledPluginIndexCacheEntry(
  options: InstalledPluginIndexStoreOptions,
): PersistedInstalledPluginIndexCacheEntry {
  const cache = getPluginCache().persistedInstalledIndex;
  const key = path.resolve(resolveInstalledPluginIndexStorePath(options));
  let entry = cache.get(key);
  if (!entry) {
    entry = { state: readPersistedInstalledPluginIndexState(options) };
    cache.set(key, entry);
  }
  return entry;
}

export function inspectPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): PluginInstallRecordMapState {
  const entry = getPersistedInstalledPluginIndexCacheEntry(options);
  if (!entry.records) {
    const state = entry.state;
    // The full index can be invalid while its canonical install ledger remains usable.
    const value = state.status === "present" ? state.value : undefined;
    const records = (value as { index?: { installRecords?: unknown } } | undefined)?.index
      ?.installRecords;
    entry.records =
      state.status === "missing"
        ? { status: "missing" }
        : records === undefined
          ? { status: "invalid" }
          : inspectPluginInstallRecordMap(records);
  }
  return entry.records;
}
