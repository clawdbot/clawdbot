import type { MoltbotConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";

export type PluginInstallUpdate = PluginInstallRecord & { pluginId: string };

export function recordPluginInstall(
  cfg: MoltbotConfig,
  update: PluginInstallUpdate,
): MoltbotConfig {
  const { pluginId, ...record } = update;
  const installs = {
    ...cfg.plugins?.installs,
    [pluginId]: {
      ...cfg.plugins?.installs?.[pluginId],
      ...record,
      installedAt: record.installedAt ?? new Date().toISOString(),
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs: {
        ...installs,
        [pluginId]: installs[pluginId],
      },
    },
  };
}
