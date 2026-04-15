import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const legacyAckReaction = cfg.messages?.ackReaction?.trim();
  if (!legacyAckReaction || cfg.channels?.whatsapp === undefined) {
    return { config: cfg, changes: [] };
  }
  if (cfg.channels.whatsapp?.ackReaction !== undefined) {
    return { config: cfg, changes: [] };
  }

  const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  let direct = true;
  let group: "always" | "mentions" | "never" = "mentions";
  if (legacyScope === "all") {
    direct = true;
    group = "always";
  } else if (legacyScope === "direct") {
    direct = true;
    group = "never";
  } else if (legacyScope === "group-all") {
    direct = false;
    group = "always";
  } else if (legacyScope === "group-mentions") {
    direct = false;
    group = "mentions";
  }

  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        whatsapp: {
          ...cfg.channels?.whatsapp,
          ackReaction: { emoji: legacyAckReaction, direct, group },
        },
      },
    },
    changes: [
      `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
    ],
  };
}

export const whatsappDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
};
