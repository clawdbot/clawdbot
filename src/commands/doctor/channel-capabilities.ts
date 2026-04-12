import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
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

const STATIC_DOCTOR_CHANNEL_CAPABILITIES: Readonly<Record<string, DoctorChannelCapabilities>> = {
  googlechat: {
    dmAllowFromMode: "nestedOnly",
    groupModel: "route",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false,
  },
  matrix: {
    dmAllowFromMode: "nestedOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: true,
  },
  msteams: {
    dmAllowFromMode: "topOnly",
    groupModel: "hybrid",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: true,
  },
  zalouser: {
    dmAllowFromMode: "topOnly",
    groupModel: "hybrid",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false,
  },
};

export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  const staticCapabilities = STATIC_DOCTOR_CHANNEL_CAPABILITIES[channelName];
  if (staticCapabilities) {
    return staticCapabilities;
  }
  const registeredChannelId = normalizeAnyChannelId(channelName);
  if (!registeredChannelId) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  const pluginDoctor =
    getChannelPlugin(registeredChannelId)?.doctor ??
    getBundledChannelPlugin(registeredChannelId)?.doctor;
  if (pluginDoctor) {
    return {
      dmAllowFromMode:
        pluginDoctor.dmAllowFromMode ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.dmAllowFromMode,
      groupModel: pluginDoctor.groupModel ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupModel,
      groupAllowFromFallbackToAllowFrom:
        pluginDoctor.groupAllowFromFallbackToAllowFrom ??
        DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupAllowFromFallbackToAllowFrom,
      warnOnEmptyGroupSenderAllowlist:
        pluginDoctor.warnOnEmptyGroupSenderAllowlist ??
        DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.warnOnEmptyGroupSenderAllowlist,
    };
  }
  return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
}
