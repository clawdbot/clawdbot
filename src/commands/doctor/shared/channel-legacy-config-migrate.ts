// Legacy config migration bridge for channel doctor compatibility contracts.

import { isChannelConfigMetadataKey } from "../../../channels/config-metadata.js";
import { getBootstrapChannelPlugin } from "../../../channels/plugins/bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "../../../channels/plugins/doctor-contract-api.js";
import type { OpenClawConfig } from "../../../config/types.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  collectDoctorConfigRepairPluginIds,
} from "../../../plugins/doctor-contract-registry.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";
import { isRecord } from "./legacy-config-record-shared.js";

type ChannelDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

type ChannelDoctorCompatibilityNormalizer = (params: {
  cfg: OpenClawConfig;
}) => ChannelDoctorCompatibilityMutation;

function migrateHeartbeatVisibility(raw: Record<string, unknown>, changes: string[]): void {
  const channels = isRecord(raw.channels) ? raw.channels : null;
  if (!channels) {
    return;
  }
  const migrateEntry = (
    entry: Record<string, unknown>,
    path: string,
    preserveEmptyPluginBlock = false,
  ) => {
    const heartbeat = isRecord(entry.heartbeat) ? entry.heartbeat : null;
    const keys = heartbeat ? Object.keys(heartbeat) : [];
    if (
      !heartbeat ||
      (preserveEmptyPluginBlock && keys.length === 0) ||
      keys.some((key) => key !== "showOk" && key !== "showAlerts" && key !== "useIndicator")
    ) {
      return;
    }
    if (entry.heartbeatVisibility === undefined) {
      entry.heartbeatVisibility = entry.heartbeat;
      changes.push(`Moved ${path}.heartbeat → ${path}.heartbeatVisibility.`);
    } else {
      changes.push(`Removed ${path}.heartbeat (${path}.heartbeatVisibility already set).`);
    }
    delete entry.heartbeat;
  };
  const defaults = isRecord(channels.defaults) ? channels.defaults : null;
  if (defaults) {
    migrateEntry(defaults, "channels.defaults");
  }
  for (const [channelId, value] of Object.entries(channels)) {
    if (!channelId.trim() || isChannelConfigMetadataKey(channelId) || !isRecord(value)) {
      continue;
    }
    const preserveEmptyPluginBlock = channelId === "feishu";
    migrateEntry(value, `channels.${channelId}`, preserveEmptyPluginBlock);
    const accounts = isRecord(value.accounts) ? value.accounts : null;
    if (!accounts) {
      continue;
    }
    for (const [accountId, account] of Object.entries(accounts)) {
      if (isRecord(account)) {
        migrateEntry(
          account,
          `channels.${channelId}.accounts.${accountId}`,
          preserveEmptyPluginBlock,
        );
      }
    }
  }
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

function collectPluginDoctorCompatibilityIds(params: {
  raw: unknown;
  unresolvedChannelIds: readonly string[];
}): string[] {
  const unresolvedChannelIds = new Set(params.unresolvedChannelIds);
  return [
    ...new Set([
      ...params.unresolvedChannelIds,
      ...collectDoctorConfigRepairPluginIds(params.raw).filter(
        (pluginId) => !unresolvedChannelIds.has(pluginId),
      ),
    ]),
  ].toSorted();
}

/** Apply bundled and plugin channel compatibility migrations to a legacy config object. */
export function applyChannelDoctorCompatibilityMigrations(cfg: Record<string, unknown>): {
  next: Record<string, unknown>;
  changes: string[];
} {
  let nextCfg = cfg as OpenClawConfig;
  const changes: string[] = [];
  migrateHeartbeatVisibility(cfg, changes);
  const unresolvedChannelIds: string[] = [];

  for (const channelId of listDoctorConfiguredChannelIds(cfg, {
    configEntryPolicy: "raw",
    sort: "codepoint",
  })) {
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

  const pluginIds = collectPluginDoctorCompatibilityIds({ raw: cfg, unresolvedChannelIds });
  if (pluginIds.length > 0) {
    const compat = applyPluginDoctorCompatibilityMigrations(nextCfg, {
      config: cfg as OpenClawConfig,
      pluginIds,
    });
    nextCfg = compat.config;
    changes.push(...compat.changes);
  }

  return {
    next: nextCfg as OpenClawConfig & Record<string, unknown>,
    changes,
  };
}
