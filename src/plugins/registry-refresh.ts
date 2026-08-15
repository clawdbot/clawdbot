// Registry refresh helper shared by plugin config mutations that need post-write discovery repair.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import type { InstalledPluginIndexRefreshReason } from "./installed-plugin-index.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";
import { refreshPluginRegistry } from "./plugin-registry.js";

/** Optional warning sink for best-effort registry/cache refresh failures. */
export type PluginRegistryRefreshLogger = {
  warn?: (message: string) => void;
};

/** Refresh persisted plugin registry and clear runtime discovery after a config mutation. */
export async function refreshPluginRegistryAfterConfigMutation(params: {
  config: OpenClawConfig;
  reason: InstalledPluginIndexRefreshReason;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  installRecords?: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  invalidateRuntimeCache?: boolean;
  policyPluginIds?: readonly string[];
  traceCommand?: string;
  logger?: PluginRegistryRefreshLogger;
}): Promise<void> {
  try {
    const installRecords =
      params.installRecords ??
      (await tracePluginLifecyclePhaseAsync(
        "install records load",
        () => loadInstalledPluginIndexInstallRecords(params.env ? { env: params.env } : {}),
        { command: params.traceCommand ?? "registry-refresh" },
      ));
    await tracePluginLifecyclePhaseAsync(
      "registry refresh",
      () =>
        refreshPluginRegistry({
          config: params.config,
          reason: params.reason,
          installRecords,
          ...(params.policyPluginIds ? { policyPluginIds: params.policyPluginIds } : {}),
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.env ? { env: params.env } : {}),
        }),
      { command: params.traceCommand ?? "registry-refresh", reason: params.reason },
    );
  } catch (error) {
    params.logger?.warn?.(`Plugin registry refresh failed: ${formatErrorMessage(error)}`);
  }
  if (params.invalidateRuntimeCache !== false) {
    await invalidatePluginRuntimeDiscoveryAfterConfigMutation(params);
  }
}

export async function invalidatePluginRuntimeDiscoveryAfterConfigMutation(params: {
  logger?: PluginRegistryRefreshLogger;
}): Promise<void> {
  try {
    const { clearPluginRegistryLoadCache } = await import("./loader.js");
    clearPluginRegistryLoadCache();
  } catch (error) {
    params.logger?.warn?.(`Plugin runtime cache invalidation failed: ${formatErrorMessage(error)}`);
  }
}
