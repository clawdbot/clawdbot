// CUA config migrations belong to the plugin so doctor can repair a shipped
// driverPath setting before strict manifest validation reaches this plugin.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor";

const DRIVER_PATH = ["plugins", "entries", "cua-computer", "config", "driverPath"];

/** Retired CUA daemon configuration that `openclaw doctor --fix` removes. */
export const legacyConfigRules = [
  {
    path: DRIVER_PATH,
    message:
      'plugins.entries.cua-computer.config.driverPath is retired; the CUA Driver SDK is configured directly by OpenClaw. Run "openclaw doctor --fix".',
  },
];

/** Removes the retired daemon path without making it a runtime compatibility key. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asObjectRecord(cfg.plugins?.entries?.["cua-computer"]);
  const pluginConfig = asObjectRecord(entry?.config);
  if (!pluginConfig || !Object.hasOwn(pluginConfig, "driverPath")) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextEntry = asObjectRecord(nextConfig.plugins?.entries?.["cua-computer"]);
  const nextPluginConfig = asObjectRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }
  delete nextPluginConfig.driverPath;

  return {
    config: nextConfig,
    changes: [
      "Removed retired plugins.entries.cua-computer.config.driverPath; CUA Driver SDK is configured directly by OpenClaw.",
    ],
  };
}
