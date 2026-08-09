// Mattermost plugin module implements doctor contract behavior.
import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createLegacyPrivateNetworkDoctorContract,
  defineChannelAliasMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

const networkContract = createLegacyPrivateNetworkDoctorContract({
  channelKey: "mattermost",
});

// Mattermost has a preview stream mode; runtime resolves it with a "partial"
// default (resolveChannelPreviewStreamMode(merged, "partial") in accounts.ts),
// so scalar/boolean `streaming` values migrate through the mode path. Runtime
// composes root and account streaming objects, so doctor must not materialize
// inherited root values inside accounts and freeze future root changes.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "mattermost",
  streaming: { defaultMode: "partial" },
});

export const legacyConfigRules = [
  ...networkContract.legacyConfigRules,
  ...streamingAliasMigration.legacyConfigRules,
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const network = networkContract.normalizeCompatibilityConfig({ cfg });
  return streamingAliasMigration.normalizeChannelConfig({
    cfg: network.config,
    changes: network.changes,
  });
}
