import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { InstalledPluginIndexRefreshReason } from "../plugins/installed-plugin-index.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";

export type PluginRegistryRefreshLogger = {
  warn?: (message: string) => void;
};

export async function refreshPluginRegistryAfterConfigMutation(params: {
  config: OpenClawConfig;
  reason: InstalledPluginIndexRefreshReason;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  installRecords?: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  logger?: PluginRegistryRefreshLogger;
}): Promise<void> {
  try {
    const installRecords =
      params.installRecords ??
      (await loadInstalledPluginIndexInstallRecords(params.env ? { env: params.env } : {}));
    await refreshPluginRegistry({
      config: params.config,
      reason: params.reason,
      installRecords,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.env ? { env: params.env } : {}),
    });
  } catch (error) {
    params.logger?.warn?.(`Plugin registry refresh failed: ${formatErrorMessage(error)}`);
  }
}
