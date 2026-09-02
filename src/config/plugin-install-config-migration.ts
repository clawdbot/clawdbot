// Migrates plugin install config entries into canonical config shape.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "./plugin-install-record-map.js";
import type { PluginInstallRecord } from "./types.plugins.js";

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
  const state = inspectShippedPluginInstallConfigRecords(config);
  return state.status === "valid" ? state.records : {};
}

export function inspectShippedPluginInstallConfigRecords(
  config: unknown,
): PluginInstallRecordMapState {
  if (!isRecord(config) || !isRecord(config.plugins)) {
    return { status: "missing" };
  }
  return inspectPluginInstallRecordMap(config.plugins.installs);
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
