import { hashJson } from "./installed-plugin-index-hash.js";
import type {
  InstalledPluginIndex,
  InstalledPluginIndexRefreshReason,
} from "./installed-plugin-index-types.js";

export function diffInstalledPluginIndexInvalidationReasons(
  previous: InstalledPluginIndex,
  current: InstalledPluginIndex,
): readonly InstalledPluginIndexRefreshReason[] {
  const reasons = new Set<InstalledPluginIndexRefreshReason>();
  if (previous.version !== current.version) {
    reasons.add("missing");
  }
  if (previous.hostContractVersion !== current.hostContractVersion) {
    reasons.add("host-contract-changed");
  }
  if (previous.compatRegistryVersion !== current.compatRegistryVersion) {
    reasons.add("compat-registry-changed");
  }
  if (previous.migrationVersion !== current.migrationVersion) {
    reasons.add("migration");
  }
  if (previous.policyHash !== current.policyHash) {
    reasons.add("policy-changed");
  }
  if (hashJson(previous.installRecords ?? {}) !== hashJson(current.installRecords ?? {})) {
    reasons.add("source-changed");
  }

  const previousByPluginId = new Map(previous.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const currentByPluginId = new Map(current.plugins.map((plugin) => [plugin.pluginId, plugin]));
  for (const [pluginId, previousPlugin] of previousByPluginId) {
    const currentPlugin = currentByPluginId.get(pluginId);
    if (!currentPlugin) {
      reasons.add("source-changed");
      continue;
    }
    if (
      previousPlugin.rootDir !== currentPlugin.rootDir ||
      previousPlugin.manifestPath !== currentPlugin.manifestPath ||
      previousPlugin.installRecordHash !== currentPlugin.installRecordHash
    ) {
      reasons.add("source-changed");
    }
    if (previousPlugin.enabled !== currentPlugin.enabled) {
      reasons.add("policy-changed");
    }
    if (previousPlugin.manifestHash !== currentPlugin.manifestHash) {
      reasons.add("stale-manifest");
    }
    if (
      previousPlugin.packageVersion !== currentPlugin.packageVersion ||
      previousPlugin.packageJson?.path !== currentPlugin.packageJson?.path ||
      previousPlugin.packageJson?.hash !== currentPlugin.packageJson?.hash
    ) {
      reasons.add("stale-package");
    }
  }
  for (const pluginId of currentByPluginId.keys()) {
    if (!previousByPluginId.has(pluginId)) {
      const currentPlugin = currentByPluginId.get(pluginId);
      if (currentPlugin?.enabled === false) {
        continue;
      }
      reasons.add("source-changed");
    }
  }

  return Array.from(reasons).toSorted((left, right) => left.localeCompare(right));
}
