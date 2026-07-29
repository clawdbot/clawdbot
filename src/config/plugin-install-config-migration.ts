// Migrates plugin install config entries into canonical config shape.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { PluginInstallRecord } from "./types.plugins.js";
import { PluginInstallRecordShape } from "./zod-schema.installs.js";

const PluginInstallRecordsSchema = z.record(
  z.string(),
  z.object(PluginInstallRecordShape).passthrough(),
);

function pruneEmptyPluginsObject(plugins: Record<string, unknown>): unknown {
  const { installs: _installs, ...rest } = plugins;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * Reads legacy shipped `plugins.installs` records for migration into the plugin index.
 *
 * Invalid install maps are ignored so config loading can keep using the stripped
 * runtime config while doctor/write paths decide how to report or recover.
 */
export function extractShippedPluginInstallConfigRecords(
  config: unknown,
): Record<string, PluginInstallRecord> {
  if (!isRecord(config) || !isRecord(config.plugins)) {
    return {};
  }
  const parsed = PluginInstallRecordsSchema.safeParse(config.plugins.installs);
  return parsed.success
    ? (structuredClone(parsed.data) as Record<string, PluginInstallRecord>)
    : {};
}

/** Removes legacy shipped `plugins.installs` without mutating the original config object. */
export function stripShippedPluginInstallConfigRecords(config: unknown): unknown {
  if (!isRecord(config) || !isRecord(config.plugins) || !("installs" in config.plugins)) {
    return config;
  }
  const plugins = pruneEmptyPluginsObject(config.plugins);
  const { plugins: _plugins, ...rest } = config;
  return plugins === undefined ? rest : { ...rest, plugins };
}
