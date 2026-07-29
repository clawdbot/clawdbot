// Doctor capability lookup for channel-specific policy and migration behavior.
import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import type { ChannelDmAllowFromMode } from "../../channels/plugins/dm-access.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { findBundledPackageChannelMetadata } from "../../plugins/bundled-package-channel-metadata.js";
import type { PluginPackageChannelDoctorCapabilities } from "../../plugins/manifest.js";

type DoctorGroupModel = "sender" | "route" | "hybrid";

type DoctorChannelCapabilities = {
  dmAllowFromMode: ChannelDmAllowFromMode;
  groupModel: DoctorGroupModel;
  groupAllowFromFallbackToAllowFrom: boolean;
  warnOnEmptyGroupSenderAllowlist: boolean;
};

const DEFAULT_DOCTOR_CHANNEL_CAPABILITIES: DoctorChannelCapabilities = {
  dmAllowFromMode: "topOnly",
  groupModel: "sender",
  groupAllowFromFallbackToAllowFrom: true,
  warnOnEmptyGroupSenderAllowlist: true,
};

function mergeDoctorChannelCapabilities(
  capabilities?: PluginPackageChannelDoctorCapabilities,
): DoctorChannelCapabilities {
  return {
    dmAllowFromMode:
      capabilities?.dmAllowFromMode ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.dmAllowFromMode,
    groupModel: capabilities?.groupModel ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupModel,
    groupAllowFromFallbackToAllowFrom:
      capabilities?.groupAllowFromFallbackToAllowFrom ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupAllowFromFallbackToAllowFrom,
    warnOnEmptyGroupSenderAllowlist:
      capabilities?.warnOnEmptyGroupSenderAllowlist ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.warnOnEmptyGroupSenderAllowlist,
  };
}

function getManifestDoctorCapabilities(
  channelId: string,
): PluginPackageChannelDoctorCapabilities | undefined {
  return findBundledPackageChannelMetadata(channelId)?.doctorCapabilities;
}

/** Resolve doctor behavior capabilities from channel metadata, plugin runtime, or defaults. */
export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }

  const manifestCapabilities = getManifestDoctorCapabilities(channelName);
  if (manifestCapabilities) {
    return mergeDoctorChannelCapabilities(manifestCapabilities);
  }

  const channelId = normalizeAnyChannelId(channelName);
  if (!channelId) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  const pluginDoctor =
    getChannelPlugin(channelId)?.doctor ?? getBundledChannelPlugin(channelId)?.doctor;
  if (pluginDoctor) {
    return mergeDoctorChannelCapabilities(pluginDoctor);
  }
  return mergeDoctorChannelCapabilities(getManifestDoctorCapabilities(channelId));
}

type DoctorChannelAccountIds = {
  configured: string[];
  runtime: string[];
};

function readResolvedAccountId(account: unknown): string | undefined {
  if (!account || typeof account !== "object") {
    return undefined;
  }
  const accountId = (account as { accountId?: unknown }).accountId;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

/** Resolve configured and runtime account ids through the channel plugin's own semantics. */
export function resolveDoctorChannelAccountIds(
  channelName: string,
  cfg: OpenClawConfig,
  configuredAccountIds: string[],
): DoctorChannelAccountIds | undefined {
  const channelId = normalizeAnyChannelId(channelName);
  if (!channelId) {
    return undefined;
  }
  try {
    const plugin = getChannelPlugin(channelId) ?? getBundledChannelPlugin(channelId);
    if (!plugin) {
      return undefined;
    }
    const resolveAccountIds = (accountIds: string[]): string[] | undefined => {
      const resolved = accountIds.map((accountId) =>
        readResolvedAccountId(plugin.config.resolveAccount(cfg, accountId)),
      );
      return resolved.every((accountId): accountId is string => accountId !== undefined)
        ? resolved
        : undefined;
    };
    const configured = resolveAccountIds(configuredAccountIds);
    const runtime = resolveAccountIds(plugin.config.listAccountIds(cfg));
    return configured && runtime ? { configured, runtime } : undefined;
  } catch {
    // Keep doctor warnings conservative when a plugin cannot inspect its account set.
    return undefined;
  }
}
