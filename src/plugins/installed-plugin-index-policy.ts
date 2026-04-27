import type { OpenClawConfig } from "../config/types.js";
import { listPluginCompatRecords } from "./compat/registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import { hashJson } from "./installed-plugin-index-hash.js";

export function resolveCompatRegistryVersion(): string {
  return hashJson(
    listPluginCompatRecords().map((record) => ({
      code: record.code,
      status: record.status,
      deprecated: record.deprecated,
      warningStarts: record.warningStarts,
      removeAfter: record.removeAfter,
      replacement: record.replacement,
    })),
  );
}

export function resolveInstalledPluginIndexPolicyHash(config: OpenClawConfig | undefined): string {
  const normalized = normalizePluginsConfig(config?.plugins);
  const channelPolicy: Record<string, boolean> = {};
  const channels = config?.channels;
  if (channels && typeof channels === "object" && !Array.isArray(channels)) {
    for (const [channelId, value] of Object.entries(channels)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const enabled = (value as Record<string, unknown>).enabled;
        if (typeof enabled === "boolean") {
          channelPolicy[channelId] = enabled;
        }
      }
    }
  }
  return hashJson({
    plugins: {
      enabled: normalized.enabled,
      allow: normalized.allow,
      deny: normalized.deny,
      slots: normalized.slots,
      entries: Object.fromEntries(
        Object.entries(normalized.entries)
          .flatMap(([pluginId, entry]) =>
            typeof entry.enabled === "boolean" ? [[pluginId, entry.enabled] as const] : [],
          )
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    },
    channels: Object.fromEntries(
      Object.entries(channelPolicy).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  });
}
