// Canonical configured-channel enumeration for doctor flows with intentionally distinct policies.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isChannelConfigMetadataKey } from "../../../channels/config-metadata.js";
import {
  hasMeaningfulChannelConfig,
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelPresenceSignals,
} from "../../../channels/config-presence.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isRecord } from "../../../utils.js";

type ConfiguredChannelEntryPolicy = "raw" | "enabled" | "meaningful" | "enabled-or-meaningful";

type DoctorConfiguredChannelIdOptions = {
  configEntryPolicy: ConfiguredChannelEntryPolicy;
  env?: NodeJS.ProcessEnv;
  candidateChannelIds?: readonly string[];
  skipWhenPluginsDisabled?: boolean;
  excludeExplicitlyDisabled?: boolean;
  mapEnvironmentChannelId?: (channelId: string) => string;
  environmentChannelIsConfigured?: (channelId: string) => boolean;
  sort?: "codepoint" | "locale";
};

function includesConfigEntry(value: unknown, policy: ConfiguredChannelEntryPolicy): boolean {
  if (policy === "raw") {
    return true;
  }
  if (policy === "enabled") {
    return !isRecord(value) || value.enabled !== false;
  }
  const meaningful = hasMeaningfulChannelConfig(value);
  return policy === "meaningful"
    ? meaningful
    : (isRecord(value) && value.enabled === true) || meaningful;
}

/** Lists configured channel ids while leaving caller-specific activation policy at the caller. */
export function listDoctorConfiguredChannelIds(
  config: unknown,
  options: DoctorConfiguredChannelIdOptions,
): string[] {
  const root = isRecord(config) ? config : {};
  const cfg = root as OpenClawConfig;
  if (options.skipWhenPluginsDisabled && isRecord(root.plugins) && root.plugins.enabled === false) {
    return [];
  }

  const disabledIds = options.excludeExplicitlyDisabled
    ? new Set(listExplicitlyDisabledChannelIdsForConfig(cfg))
    : null;
  const ids = new Set<string>();
  const add = (rawChannelId: string) => {
    const channelId = rawChannelId.trim();
    const normalized = normalizeOptionalLowercaseString(channelId);
    if (
      !channelId ||
      isChannelConfigMetadataKey(channelId) ||
      (normalized && disabledIds?.has(normalized))
    ) {
      return;
    }
    ids.add(channelId);
  };

  const channels = isRecord(root.channels) ? root.channels : null;
  if (channels) {
    for (const [channelId, entry] of Object.entries(channels)) {
      if (includesConfigEntry(entry, options.configEntryPolicy)) {
        add(channelId);
      }
    }
  }

  if (options.env) {
    for (const signal of listPotentialConfiguredChannelPresenceSignals(cfg, options.env, {
      channelIds: options.candidateChannelIds,
      includePersistedAuthState: false,
    })) {
      if (signal.source !== "env") {
        continue;
      }
      const channelId = options.mapEnvironmentChannelId?.(signal.channelId) ?? signal.channelId;
      if (options.environmentChannelIsConfigured?.(channelId) === false) {
        continue;
      }
      add(channelId);
    }
  }

  const result = [...ids];
  if (options.sort === "locale") {
    return result.toSorted((left, right) => left.localeCompare(right));
  }
  return options.sort === "codepoint" ? result.toSorted() : result;
}
