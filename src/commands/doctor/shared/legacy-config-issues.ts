// Doctor legacy config issue finder that combines core, channel, and plugin rules.
import { collectChannelLegacyConfigRules } from "../../../channels/plugins/legacy-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { LegacyConfigRule } from "../../../config/legacy.shared.js";
import type {
  ConfigFileSnapshot,
  LegacyConfigIssue,
  OpenClawConfig,
} from "../../../config/types.js";
import { withPluginMetadataSnapshotScope } from "../../../plugins/current-plugin-metadata-snapshot.js";
import {
  collectRelevantDoctorPluginIds,
  collectRelevantDoctorPluginIdsForTouchedPaths,
  listPluginDoctorLegacyConfigRules,
} from "../../../plugins/doctor-contract-registry.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";

function collectConfiguredChannelIds(raw: unknown): ReadonlySet<string> {
  if (!raw || typeof raw !== "object") {
    return new Set();
  }
  const channels = (raw as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return new Set();
  }
  return new Set(Object.keys(channels).filter((channelId) => channelId !== "defaults"));
}

function collectPluginLegacyConfigRules(
  raw: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): LegacyConfigRule[] {
  const channelIds = collectConfiguredChannelIds(raw);
  const pluginIds = (
    touchedPaths
      ? collectRelevantDoctorPluginIdsForTouchedPaths({ raw, touchedPaths })
      : collectRelevantDoctorPluginIds(raw)
  ).filter((pluginId) => !channelIds.has(pluginId));
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
  pluginMetadataSnapshot?: PluginMetadataSnapshot,
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
  return pluginMetadataSnapshot
    ? withPluginMetadataSnapshotScope(pluginMetadataSnapshot, collect, { config: resolvedRaw })
    : collect();
}
