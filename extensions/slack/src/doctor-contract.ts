// Slack plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
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

function hasLegacySlackChannelAllowAlias(value: unknown): boolean {
  const channels = asObjectRecord(asObjectRecord(value)?.channels);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((channel) =>
    Object.hasOwn(asObjectRecord(channel) ?? {}, "allow"),
  );
}

function hasLegacySlackThreadMentionPolicy(value: unknown): boolean {
  const thread = asObjectRecord(asObjectRecord(value)?.thread);
  return Boolean(thread && Object.hasOwn(thread, "requireExplicitMention"));
}

function hasLegacyDmReplyMode(value: unknown): boolean {
  return Object.hasOwn(asObjectRecord(asObjectRecord(value)?.dm) ?? {}, "replyToMode");
}

function migrateDmReplyMode(
  entry: Record<string, unknown>,
  path: string,
  changes: string[],
): boolean {
  const dm = asObjectRecord(entry.dm);
  if (!dm || !Object.hasOwn(dm, "replyToMode")) {
    return false;
  }
  const byType = asObjectRecord(entry.replyToModeByChatType) ?? {};
  if (byType.direct === undefined) {
    byType.direct = dm.replyToMode;
    entry.replyToModeByChatType = byType;
    changes.push(`Moved ${path}.dm.replyToMode → ${path}.replyToModeByChatType.direct.`);
  } else {
    changes.push(`Removed ${path}.dm.replyToMode (replyToModeByChatType.direct already set).`);
  }
  delete dm.replyToMode;
  return true;
}

function normalizeSlackThreadMentionPolicy(params: {
  value: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { value: Record<string, unknown>; changed: boolean } {
  const thread = asObjectRecord(params.value.thread);
  if (!thread || !Object.hasOwn(thread, "requireExplicitMention")) {
    return { value: params.value, changed: false };
  }

  const next = { ...params.value };
  const nextThread = { ...thread };
  const implicitMentions = asObjectRecord(params.value.implicitMentions) ?? {};
  const nextImplicitMentions = { ...implicitMentions };
  const legacyValue = thread.requireExplicitMention;
  const targetPath = `${params.pathPrefix}.implicitMentions.threadParticipation`;
  if (nextImplicitMentions.threadParticipation !== undefined) {
    params.changes.push(
      `Removed ${params.pathPrefix}.thread.requireExplicitMention (${targetPath} already set).`,
    );
  } else if (typeof legacyValue === "boolean") {
    // The retired key maps only the participated-thread fact. Replies to the bot
    // remain independently governed by the canonical replyToBot policy.
    nextImplicitMentions.threadParticipation = !legacyValue;
    params.changes.push(
      `Moved ${params.pathPrefix}.thread.requireExplicitMention → ${targetPath} (${String(!legacyValue)}).`,
    );
  } else {
    params.changes.push(
      `Removed invalid ${params.pathPrefix}.thread.requireExplicitMention value.`,
    );
  }
  delete nextThread.requireExplicitMention;
  if (Object.keys(nextThread).length > 0) {
    next.thread = nextThread;
  } else {
    delete next.thread;
  }
  if (Object.keys(nextImplicitMentions).length > 0) {
    next.implicitMentions = nextImplicitMentions;
  }
  return { value: next, changed: true };
}

function normalizeSlackChannelAllowAliases(params: {
  channels: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { channels: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextChannels = { ...params.channels };
  for (const [channelId, channelValue] of Object.entries(params.channels)) {
    const channel = asObjectRecord(channelValue);
    if (!channel || !Object.hasOwn(channel, "allow")) {
      continue;
    }
    const nextChannel = { ...channel };
    if (nextChannel.enabled === undefined) {
      nextChannel.enabled = channel.allow;
      params.changes.push(
        `Moved ${params.pathPrefix}.${channelId}.allow → ${params.pathPrefix}.${channelId}.enabled.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.${channelId}.allow (${params.pathPrefix}.${channelId}.enabled already set).`,
      );
    }
    delete nextChannel.allow;
    nextChannels[channelId] = nextChannel;
    changed = true;
  }
  return { channels: nextChannels, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: hasLegacyDmReplyMode,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyDmReplyMode),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.thread.requireExplicitMention is legacy; use channels.slack.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: hasLegacySlackThreadMentionPolicy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.thread.requireExplicitMention is legacy; use channels.slack.accounts.<id>.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacySlackThreadMentionPolicy),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.channels.<id>.allow is legacy; use channels.slack.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacySlackChannelAllowAlias,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.channels.<id>.allow is legacy; use channels.slack.accounts.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacySlackChannelAllowAlias),
  },
];

function normalizeSlackEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let entry = params.entry;
  let changed = migrateDmReplyMode(entry, params.pathPrefix, params.changes);
  const threadPolicy = normalizeSlackThreadMentionPolicy({
    value: entry,
    pathPrefix: params.pathPrefix,
    changes: params.changes,
  });
  entry = threadPolicy.value;
  changed = changed || threadPolicy.changed;
  const channels = asObjectRecord(entry.channels);
  if (channels) {
    const normalized = normalizeSlackChannelAllowAliases({
      channels,
      pathPrefix: `${params.pathPrefix}.channels`,
      changes: params.changes,
    });
    if (normalized.changed) {
      entry = { ...entry, channels: normalized.channels };
      changed = true;
    }
  }
  return { entry, changed };
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
