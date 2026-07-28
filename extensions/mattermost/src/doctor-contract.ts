// Mattermost plugin module implements doctor contract behavior.
import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { createLegacyPrivateNetworkDoctorContract } from "openclaw/plugin-sdk/ssrf-runtime";

const networkContract = createLegacyPrivateNetworkDoctorContract({
  channelKey: "mattermost",
});

// Mattermost has a preview stream mode; runtime resolves it with a "partial"
// default (resolveChannelPreviewStreamMode(merged, "partial") in accounts.ts),
// so scalar/boolean `streaming` values migrate through the mode path. Account
// merge replaces the root streaming object wholesale (resolveMergedAccountConfig
// without a streaming deep-merge), so migration seeds materialized account
// objects with the inherited root settings.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "mattermost",
  streaming: { defaultMode: "partial" },
  accountStreamingReplacesRoot: true,
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
