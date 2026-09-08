import type { OpenClawConfig } from "../config/types.openclaw.js";

const PLUGIN_PACKAGE_UNINSTALL_PLAN = Symbol.for("openclaw.pluginPackageUninstallPlan");

type PluginPackageUninstallPlanMetadata = {
  runtimePluginIds: readonly string[];
  runtimeLoadPaths?: readonly string[];
};

export function recordPluginPackageUninstallPlan<T extends object>(
  params: T,
  metadata: PluginPackageUninstallPlanMetadata,
): T {
  Object.defineProperty(params, PLUGIN_PACKAGE_UNINSTALL_PLAN, {
    configurable: false,
    enumerable: true,
    value: metadata,
  });
  return params;
}

export function resolvePluginPackageUninstallPlan(
  params: object,
): PluginPackageUninstallPlanMetadata | undefined {
  return (params as { [PLUGIN_PACKAGE_UNINSTALL_PLAN]?: PluginPackageUninstallPlanMetadata })[
    PLUGIN_PACKAGE_UNINSTALL_PLAN
  ];
}

export function prepareConfigForDisabledPluginSet(
  config: OpenClawConfig,
  pluginIds: readonly string[],
  plannedUninstall?: OpenClawConfig,
): OpenClawConfig {
  const entries = { ...config.plugins?.entries };
  for (const entryId of new Set(pluginIds)) {
    entries[entryId] = {
      ...entries[entryId],
      enabled: false,
    };
  }
  const plugins = { ...config.plugins, entries };
  if (plannedUninstall) {
    // Remove proven load-path aliases in the guarded disable write. Once the
    // package is deleted, a dangling alias can no longer recover its realpath.
    if (plannedUninstall.plugins?.load) {
      plugins.load = plannedUninstall.plugins.load;
    } else {
      delete plugins.load;
    }
  }
  return {
    ...config,
    plugins,
  };
}
