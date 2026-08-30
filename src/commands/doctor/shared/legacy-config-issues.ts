// Doctor legacy config issue finder that combines core, channel, and plugin rules.
import { collectChannelLegacyConfigRules } from "../../../channels/plugins/legacy-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { LegacyConfigRule } from "../../../config/legacy.shared.js";
import type {
  ConfigFileSnapshot,
  LegacyConfigIssue,
  OpenClawConfig,
} from "../../../config/types.js";
import {
  collectDoctorConfigRepairPluginIds,
  listPluginDoctorLegacyConfigRules,
} from "../../../plugins/doctor-contract-registry.js";
import {
  withPluginMetadataCollectionScope,
  type PreparedPluginMetadata,
} from "../../../plugins/plugin-metadata-collection.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";

function collectConfiguredChannelIds(raw: unknown): ReadonlySet<string> {
  return new Set(listDoctorConfiguredChannelIds(raw, { configEntryPolicy: "raw" }));
}

function collectPluginLegacyConfigRules(
  raw: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): LegacyConfigRule[] {
  const channelIds = collectConfiguredChannelIds(raw);
  const pluginIds = collectDoctorConfigRepairPluginIds(raw, touchedPaths).filter(
    (pluginId) => !channelIds.has(pluginId),
  );
  if (pluginIds.length === 0) {
    return [];
  }
  return listPluginDoctorLegacyConfigRules({ config: raw as OpenClawConfig, pluginIds });
}

/** Find legacy config issues using core rules plus relevant channel/plugin doctor contracts. */
export function findDoctorLegacyConfigIssues(
  raw: unknown,
  sourceRaw?: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): LegacyConfigIssue[] {
  return findLegacyConfigIssues(
    raw,
    sourceRaw,
    [
      ...collectChannelLegacyConfigRules(raw, touchedPaths),
      ...collectPluginLegacyConfigRules(raw, touchedPaths),
    ],
    touchedPaths,
  );
}

export function addDoctorLegacyIssues(
  snapshot: ConfigFileSnapshot,
  pluginMetadata?: PreparedPluginMetadata,
): ConfigFileSnapshot {
  if (!snapshot.exists) {
    return snapshot;
  }
  const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
  const collect = () => {
    const sourceRaw = snapshot.parsed ?? resolvedRaw;
    const legacyIssues = findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
    return legacyIssues.length === 0 ? snapshot : { ...snapshot, legacyIssues };
  };
  return pluginMetadata
    ? withPluginMetadataCollectionScope(pluginMetadata, collect, { config: resolvedRaw })
    : collect();
}
