import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "msteams",
  // Teams previews default to partial streaming, matching the runtime default
  // in reply-dispatcher when no mode is configured.
  streaming: { defaultMode: "partial" },
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] =
  streamingAliasMigration.legacyConfigRules;

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return streamingAliasMigration.normalizeChannelConfig({ cfg });
}
