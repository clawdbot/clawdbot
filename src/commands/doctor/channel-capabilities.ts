import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { findBundledPackageChannelMetadata } from "../../plugins/bundled-package-channel-metadata.js";
import type { PluginPackageChannelDoctorCapabilities } from "../../plugins/manifest.js";
import type { AllowFromMode } from "./shared/allow-from-mode.types.js";

export type DoctorGroupModel = "sender" | "route" | "hybrid";

export type DoctorChannelCapabilities = {
  dmAllowFromMode: AllowFromMode;
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
