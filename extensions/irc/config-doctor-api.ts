// Irc API module exposes the plugin doctor contract.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

// IRC's nested streaming schema is delivery-only ({chunkMode, block}); it has
// no preview mode, so only the delivery flat aliases are legal legacy input.
// Account merge replaces the root streaming object wholesale
// (resolveMergedAccountConfig without a streaming deep-merge), so migration
// seeds materialized account objects with the inherited root settings.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "irc",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingReplacesRoot: true,
});

// channels.irc.mentionPatterns was declared by the schema but never read by any
// IRC or core code path, and its string-array shape collided with the core
// mentionPatterns policy object. Mention patterns come from
// messages.groupChat.mentionPatterns, so the key is stripped rather than wired.
const RETIRED_IRC_KEYS = new Set(["mentionPatterns"]);

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "irc"],
    match: (value) => Object.hasOwn(asObjectRecord(value) ?? {}, "mentionPatterns"),
    message:
      'channels.irc.mentionPatterns was accepted but never read; configure mention patterns with messages.groupChat.mentionPatterns. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "irc", "accounts"],
    match: (value) =>
      Object.values(asObjectRecord(value) ?? {}).some((account) =>
        Object.hasOwn(asObjectRecord(account) ?? {}, "mentionPatterns"),
      ),
    message:
      'channels.irc.accounts.<id>.mentionPatterns was accepted but never read; configure mention patterns with messages.groupChat.mentionPatterns. Run "openclaw doctor --fix".',
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg });
  const changes = [...aliases.changes];
  const stripped = stripRetiredChannelKeys({
    cfg: aliases.config,
    channelId: "irc",
    keys: RETIRED_IRC_KEYS,
    scope: "root-and-accounts",
    onRemove: (removed) => {
      changes.push(`Removed ${removed.pathPrefix}.${removed.key}; it was never read.`);
    },
  });
  return { config: stripped.config, changes };
}
