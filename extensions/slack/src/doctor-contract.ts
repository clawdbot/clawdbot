// Slack plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  defineChannelAliasMigration,
  defineKeyMoveMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveSlackNativeStreaming, resolveSlackStreamingMode } from "./streaming-compat.js";

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "slack",
  streaming: {
    // Slack maps its legacy draft stream modes (replace/status_final/append)
    // through its own resolver instead of the generic mode parser.
    defaultMode: "partial",
    resolveMode: resolveSlackStreamingMode,
    resolveNativeTransport: resolveSlackNativeStreaming,
  },
  dm: { root: true, accounts: true },
});

const dmReplyModeMigration = defineKeyMoveMigration({
  from: ["dm", "replyToMode"],
  to: ["replyToModeByChatType", "direct"],
});

const threadMentionPolicyMigration = defineKeyMoveMigration({
  from: ["thread", "requireExplicitMention"],
  to: ["implicitMentions", "threadParticipation"],
  // The retired boolean controlled only participated threads; the canonical
  // setting expresses the inverse while reply-to-bot policy stays independent.
  map: (value) => (typeof value === "boolean" ? { value: !value } : null),
  pruneEmptySource: true,
  movedMessage: ({ sourcePath, targetPath, mappedValue }) =>
    `Moved ${sourcePath} → ${targetPath} (${String(mappedValue)}).`,
});

const channelAllowMigration = defineKeyMoveMigration({
  scope: ["channels", "*"],
  from: ["allow"],
  to: ["enabled"],
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: dmReplyModeMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, dmReplyModeMigration.hasLegacy),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.thread.requireExplicitMention is legacy; use channels.slack.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: threadMentionPolicyMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.thread.requireExplicitMention is legacy; use channels.slack.accounts.<id>.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, threadMentionPolicyMigration.hasLegacy),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.channels.<id>.allow is legacy; use channels.slack.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: channelAllowMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.channels.<id>.allow is legacy; use channels.slack.accounts.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, channelAllowMigration.hasLegacy),
  },
];

function normalizeSlackEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const dm = dmReplyModeMigration.normalize(params);
  const thread = threadMentionPolicyMigration.normalize({ ...params, entry: dm.entry });
  const channels = channelAllowMigration.normalize({ ...params, entry: thread.entry });
  return {
    entry: channels.entry,
    changed: dm.changed || thread.changed || channels.changed,
  };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg, changes });
  return normalizeChannelConfigEntries({
    cfg: aliases.config,
    channelId: "slack",
    changes,
    normalizeEntry: normalizeSlackEntry,
  });
}
