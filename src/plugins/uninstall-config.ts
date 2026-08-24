// Pure plugin config cleanup shared by doctor repair and full uninstall flows.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isUninstallPathInsideOrEqualInternal,
  removePluginInstallOwnerFromConfig,
  removePluginRuntimePolicyFromConfig,
  resolveComparableUninstallPathInternal,
  resolveUninstallChannelConfigKeysInternal,
} from "./uninstall-package-config.js";
import type { PluginConfigUninstallActions } from "./uninstall-package-config.js";

export type { PluginConfigUninstallActions } from "./uninstall-package-config.js";

/** Resolve a path through existing ancestors while preserving missing targets. */
export function resolveComparableUninstallPath(value: string): string {
  return resolveComparableUninstallPathInternal(value);
}

/** Check whether a managed uninstall target stays inside its owning root. */
export function isUninstallPathInsideOrEqual(parent: string, child: string): boolean {
  return isUninstallPathInsideOrEqualInternal(parent, child);
}

/** Resolve channel config keys owned by a plugin during uninstall. */
export function resolveUninstallChannelConfigKeys(
  pluginId: string,
  opts?: { channelIds?: string[] },
): string[] {
  return resolveUninstallChannelConfigKeysInternal(pluginId, opts);
}

function mergeUninstallActions(
  left: PluginConfigUninstallActions,
  right: PluginConfigUninstallActions,
): PluginConfigUninstallActions {
  return Object.fromEntries(
    Object.keys(left).map((key) => [
      key,
      left[key as keyof PluginConfigUninstallActions] ||
        right[key as keyof PluginConfigUninstallActions],
    ]),
  ) as PluginConfigUninstallActions;
}

/** Remove plugin references from config without loading uninstall process/runtime dependencies. */
export function removePluginFromConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  opts?: { channelIds?: string[] },
): { config: OpenClawConfig; actions: PluginConfigUninstallActions } {
  const hasInstallRecord = Object.hasOwn(cfg.plugins?.installs ?? {}, pluginId);
  const policy = removePluginRuntimePolicyFromConfig(cfg, pluginId, {
    ...(hasInstallRecord ? opts : { channelIds: [] }),
  });
  const owner = removePluginInstallOwnerFromConfig(policy.config, pluginId);
  return { config: owner.config, actions: mergeUninstallActions(policy.actions, owner.actions) };
}
