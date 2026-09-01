import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  resolveInstalledPluginLifecycleOwnership,
  resolveInstalledPluginPackageOwnership,
  type InstalledPluginLifecycleOwnership,
} from "./installed-plugin-package-ownership.js";
import {
  hasMatchingPluginLoadPath,
  removePluginRuntimePolicyFromConfig,
} from "./uninstall-package-config.js";

type PluginPackageUpdateSnapshot = ReadonlyMap<string, InstalledPluginLifecycleOwnership>;

export function capturePluginPackageUpdateSnapshot(params: {
  index: InstalledPluginIndex;
  installOwners: readonly string[];
  env?: NodeJS.ProcessEnv;
}): { ok: true; value: PluginPackageUpdateSnapshot } | { ok: false; error: string } {
  const snapshot = new Map<string, InstalledPluginLifecycleOwnership>();
  for (const installOwner of new Set(params.installOwners)) {
    const ownership = resolveInstalledPluginLifecycleOwnership(
      params.index,
      installOwner,
      params.env,
    );
    if (!ownership.ok) {
      return ownership;
    }
    snapshot.set(installOwner, ownership.value);
  }
  return { ok: true, value: snapshot };
}

function contributionKeys(
  index: InstalledPluginIndex,
  pluginIds: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const plugin of index.plugins) {
    if (!pluginIds.has(plugin.pluginId)) {
      continue;
    }
    for (const key of [
      ...(plugin.contributions?.channels ?? []),
      ...(plugin.contributions?.channelConfigs ?? []),
    ]) {
      keys.add(key);
    }
  }
  return keys;
}

/** Reconcile policy for children removed by a package update. */
export function reconcilePluginPackageUpdateConfig(params: {
  config: OpenClawConfig;
  beforeIndex: InstalledPluginIndex;
  afterIndex: InstalledPluginIndex;
  snapshot: PluginPackageUpdateSnapshot;
  installOwnerMigrations?: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
}): { ok: true; config: OpenClawConfig } | { ok: false; error: string } {
  let config = params.config;
  for (const [installOwner, before] of params.snapshot) {
    const nextInstallOwner = params.installOwnerMigrations?.[installOwner] ?? installOwner;
    const after = resolveInstalledPluginPackageOwnership(
      params.afterIndex,
      nextInstallOwner,
      params.env,
    );
    if (before.kind === "orphan") {
      const lifecycleAfter = resolveInstalledPluginLifecycleOwnership(
        params.afterIndex,
        nextInstallOwner,
        params.env,
      );
      const unchangedOrphan =
        nextInstallOwner === installOwner &&
        isDeepStrictEqual(
          params.afterIndex.installRecords[nextInstallOwner],
          before.installRecord,
        ) &&
        lifecycleAfter.ok &&
        lifecycleAfter.value.kind === "orphan";
      if (!after.ok && !unchangedOrphan) {
        return after;
      }
      continue;
    }
    if (!after.ok) {
      return after;
    }
    const afterPluginIds = new Set(after.value.pluginIds);
    const removedPluginIds = before.pluginIds.filter((pluginId) => !afterPluginIds.has(pluginId));
    if (removedPluginIds.length === 0) {
      continue;
    }
    const retainedContributionKeys = contributionKeys(params.afterIndex, afterPluginIds);
    for (const pluginId of removedPluginIds) {
      const oldRecord = params.beforeIndex.plugins.find((plugin) => plugin.pluginId === pluginId);
      const channelIds = [
        ...(oldRecord?.contributions?.channels ?? []),
        ...(oldRecord?.contributions?.channelConfigs ?? []),
      ].filter((channelId) => !retainedContributionKeys.has(channelId));
      config = removePluginRuntimePolicyFromConfig(config, pluginId, {
        channelIds,
        loadPaths: oldRecord?.source ? [oldRecord.source] : [],
      }).config;
    }
  }
  return { ok: true, config };
}

export function pluginPackageUpdateMayMutateConfig(params: {
  config: OpenClawConfig;
  index: InstalledPluginIndex;
  snapshot: PluginPackageUpdateSnapshot;
}): boolean {
  const plugins = params.config.plugins;
  const channels = params.config.channels as Record<string, unknown> | undefined;
  for (const ownership of params.snapshot.values()) {
    const pluginIds = new Set(ownership.pluginIds);
    const ownedSources = params.index.plugins
      .filter((plugin) => pluginIds.has(plugin.pluginId) && plugin.source)
      .map((plugin) => plugin.source!);
    if (hasMatchingPluginLoadPath(params.config, ownedSources)) {
      return true;
    }
    for (const pluginId of ownership.pluginIds) {
      if (
        plugins?.allow?.includes(pluginId) ||
        plugins?.deny?.includes(pluginId) ||
        Object.hasOwn(plugins?.entries ?? {}, pluginId) ||
        plugins?.slots?.memory === pluginId ||
        plugins?.slots?.contextEngine === pluginId
      ) {
        return true;
      }
    }
    if (
      channels &&
      [...contributionKeys(params.index, pluginIds)].some((key) => Object.hasOwn(channels, key))
    ) {
      return true;
    }
  }
  return false;
}
