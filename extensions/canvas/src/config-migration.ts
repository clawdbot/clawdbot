/** Canvas config migration to the single surviving route-enable switch. */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asBoolean,
  asOptionalRecord as readRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const RETIRED_HOST_KEYS = ["root", "port", "liveReload"] as const;

/** Removes retired file-host settings while preserving the route enablement choice. */
export function migrateCanvasHostConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const legacyHost = readRecord((config as { canvasHost?: unknown }).canvasHost);
  const plugins = readRecord(config.plugins);
  const entries = readRecord(plugins?.entries);
  const canvasEntry = readRecord(entries?.canvas);
  const canvasConfig = readRecord(canvasEntry?.config);
  const existingHost = readRecord(canvasConfig?.host);
  const retiredKeys = RETIRED_HOST_KEYS.filter((key) => Object.hasOwn(existingHost ?? {}, key));
  if (!legacyHost && retiredKeys.length === 0) {
    return null;
  }

  const next = structuredClone(config) as OpenClawConfig & { canvasHost?: unknown };
  delete next.canvasHost;
  const enabled = asBoolean(existingHost?.enabled) ?? asBoolean(legacyHost?.enabled);
  const nextPlugins = readRecord(next.plugins) ?? {};
  const nextEntries = readRecord(nextPlugins.entries) ?? {};
  const nextEntry = readRecord(nextEntries.canvas) ?? {};
  const nextPluginConfig = readRecord(nextEntry.config) ?? {};

  if (existingHost || enabled !== undefined) {
    if (enabled === undefined) {
      delete nextPluginConfig.host;
    } else {
      nextPluginConfig.host = { enabled };
    }
    nextEntry.config = nextPluginConfig;
    nextEntries.canvas = nextEntry;
    nextPlugins.entries = nextEntries;
    next.plugins = nextPlugins;
  }

  const changes: string[] = [];
  if (legacyHost) {
    changes.push(
      enabled === undefined
        ? "Removed retired canvasHost configuration."
        : "Migrated canvasHost.enabled to plugins.entries.canvas.config.host.enabled.",
    );
  }
  if (retiredKeys.length > 0) {
    changes.push(
      `Removed retired Canvas host config: ${retiredKeys.map((key) => `plugins.entries.canvas.config.host.${key}`).join(", ")}.`,
    );
  }
  return { config: next, changes };
}
