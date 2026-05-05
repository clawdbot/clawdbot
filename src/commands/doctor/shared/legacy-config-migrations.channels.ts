import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function cleanupEmptyRecord(parent: Record<string, unknown>, key: string): void {
  const value = getRecord(parent[key]);
  if (value && Object.keys(value).length === 0) {
    delete parent[key];
  }
}

function resolveCompatibleDefaultGroupEntry(section: Record<string, unknown>): {
  groups: Record<string, unknown>;
  entry: Record<string, unknown>;
} | null {
  const existingGroups = section.groups;
  if (existingGroups !== undefined && !getRecord(existingGroups)) {
    return null;
  }
  const groups = getRecord(existingGroups) ?? {};
  const defaultKey = "*";
  const existingEntry = groups[defaultKey];
  if (existingEntry !== undefined && !getRecord(existingEntry)) {
    return null;
  }
  const entry = getRecord(existingEntry) ?? {};
  return { groups, entry };
}

function migrateChannelDefaultRequireMention(params: {
  section: Record<string, unknown>;
  channelId: string;
  legacyPath: string;
  requireMention: unknown;
  changes: string[];
}): boolean {
  const defaultGroupEntry = resolveCompatibleDefaultGroupEntry(params.section);
  if (!defaultGroupEntry) {
    params.changes.push(
      `Removed ${params.legacyPath} (channels.${params.channelId}.groups has an incompatible shape; fix remaining issues manually).`,
    );
    return false;
  }

  const { groups, entry } = defaultGroupEntry;
  if (entry.requireMention === undefined) {
    entry.requireMention = params.requireMention;
    groups["*"] = entry;
    params.section.groups = groups;
    params.changes.push(
      `Moved ${params.legacyPath} → channels.${params.channelId}.groups."*".requireMention.`,
    );
    return true;
  }

  params.changes.push(
    `Removed ${params.legacyPath} (channels.${params.channelId}.groups."*" already set).`,
  );
  return false;
}

function migrateRoutingAllowFrom(raw: Record<string, unknown>, changes: string[]): void {
  const routing = getRecord(raw.routing);
  if (!routing || routing.allowFrom === undefined) {
    return;
  }

  const channels = getRecord(raw.channels);
  const whatsapp = getRecord(channels?.whatsapp);
  if (!channels || !whatsapp) {
    delete routing.allowFrom;
    cleanupEmptyRecord(raw, "routing");
    changes.push("Removed routing.allowFrom (channels.whatsapp not configured).");
    return;
  }

  if (whatsapp.allowFrom === undefined) {
    whatsapp.allowFrom = routing.allowFrom;
    changes.push("Moved routing.allowFrom → channels.whatsapp.allowFrom.");
  } else {
    changes.push("Removed routing.allowFrom (channels.whatsapp.allowFrom already set).");
  }

  delete routing.allowFrom;
  channels.whatsapp = whatsapp;
  raw.channels = channels;
  cleanupEmptyRecord(raw, "routing");
}

function migrateRoutingGroupChatMessages(params: {
  raw: Record<string, unknown>;
  routing: Record<string, unknown>;
  groupChat: Record<string, unknown>;
  changes: string[];
}): void {
  const migrateMessageGroupField = (field: "historyLimit" | "mentionPatterns") => {
    const value = params.groupChat[field];
    if (value === undefined) {
      return;
    }

    const messages = ensureRecord(params.raw, "messages");
    const messagesGroup = ensureRecord(messages, "groupChat");
    if (messagesGroup[field] === undefined) {
      messagesGroup[field] = value;
      params.changes.push(`Moved routing.groupChat.${field} → messages.groupChat.${field}.`);
    } else {
      params.changes.push(
        `Removed routing.groupChat.${field} (messages.groupChat.${field} already set).`,
      );
    }
    delete params.groupChat[field];
  };

  migrateMessageGroupField("historyLimit");
  migrateMessageGroupField("mentionPatterns");

  if (Object.keys(params.groupChat).length === 0) {
    delete params.routing.groupChat;
  } else {
    params.routing.groupChat = params.groupChat;
  }
}

function migrateRoutingGroupChatRequireMention(params: {
  raw: Record<string, unknown>;
  groupChat: Record<string, unknown>;
  changes: string[];
}): void {
  const requireMention = params.groupChat.requireMention;
  if (requireMention === undefined) {
    return;
  }

  const channels = getRecord(params.raw.channels);
  let matchedChannel = false;
  if (channels) {
    for (const channelId of ["whatsapp", "telegram", "imessage"]) {
      const section = getRecord(channels[channelId]);
      if (!section) {
        continue;
      }
      matchedChannel = true;
      migrateChannelDefaultRequireMention({
        section,
        channelId,
        legacyPath: "routing.groupChat.requireMention",
        requireMention,
        changes: params.changes,
      });
      channels[channelId] = section;
    }
    params.raw.channels = channels;
  }

  if (!matchedChannel) {
    params.changes.push(
      "Removed routing.groupChat.requireMention (no configured WhatsApp, Telegram, or iMessage channel found).",
    );
  }
  delete params.groupChat.requireMention;
}

function migrateRoutingGroupChat(raw: Record<string, unknown>, changes: string[]): void {
  const routing = getRecord(raw.routing);
  const groupChat = getRecord(routing?.groupChat);
  if (!routing || !groupChat) {
    return;
  }

  migrateRoutingGroupChatRequireMention({ raw, groupChat, changes });
  migrateRoutingGroupChatMessages({ raw, routing, groupChat, changes });
  cleanupEmptyRecord(raw, "routing");
}

function migrateTelegramRequireMention(raw: Record<string, unknown>, changes: string[]): void {
  const channels = getRecord(raw.channels);
  const telegram = getRecord(channels?.telegram);
  if (!channels || !telegram || telegram.requireMention === undefined) {
    return;
  }

  migrateChannelDefaultRequireMention({
    section: telegram,
    channelId: "telegram",
    legacyPath: "channels.telegram.requireMention",
    requireMention: telegram.requireMention,
    changes,
  });
  delete telegram.requireMention;
  channels.telegram = telegram;
  raw.channels = channels;
}

function hasLegacyThreadBindingTtl(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(threadBindings && hasOwnKey(threadBindings, "ttlHours"));
}

function hasLegacyThreadBindingSpawnSplit(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(
    threadBindings &&
    (hasOwnKey(threadBindings, "spawnSubagentSessions") ||
      hasOwnKey(threadBindings, "spawnAcpSessions")),
  );
}

function hasLegacyThreadBindingTtlInAccounts(value: unknown): boolean {
  const accounts = getRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((entry) =>
    hasLegacyThreadBindingTtl(getRecord(entry)?.threadBindings),
  );
}

function hasLegacyThreadBindingSpawnSplitInAccounts(value: unknown): boolean {
  const accounts = getRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((entry) =>
    hasLegacyThreadBindingSpawnSplit(getRecord(entry)?.threadBindings),
  );
}

function migrateThreadBindingsTtlHoursForPath(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) {
    return false;
  }

  const hadIdleHours = threadBindings.idleHours !== undefined;
  if (!hadIdleHours) {
    threadBindings.idleHours = threadBindings.ttlHours;
  }
  delete threadBindings.ttlHours;
  params.owner.threadBindings = threadBindings;

  if (hadIdleHours) {
    params.changes.push(
      `Removed ${params.pathPrefix}.threadBindings.ttlHours (${params.pathPrefix}.threadBindings.idleHours already set).`,
    );
  } else {
    params.changes.push(
      `Moved ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours.`,
    );
  }
  return true;
}

function resolveMigratedSpawnSessions(
  threadBindings: Record<string, unknown>,
): boolean | undefined {
  const subagent = threadBindings.spawnSubagentSessions;
  const acp = threadBindings.spawnAcpSessions;
  const subagentBool = typeof subagent === "boolean" ? subagent : undefined;
  const acpBool = typeof acp === "boolean" ? acp : undefined;
  if (subagentBool === undefined) {
    return acpBool;
  }
  if (acpBool === undefined) {
    return subagentBool;
  }
  return subagentBool && acpBool;
}

function migrateThreadBindingsSpawnSessionsForPath(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasLegacyThreadBindingSpawnSplit(threadBindings)) {
    return false;
  }

  const hadSpawnSessions = threadBindings.spawnSessions !== undefined;
  const resolved = resolveMigratedSpawnSessions(threadBindings);
  const oldSubagent = threadBindings.spawnSubagentSessions;
  const oldAcp = threadBindings.spawnAcpSessions;
  delete threadBindings.spawnSubagentSessions;
  delete threadBindings.spawnAcpSessions;
  if (!hadSpawnSessions && resolved !== undefined) {
    threadBindings.spawnSessions = resolved;
  }
  params.owner.threadBindings = threadBindings;

  if (hadSpawnSessions) {
    params.changes.push(
      `Removed deprecated ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions (${params.pathPrefix}.threadBindings.spawnSessions already set).`,
    );
  } else if (
    typeof oldSubagent === "boolean" &&
    typeof oldAcp === "boolean" &&
    oldSubagent !== oldAcp
  ) {
    params.changes.push(
      `Collapsed conflicting ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`,
    );
  } else {
    params.changes.push(
      `Moved ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`,
    );
  }
  return true;
}

function hasLegacyThreadBindingTtlInAnyChannel(value: unknown): boolean {
  const channels = getRecord(value);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((entry) => {
    const channel = getRecord(entry);
    if (!channel) {
      return false;
    }
    return (
      hasLegacyThreadBindingTtl(channel.threadBindings) ||
      hasLegacyThreadBindingTtlInAccounts(channel.accounts)
    );
  });
}

function hasLegacyThreadBindingSpawnSplitInAnyChannel(value: unknown): boolean {
  const channels = getRecord(value);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((entry) => {
    const channel = getRecord(entry);
    if (!channel) {
      return false;
    }
    return (
      hasLegacyThreadBindingSpawnSplit(channel.threadBindings) ||
      hasLegacyThreadBindingSpawnSplitInAccounts(channel.accounts)
    );
  });
}

const THREAD_BINDING_RULES: LegacyConfigRule[] = [
  {
    path: ["session", "threadBindings"],
    message:
      'session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingTtl(value),
  },
  {
    path: ["channels"],
    message:
      'channels.<id>.threadBindings.ttlHours was renamed to channels.<id>.threadBindings.idleHours. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingTtlInAnyChannel(value),
  },
  {
    path: ["session", "threadBindings"],
    message:
      'session.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by session.threadBindings.spawnSessions. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingSpawnSplit(value),
  },
  {
    path: ["channels"],
    message:
      'channels.<id>.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by channels.<id>.threadBindings.spawnSessions. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingSpawnSplitInAnyChannel(value),
  },
];

const GROUP_ROUTING_RULES: LegacyConfigRule[] = [
  {
    path: ["routing", "allowFrom"],
    message:
      'routing.allowFrom was removed; use channels.whatsapp.allowFrom instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["routing", "groupChat", "requireMention"],
    message:
      'routing.groupChat.requireMention was removed; use channels.<channel>.groups."*".requireMention instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["routing", "groupChat", "historyLimit"],
    message:
      'routing.groupChat.historyLimit was moved; use messages.groupChat.historyLimit instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["routing", "groupChat", "mentionPatterns"],
    message:
      'routing.groupChat.mentionPatterns was moved; use messages.groupChat.mentionPatterns instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "telegram", "requireMention"],
    message:
      'channels.telegram.requireMention was removed; use channels.telegram.groups."*".requireMention instead. Run "openclaw doctor --fix".',
  },
];

export const LEGACY_CONFIG_MIGRATIONS_CHANNELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "legacy-group-routing->channel-groups",
    describe:
      "Move legacy routing group chat settings to current channel group and messages config",
    legacyRules: GROUP_ROUTING_RULES,
    apply: (raw, changes) => {
      migrateRoutingAllowFrom(raw, changes);
      migrateRoutingGroupChat(raw, changes);
      migrateTelegramRequireMention(raw, changes);
    },
  }),
  defineLegacyConfigMigration({
    id: "thread-bindings.ttlHours->idleHours",
    describe:
      "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channel configs)",
    legacyRules: THREAD_BINDING_RULES,
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (session) {
        migrateThreadBindingsTtlHoursForPath({
          owner: session,
          pathPrefix: "session",
          changes,
        });
        migrateThreadBindingsSpawnSessionsForPath({
          owner: session,
          pathPrefix: "session",
          changes,
        });
        raw.session = session;
      }

      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      for (const [channelId, channelRaw] of Object.entries(channels)) {
        const channel = getRecord(channelRaw);
        if (!channel) {
          continue;
        }
        migrateThreadBindingsTtlHoursForPath({
          owner: channel,
          pathPrefix: `channels.${channelId}`,
          changes,
        });
        migrateThreadBindingsSpawnSessionsForPath({
          owner: channel,
          pathPrefix: `channels.${channelId}`,
          changes,
        });

        const accounts = getRecord(channel.accounts);
        if (accounts) {
          for (const [accountId, accountRaw] of Object.entries(accounts)) {
            const account = getRecord(accountRaw);
            if (!account) {
              continue;
            }
            migrateThreadBindingsTtlHoursForPath({
              owner: account,
              pathPrefix: `channels.${channelId}.accounts.${accountId}`,
              changes,
            });
            migrateThreadBindingsSpawnSessionsForPath({
              owner: account,
              pathPrefix: `channels.${channelId}.accounts.${accountId}`,
              changes,
            });
            accounts[accountId] = account;
          }
          channel.accounts = accounts;
        }
        channels[channelId] = channel;
      }
      raw.channels = channels;
    },
  }),
];
