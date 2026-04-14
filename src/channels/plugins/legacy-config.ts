import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import { listPluginDoctorLegacyConfigRules } from "../../plugins/doctor-contract-registry.js";
import { getBootstrapChannelPlugin } from "./bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";
import type { ChannelId } from "./types.public.js";

function collectConfiguredChannelIds(raw: unknown): ChannelId[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const channels = (raw as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .map((channelId) => channelId as ChannelId);
}

function shouldIncludeLegacyRuleForTouchedPaths(
  rulePath: readonly string[],
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  if (!touchedPaths || touchedPaths.length === 0) {
    return true;
  }
  return touchedPaths.some((touchedPath) => {
    const sharedLength = Math.min(rulePath.length, touchedPath.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (rulePath[index] !== touchedPath[index]) {
        return false;
      }
    }
    return true;
  });
}

function collectRelevantChannelIdsForTouchedPaths(params: {
  raw?: unknown;
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>;
}): ChannelId[] {
  const channelIds = collectConfiguredChannelIds(params.raw);
  if (!params.touchedPaths || params.touchedPaths.length === 0) {
    return channelIds;
  }

  const touchedChannelIds = new Set<ChannelId>();
  for (const touchedPath of params.touchedPaths) {
    const [first, second] = touchedPath;
    if (first !== "channels") {
      continue;
    }
    if (!second) {
      return channelIds;
    }
    if (second === "defaults") {
      continue;
    }
    touchedChannelIds.add(second as ChannelId);
  }

  if (touchedChannelIds.size === 0) {
    return [];
  }
  return channelIds.filter((channelId) => touchedChannelIds.has(channelId));
}

export function collectChannelLegacyConfigRules(
  raw?: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): LegacyConfigRule[] {
  const channelIds = collectRelevantChannelIdsForTouchedPaths({ raw, touchedPaths });
  const rules: LegacyConfigRule[] = [];
  const unresolvedChannelIds: ChannelId[] = [];
  for (const channelId of channelIds) {
    const contractRules = loadBundledChannelDoctorContractApi(channelId)?.legacyConfigRules;
    if (Array.isArray(contractRules) && contractRules.length > 0) {
      rules.push(...contractRules);
      continue;
    }

    const plugin = getBootstrapChannelPlugin(channelId);
    if (plugin?.doctor?.legacyConfigRules?.length) {
      rules.push(...plugin.doctor.legacyConfigRules);
      continue;
    }

    unresolvedChannelIds.push(channelId);
  }
  if (unresolvedChannelIds.length > 0) {
    rules.push(...listPluginDoctorLegacyConfigRules({ pluginIds: unresolvedChannelIds }));
  }

  const seen = new Set<string>();
  return rules.filter((rule) => {
    if (!shouldIncludeLegacyRuleForTouchedPaths(rule.path, touchedPaths)) {
      return false;
    }
    const key = `${rule.path.join(".")}::${rule.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
