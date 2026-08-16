import {
  findBundledChannelCatalogId,
  findBundledChannelCatalogMetadata,
} from "../../channels/bundled-channel-catalog-read.js";
// Doctor capability lookup for channel-specific policy and migration behavior.
import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import type { ChannelDmAllowFromMode } from "../../channels/plugins/dm-access.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginPackageChannelDoctorCapabilities } from "../../plugins/manifest.js";

type DoctorGroupModel = "sender" | "route" | "hybrid";

type DoctorChannelCapabilities = {
  dmAllowFromMode: ChannelDmAllowFromMode;
  openDmRequiresAllowFromWildcard?: boolean;
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
    ...(typeof capabilities?.openDmRequiresAllowFromWildcard === "boolean"
      ? { openDmRequiresAllowFromWildcard: capabilities.openDmRequiresAllowFromWildcard }
      : {}),
    groupModel: capabilities?.groupModel ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupModel,
    groupAllowFromFallbackToAllowFrom:
      capabilities?.groupAllowFromFallbackToAllowFrom ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupAllowFromFallbackToAllowFrom,
    warnOnEmptyGroupSenderAllowlist:
      capabilities?.warnOnEmptyGroupSenderAllowlist ??
      DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.warnOnEmptyGroupSenderAllowlist,
  };
}

function getCatalogDoctorCapabilities(
  channelId: string,
): PluginPackageChannelDoctorCapabilities | undefined {
  return findBundledChannelCatalogMetadata(channelId)?.doctorCapabilities;
}

/** Resolve doctor behavior capabilities from channel metadata, plugin runtime, or defaults. */
export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }

  const catalogCapabilities = getCatalogDoctorCapabilities(channelName);
  if (catalogCapabilities) {
    return mergeDoctorChannelCapabilities(catalogCapabilities);
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
  return mergeDoctorChannelCapabilities(getCatalogDoctorCapabilities(channelId));
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

function findReadOnlyChannelPlugin(
  cfg: OpenClawConfig,
  channelName: string,
): ChannelPlugin | undefined {
  try {
    const { plugins } = resolveReadOnlyChannelPluginsForConfig(cfg, {
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });
    return plugins.find((plugin) => plugin.id === channelName);
  } catch {
    // Doctor stays conservative when configured plugins cannot be loaded.
    return undefined;
  }
}

/** Resolve configured and runtime account ids through the channel plugin's own semantics. */
export function resolveDoctorChannelAccountIds(
  channelName: string,
  cfg: OpenClawConfig,
  configuredAccountIds: string[],
): DoctorChannelAccountIds | undefined {
  // The plugin registry is only populated once channels start. Doctor inspects
  // config without starting them, so fall back to the bundled catalog instead of
  // treating every channel as unknown and returning undefined for all of them.
  const channelId = normalizeAnyChannelId(channelName) ?? findBundledChannelCatalogId(channelName);
  try {
    const plugin =
      (channelId
        ? (getChannelPlugin(channelId) ?? getBundledChannelPlugin(channelId))
        : undefined) ??
      // Configured external plugins are absent from both the registry and the
      // bundled catalog, so reuse the config-driven loader doctor already uses
      // to find their adapters.
      findReadOnlyChannelPlugin(cfg, channelName);
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
