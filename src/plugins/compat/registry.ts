// Plugin compatibility registry exposes known plugin compatibility metadata to doctor/update flows.
import { PLUGIN_COMPAT_RECORDS } from "./registry-records.js";
import type { PluginCompatRecord } from "./types.js";

export type PluginCompatCode = (typeof PLUGIN_COMPAT_RECORDS)[number]["code"];
type KnownPluginCompatRecord = PluginCompatRecord<PluginCompatCode>;

const pluginCompatRecordByCode = new Map<PluginCompatCode, KnownPluginCompatRecord>(
  PLUGIN_COMPAT_RECORDS.map((record) => [record.code, record]),
);

export function listPluginCompatRecords(): readonly KnownPluginCompatRecord[] {
  return PLUGIN_COMPAT_RECORDS;
}

export function getPluginCompatRecord(code: PluginCompatCode): KnownPluginCompatRecord {
  const record = pluginCompatRecordByCode.get(code);
  if (!record) {
    throw new Error(`Unknown plugin compatibility code: ${code}`);
  }
  return record;
}
