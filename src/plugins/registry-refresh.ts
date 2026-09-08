// Registry refresh helper shared by plugin config mutations that need post-write discovery repair.
import { createConfigIO } from "../config/io.factory.js";
import { createManagedRuntimeEnvBase } from "../config/io.read-helpers.js";
import { formatConfigIssueSummary } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import type { InstalledPluginIndexRefreshReason } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";

/** Optional warning sink for best-effort registry/cache refresh failures. */
export type PluginRegistryRefreshLogger = {
  warn?: (message: string) => void;
};

type PluginRegistryRefreshParams = {
  reason: InstalledPluginIndexRefreshReason;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  installRecords?: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  invalidateRuntimeCache?: boolean;
  policyPluginIds?: readonly string[];
  traceCommand?: string;
  logger?: PluginRegistryRefreshLogger;
};

/** Refresh inventory from the committed file, including deferred runtime changes. */
export function refreshPluginRegistryAfterConfigMutation(
  params: PluginRegistryRefreshParams & { configPath?: string },
): Promise<void> {
  return refreshPluginRegistryWithConfig(params, async () => {
    // Discovery needs resolved source paths, not the active Gateway's older config/env.
    // Core-only validation lets registry repair precede plugin migrations and validation.
    const snapshot = await createConfigIO({
      configPath: params.configPath,
      env: createManagedRuntimeEnvBase(params.env),
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    if (!snapshot.valid) {
      throw new Error(`Config invalid: ${formatConfigIssueSummary(snapshot.issues)}`);
    }
    return snapshot.runtimeConfig;
  });
}

/** Setup probes discover staged packages before their config is committed. */
export function refreshPluginRegistryForPreparedConfig(
  params: PluginRegistryRefreshParams & { config: OpenClawConfig },
): Promise<void> {
  return refreshPluginRegistryWithConfig(params, () => params.config);
}

async function refreshPluginRegistryWithConfig(
  params: PluginRegistryRefreshParams,
  readConfig: () => OpenClawConfig | Promise<OpenClawConfig>,
): Promise<void> {
  try {
    // Mutations must discover post-write filesystem state without retiring the
    // Gateway's process generation or inheriting its pre-write package facts.
    await withPluginCache(createPluginCache(), async () => {
      const installRecords =
        params.installRecords ??
        (await tracePluginLifecyclePhaseAsync(
          "install records load",
          () => loadInstalledPluginIndexInstallRecords(params.env ? { env: params.env } : {}),
          { command: params.traceCommand ?? "registry-refresh" },
        ));
      await tracePluginLifecyclePhaseAsync(
        "registry refresh",
        async () =>
          refreshPluginRegistry({
            config: await readConfig(),
            reason: params.reason,
            installRecords,
            ...(params.policyPluginIds ? { policyPluginIds: params.policyPluginIds } : {}),
            ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
            ...(params.env ? { env: params.env } : {}),
          }),
        { command: params.traceCommand ?? "registry-refresh", reason: params.reason },
      );
    });
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
