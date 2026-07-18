// Slack plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord, defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";
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
      'channels.slack.thread.requireExplicitMention is legacy; use channels.slack.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: hasLegacySlackThreadMentionPolicy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.thread.requireExplicitMention is legacy; use channels.slack.accounts.<id>.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: (value) => {
      const accounts = asObjectRecord(value);
      return Boolean(
        accounts &&
        Object.values(accounts).some((account) => hasLegacySlackThreadMentionPolicy(account)),
      );
    },
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
    match: (value) => {
      const accounts = asObjectRecord(value);
      if (!accounts) {
        return false;
      }
      return Object.values(accounts).some((account) => hasLegacySlackChannelAllowAlias(account));
    },
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg, changes });
  const rawEntry = asObjectRecord(
    (aliases.config.channels as Record<string, unknown> | undefined)?.slack,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }
  let updated = rawEntry;
  let changed = aliases.config !== cfg;

  const normalizedThreadPolicy = normalizeSlackThreadMentionPolicy({
    value: updated,
    pathPrefix: "channels.slack",
    changes,
  });
  if (normalizedThreadPolicy.changed) {
    updated = normalizedThreadPolicy.value;
    changed = true;
  }

  const channels = asObjectRecord(updated.channels);
  if (channels) {
    const normalized = normalizeSlackChannelAllowAliases({
      channels,
      pathPrefix: "channels.slack.channels",
      changes,
    });
    if (normalized.changed) {
      updated = { ...updated, channels: normalized.channels };
      changed = true;
    }
  }

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      let account = asObjectRecord(accountValue);
      if (!account) {
        continue;
      }
      const normalizedAccountThreadPolicy = normalizeSlackThreadMentionPolicy({
        value: account,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
      });
      if (normalizedAccountThreadPolicy.changed) {
        account = normalizedAccountThreadPolicy.value;
        nextAccounts[accountId] = account;
        accountsChanged = true;
      }
      const channelEntries = asObjectRecord(account.channels);
      if (channelEntries) {
        const normalized = normalizeSlackChannelAllowAliases({
          channels: channelEntries,
          pathPrefix: `channels.slack.accounts.${accountId}.channels`,
          changes,
        });
        if (normalized.changed) {
          nextAccounts[accountId] = { ...account, channels: normalized.channels };
          accountsChanged = true;
        }
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...aliases.config,
      channels: {
        ...aliases.config.channels,
        slack: updated as unknown as NonNullable<OpenClawConfig["channels"]>["slack"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}
