import { collectChannelLegacyConfigRules } from "../../../channels/plugins/legacy-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { LegacyConfigRule } from "../../../config/legacy.shared.js";
import type { LegacyConfigIssue } from "../../../config/types.js";
import {
  collectRelevantDoctorPluginIds,
  collectRelevantDoctorPluginIdsForTouchedPaths,
  listPluginDoctorLegacyConfigRules,
} from "../../../plugins/doctor-contract-registry.js";

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
  return listPluginDoctorLegacyConfigRules({ pluginIds });
}

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
