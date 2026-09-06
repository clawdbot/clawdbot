import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import initialDefaults from "./initial-config-defaults.generated.json" with { type: "json" };

function mergeMissing(
  existing: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const output = { ...existing };
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.hasOwn(output, key)) {
      output[key] = structuredClone(value);
    } else if (isRecord(output[key]) && isRecord(value)) {
      output[key] = mergeMissing(output[key], value);
    }
  }
  return output;
}

/** Applies generated plugin-owned defaults only at an authoritative first config write. */
export function applyInitialPluginConfigDefaults(config: OpenClawConfig): OpenClawConfig {
  const output = structuredClone(config);
  if (Object.hasOwn(output, "plugins") && !isRecord(output.plugins)) {
    return output;
  }
  const plugins: NonNullable<OpenClawConfig["plugins"]> = { ...output.plugins };
  if (Object.hasOwn(plugins, "entries") && !isRecord(plugins.entries)) {
    return output;
  }
  const entries: NonNullable<typeof plugins.entries> = { ...plugins.entries };
  for (const [pluginId, defaults] of Object.entries(initialDefaults)) {
    if (Object.hasOwn(entries, pluginId) && !isRecord(entries[pluginId])) {
      continue;
    }
    const entry = { ...entries[pluginId] };
    if (Object.hasOwn(entry, "config") && !isRecord(entry.config)) {
      continue;
    }
    const existingConfig = isRecord(entry.config) ? entry.config : {};
    entry.config = mergeMissing(existingConfig, defaults);
    entries[pluginId] = entry;
  }
  plugins.entries = entries;
  output.plugins = plugins;
  return output;
}
