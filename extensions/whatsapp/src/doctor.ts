// Whatsapp plugin module implements doctor behavior.
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return { config: cfg, changes: [] };
}

export const whatsappDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
};
