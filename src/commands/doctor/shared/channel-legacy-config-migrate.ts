import { getBootstrapChannelPlugin } from "../../../channels/plugins/bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "../../../channels/plugins/doctor-contract-api.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { applyPluginDoctorCompatibilityMigrations } from "../../../plugins/doctor-contract-registry.js";
import { isRecord } from "./legacy-config-record-shared.js";

type ChannelDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

type ChannelDoctorCompatibilityNormalizer = (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorCompatibilityMutation;

function collectRelevantDoctorChannelIds(raw: unknown): string[] {
  const channels = isRecord(raw) && isRecord(raw.channels) ? raw.channels : null;
  if (!channels) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .toSorted();
}

function resolveBundledChannelCompatibilityNormalizer(
  channelId: string,
): ChannelDoctorCompatibilityNormalizer | undefined {
  const contractNormalizer =
    loadBundledChannelDoctorContractApi(channelId)?.normalizeCompatibilityConfig;
  if (typeof contractNormalizer === "function") {
    return contractNormalizer;
  }
  return getBootstrapChannelPlugin(channelId)?.doctor?.normalizeCompatibilityConfig;
}

export function applyChannelDoctorCompatibilityMigrations(cfg: Record<string, unknown>): {
  next: Record<string, unknown>;
  changes: string[];
} {
  let nextCfg = cfg as OpenClawConfig;
  const changes: string[] = [];
  const unresolvedChannelIds: string[] = [];

  for (const channelId of collectRelevantDoctorChannelIds(cfg)) {
    const normalizeCompatibilityConfig = resolveBundledChannelCompatibilityNormalizer(channelId);
    if (!normalizeCompatibilityConfig) {
      unresolvedChannelIds.push(channelId);
      continue;
    }
    const mutation = normalizeCompatibilityConfig({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    nextCfg = mutation.config;
    changes.push(...mutation.changes);
  }

  if (unresolvedChannelIds.length > 0) {
    const compat = applyPluginDoctorCompatibilityMigrations(nextCfg, {
      pluginIds: unresolvedChannelIds,
    });
    nextCfg = compat.config;
    changes.push(...compat.changes);
  }

  return {
    next: nextCfg as OpenClawConfig & Record<string, unknown>,
    changes,
  };
}
