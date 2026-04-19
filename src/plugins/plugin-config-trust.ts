import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

type PluginEntriesConfig = NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]>;

export function normalizePluginConfigId(id: unknown): string {
  return normalizeOptionalLowercaseString(id) ?? "";
}

function hasPluginConfigId(list: unknown, pluginId: string): boolean {
  return Array.isArray(list) && list.some((entry) => normalizePluginConfigId(entry) === pluginId);
}

function findPluginConfigEntry(
  entries: PluginEntriesConfig | undefined,
  pluginId: string,
): { enabled?: boolean } | undefined {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(entries)) {
    if (normalizePluginConfigId(key) !== pluginId) {
      continue;
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as { enabled?: boolean })
      : {};
  }
  return undefined;
}

export function isWorkspacePluginAllowedByConfig(params: {
  config: OpenClawConfig | undefined;
  isImplicitlyAllowed?: (pluginId: string) => boolean;
  plugin: PluginManifestRecord;
}): boolean {
  const pluginsConfig = params.config?.plugins;
  if (pluginsConfig?.enabled === false) {
    return false;
  }

  const pluginId = normalizePluginConfigId(params.plugin.id);
  if (!pluginId || hasPluginConfigId(pluginsConfig?.deny, pluginId)) {
    return false;
  }

  const entry = findPluginConfigEntry(pluginsConfig?.entries, pluginId);
  if (entry?.enabled === false) {
    return false;
  }
  if (entry?.enabled === true || hasPluginConfigId(pluginsConfig?.allow, pluginId)) {
    return true;
  }
  return params.isImplicitlyAllowed?.(pluginId) ?? false;
}
