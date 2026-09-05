import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "../../../plugins/config-state.js";
import { resolveRetainedManagedNpmInstallPackageInfo } from "../../../plugins/managed-npm-retention.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  buildPluginDependencyStatus,
  normalizePluginDependencySpecs,
} from "../../../plugins/status-dependencies-core.js";

/** Collects dependency failures only for enabled, canonically recorded npm installs. */
export function collectInstalledPluginMissingRequiredDependencies(params: {
  cfg: OpenClawConfig;
  snapshot: PluginMetadataSnapshot;
  installRecords: Record<string, PluginInstallRecord>;
  blockedPluginIds?: ReadonlySet<string>;
  resolvePathIdentity: (value: string) => string;
}) {
  const missing = new Map<string, { rootDir: string; missingRequired: string[] }>();
  const config = normalizePluginsConfig(params.cfg.plugins);
  for (const plugin of params.snapshot.plugins) {
    const record = Object.hasOwn(params.installRecords, plugin.id)
      ? params.installRecords[plugin.id]
      : undefined;
    if (
      plugin.origin === "bundled" ||
      params.blockedPluginIds?.has(plugin.id) ||
      record?.source !== "npm" ||
      !record.installPath?.trim() ||
      !record.spec?.trim()
    ) {
      continue;
    }
    const spec = parseRegistryNpmSpec(record.spec);
    if (
      !spec ||
      plugin.packageName !== spec.name ||
      (record.resolvedName && record.resolvedName !== spec.name) ||
      !resolveEffectiveEnableState({
        id: plugin.id,
        origin: plugin.origin,
        config,
        rootConfig: params.cfg,
        enabledByDefault: plugin.enabledByDefault,
        channelIds: plugin.channels,
      }).enabled
    ) {
      continue;
    }
    const rootDir = params.resolvePathIdentity(plugin.rootDir);
    if (rootDir !== params.resolvePathIdentity(record.installPath)) {
      continue;
    }
    const status = buildPluginDependencyStatus({
      rootDir,
      dependencyRootDir:
        resolveRetainedManagedNpmInstallPackageInfo(rootDir)?.projectRoot ?? rootDir,
      ...normalizePluginDependencySpecs({
        dependencies: plugin.packageDependencies,
        optionalDependencies: plugin.packageOptionalDependencies,
      }),
    });
    if (!status.requiredInstalled) {
      missing.set(plugin.id, { rootDir, missingRequired: status.missing });
    }
  }
  return missing;
}

