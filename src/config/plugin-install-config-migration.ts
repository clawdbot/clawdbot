import { z } from "zod";
import type { PluginInstallRecord } from "./types.plugins.js";
import { PluginInstallRecordShape } from "./zod-schema.installs.js";

const PluginInstallRecordsSchema = z.record(
  z.string(),
  z.object(PluginInstallRecordShape).passthrough(),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneEmptyPluginsObject(plugins: Record<string, unknown>): unknown {
  const { installs: _installs, ...rest } = plugins;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

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

export function stripShippedPluginInstallConfigRecords(config: unknown): unknown {
  if (!isRecord(config) || !isRecord(config.plugins) || !("installs" in config.plugins)) {
    return config;
  }
  const plugins = pruneEmptyPluginsObject(config.plugins);
  const { plugins: _plugins, ...rest } = config;
  return plugins === undefined ? rest : { ...rest, plugins };
}
