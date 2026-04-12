import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";

type StreamingMode = "off" | "partial" | "block" | "progress";
type TelegramPreviewStreamMode = "off" | "partial" | "block";
type SlackLegacyDraftStreamMode = "replace" | "status_final" | "append";

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function normalizeStreamingMode(value: unknown): string | null {
  return normalizeOptionalLowercaseString(value) ?? null;
}

function parseStreamingMode(value: unknown): StreamingMode | null {
  const normalized = normalizeStreamingMode(value);
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return null;
}

function parseTelegramPreviewStreamMode(value: unknown): TelegramPreviewStreamMode | null {
  const parsed = parseStreamingMode(value);
  if (!parsed) {
    return null;
  }
  return parsed === "progress" ? "partial" : parsed;
}

function parseSlackLegacyDraftStreamMode(value: unknown): SlackLegacyDraftStreamMode | null {
  const normalized = normalizeStreamingMode(value);
  if (normalized === "replace" || normalized === "status_final" || normalized === "append") {
    return normalized;
  }
  return null;
}

function mapSlackLegacyDraftStreamModeToStreaming(mode: SlackLegacyDraftStreamMode): StreamingMode {
  if (mode === "append") {
    return "block";
  }
  if (mode === "status_final") {
    return "progress";
  }
  return "partial";
}

function resolveTelegramPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): TelegramPreviewStreamMode {
  const parsedStreaming = parseStreamingMode(params.streaming);
  if (parsedStreaming) {
    return parsedStreaming === "progress" ? "partial" : parsedStreaming;
  }

  const legacy = parseTelegramPreviewStreamMode(params.streamMode);
  if (legacy) {
    return legacy;
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "partial";
}

function resolveSlackStreamingMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): StreamingMode {
  const parsedStreaming = parseStreamingMode(params.streaming);
  if (parsedStreaming) {
    return parsedStreaming;
  }
  const legacyStreamMode = parseSlackLegacyDraftStreamMode(params.streamMode);
  if (legacyStreamMode) {
    return mapSlackLegacyDraftStreamModeToStreaming(legacyStreamMode);
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "partial";
}

function resolveSlackNativeStreaming(
  params: {
    nativeStreaming?: unknown;
    streaming?: unknown;
  } = {},
): boolean {
  if (typeof params.nativeStreaming === "boolean") {
    return params.nativeStreaming;
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming;
  }
  return true;
}

function hasLegacyThreadBindingTtl(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(threadBindings && hasOwnKey(threadBindings, "ttlHours"));
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

function hasLegacyTelegramStreamingKeys(value: unknown): boolean {
  const entry = getRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    typeof entry.streaming === "string" ||
    hasOwnKey(entry, "chunkMode") ||
    hasOwnKey(entry, "blockStreaming") ||
    hasOwnKey(entry, "draftChunk") ||
    hasOwnKey(entry, "blockStreamingCoalesce")
  );
}

function hasLegacySlackStreamingKeys(value: unknown): boolean {
  const entry = getRecord(value);
  if (!entry) {
    return false;
  }
  return (
    entry.streamMode !== undefined ||
    typeof entry.streaming === "boolean" ||
    typeof entry.streaming === "string" ||
    hasOwnKey(entry, "chunkMode") ||
    hasOwnKey(entry, "blockStreaming") ||
    hasOwnKey(entry, "blockStreamingCoalesce") ||
    hasOwnKey(entry, "nativeStreaming")
  );
}

function ensureNestedRecord(owner: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = getRecord(owner[key]);
  if (existing) {
    return existing;
  }
  const created: Record<string, unknown> = {};
  owner[key] = created;
  return created;
}

function moveLegacyStreamingShapeForPath(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  resolveMode?: (entry: Record<string, unknown>) => string;
  resolveNativeTransport?: (entry: Record<string, unknown>) => boolean;
}): boolean {
  let changed = false;
  const legacyStreaming = params.entry.streaming;
  const legacyStreamingInput = {
    ...params.entry,
    streaming: legacyStreaming,
  };
  const legacyNativeTransportInput = {
    nativeStreaming: params.entry.nativeStreaming,
    streaming: legacyStreaming,
  };
  const hadLegacyStreamMode = hasOwnKey(params.entry, "streamMode");
  const hadLegacyStreamingScalar =
    typeof legacyStreaming === "string" || typeof legacyStreaming === "boolean";

  if (params.resolveMode && (hadLegacyStreamMode || hadLegacyStreamingScalar)) {
    const streaming = ensureNestedRecord(params.entry, "streaming");
    if (!hasOwnKey(streaming, "mode")) {
      const resolvedMode = params.resolveMode(legacyStreamingInput);
      streaming.mode = resolvedMode;
      if (hadLegacyStreamMode) {
        params.changes.push(
          `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming.mode (${resolvedMode}).`,
        );
      }
      if (typeof legacyStreaming === "boolean") {
        params.changes.push(
          `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.mode (${resolvedMode}).`,
        );
      } else if (typeof legacyStreaming === "string") {
        params.changes.push(
          `Moved ${params.pathPrefix}.streaming (scalar) → ${params.pathPrefix}.streaming.mode (${resolvedMode}).`,
        );
      }
    } else {
      params.changes.push(
        `Removed legacy ${params.pathPrefix}.streaming mode aliases (${params.pathPrefix}.streaming.mode already set).`,
      );
    }
    changed = true;
  }

  if (hadLegacyStreamMode) {
    delete params.entry.streamMode;
    changed = true;
  }

  if (hadLegacyStreamingScalar) {
    if (!getRecord(params.entry.streaming)) {
      params.entry.streaming = {};
    }
    changed = true;
  }

  if (hasOwnKey(params.entry, "chunkMode")) {
    const streaming = ensureNestedRecord(params.entry, "streaming");
    if (!hasOwnKey(streaming, "chunkMode")) {
      streaming.chunkMode = params.entry.chunkMode;
      params.changes.push(
        `Moved ${params.pathPrefix}.chunkMode → ${params.pathPrefix}.streaming.chunkMode.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.chunkMode (${params.pathPrefix}.streaming.chunkMode already set).`,
      );
    }
    delete params.entry.chunkMode;
    changed = true;
  }

  if (hasOwnKey(params.entry, "blockStreaming")) {
    const block = ensureNestedRecord(ensureNestedRecord(params.entry, "streaming"), "block");
    if (!hasOwnKey(block, "enabled")) {
      block.enabled = params.entry.blockStreaming;
      params.changes.push(
        `Moved ${params.pathPrefix}.blockStreaming → ${params.pathPrefix}.streaming.block.enabled.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.blockStreaming (${params.pathPrefix}.streaming.block.enabled already set).`,
      );
    }
    delete params.entry.blockStreaming;
    changed = true;
  }

  if (hasOwnKey(params.entry, "draftChunk")) {
    const preview = ensureNestedRecord(ensureNestedRecord(params.entry, "streaming"), "preview");
    if (!hasOwnKey(preview, "chunk")) {
      preview.chunk = params.entry.draftChunk;
      params.changes.push(
        `Moved ${params.pathPrefix}.draftChunk → ${params.pathPrefix}.streaming.preview.chunk.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.draftChunk (${params.pathPrefix}.streaming.preview.chunk already set).`,
      );
    }
    delete params.entry.draftChunk;
    changed = true;
  }

  if (hasOwnKey(params.entry, "blockStreamingCoalesce")) {
    const block = ensureNestedRecord(ensureNestedRecord(params.entry, "streaming"), "block");
    if (!hasOwnKey(block, "coalesce")) {
      block.coalesce = params.entry.blockStreamingCoalesce;
      params.changes.push(
        `Moved ${params.pathPrefix}.blockStreamingCoalesce → ${params.pathPrefix}.streaming.block.coalesce.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.blockStreamingCoalesce (${params.pathPrefix}.streaming.block.coalesce already set).`,
      );
    }
    delete params.entry.blockStreamingCoalesce;
    changed = true;
  }

  if (params.resolveNativeTransport && hasOwnKey(params.entry, "nativeStreaming")) {
    const streaming = ensureNestedRecord(params.entry, "streaming");
    if (!hasOwnKey(streaming, "nativeTransport")) {
      streaming.nativeTransport = params.resolveNativeTransport(legacyNativeTransportInput);
      params.changes.push(
        `Moved ${params.pathPrefix}.nativeStreaming → ${params.pathPrefix}.streaming.nativeTransport.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.nativeStreaming (${params.pathPrefix}.streaming.nativeTransport already set).`,
      );
    }
    delete params.entry.nativeStreaming;
    changed = true;
  } else if (params.resolveNativeTransport && typeof legacyStreaming === "boolean") {
    const streaming = ensureNestedRecord(params.entry, "streaming");
    if (!hasOwnKey(streaming, "nativeTransport")) {
      streaming.nativeTransport = params.resolveNativeTransport(legacyNativeTransportInput);
      params.changes.push(
        `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.streaming.nativeTransport.`,
      );
      changed = true;
    }
  }

  return changed;
}

function hasLegacyGoogleChatStreamMode(value: unknown): boolean {
  const entry = getRecord(value);
  if (!entry) {
    return false;
  }
  return entry.streamMode !== undefined;
}

function hasLegacyKeysInAccounts(
  value: unknown,
  matchEntry: (entry: Record<string, unknown>) => boolean,
): boolean {
  const accounts = getRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((entry) => matchEntry(getRecord(entry) ?? {}));
}

function hasLegacyAllowAlias(entry: Record<string, unknown>): boolean {
  return hasOwnKey(entry, "allow");
}

function migrateAllowAliasForPath(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  if (!hasLegacyAllowAlias(params.entry)) {
    return false;
  }

  const legacyAllow = params.entry.allow;
  const hadEnabled = params.entry.enabled !== undefined;
  if (!hadEnabled) {
    params.entry.enabled = legacyAllow;
  }
  delete params.entry.allow;

  if (hadEnabled) {
    params.changes.push(
      `Removed ${params.pathPrefix}.allow (${params.pathPrefix}.enabled already set).`,
    );
  } else {
    params.changes.push(`Moved ${params.pathPrefix}.allow → ${params.pathPrefix}.enabled.`);
  }
  return true;
}

function hasLegacySlackChannelAllowAlias(value: unknown): boolean {
  const entry = getRecord(value);
  const channels = getRecord(entry?.channels);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((channel) => hasLegacyAllowAlias(getRecord(channel) ?? {}));
}

function hasLegacyGoogleChatGroupAllowAlias(value: unknown): boolean {
  const entry = getRecord(value);
  const groups = getRecord(entry?.groups);
  if (!groups) {
    return false;
  }
  return Object.values(groups).some((group) => hasLegacyAllowAlias(getRecord(group) ?? {}));
}

function hasLegacyDiscordGuildChannelAllowAlias(value: unknown): boolean {
  const entry = getRecord(value);
  const guilds = getRecord(entry?.guilds);
  if (!guilds) {
    return false;
  }
  return Object.values(guilds).some((guildValue) => {
    const channels = getRecord(getRecord(guildValue)?.channels);
    if (!channels) {
      return false;
    }
    return Object.values(channels).some((channel) => hasLegacyAllowAlias(getRecord(channel) ?? {}));
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
];

const CHANNEL_STREAMING_RULES: LegacyConfigRule[] = [
  {
    path: ["channels", "telegram"],
    message:
      'channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce} instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTelegramStreamingKeys(value),
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      'channels.telegram.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce} instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyKeysInAccounts(value, hasLegacyTelegramStreamingKeys),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.streamMode, channels.slack.streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport} instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacySlackStreamingKeys(value),
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.accounts.<id>.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport} instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyKeysInAccounts(value, hasLegacySlackStreamingKeys),
  },
];

const CHANNEL_ENABLED_ALIAS_RULES: LegacyConfigRule[] = [
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.channels.<id>.allow is legacy; use channels.slack.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacySlackChannelAllowAlias(value),
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.channels.<id>.allow is legacy; use channels.slack.accounts.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyKeysInAccounts(value, hasLegacySlackChannelAllowAlias),
  },
  {
    path: ["channels", "googlechat"],
    message:
      'channels.googlechat.groups.<id>.allow is legacy; use channels.googlechat.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyGoogleChatGroupAllowAlias(value),
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      'channels.googlechat.accounts.<id>.groups.<id>.allow is legacy; use channels.googlechat.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyKeysInAccounts(value, hasLegacyGoogleChatGroupAllowAlias),
  },
  {
    path: ["channels", "discord"],
    message:
      'channels.discord.guilds.<id>.channels.<id>.allow is legacy; use channels.discord.guilds.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyDiscordGuildChannelAllowAlias(value),
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      'channels.discord.accounts.<id>.guilds.<id>.channels.<id>.allow is legacy; use channels.discord.accounts.<id>.guilds.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyKeysInAccounts(value, hasLegacyDiscordGuildChannelAllowAlias),
  },
];

const GOOGLECHAT_STREAMMODE_RULES: LegacyConfigRule[] = [
  {
    path: ["channels", "googlechat"],
    message: "channels.googlechat.streamMode is legacy and no longer used; it is removed on load.",
    match: (value) => hasLegacyGoogleChatStreamMode(value),
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      "channels.googlechat.accounts.<id>.streamMode is legacy and no longer used; it is removed on load.",
    match: (value) => hasLegacyKeysInAccounts(value, hasLegacyGoogleChatStreamMode),
  },
];

export const LEGACY_CONFIG_MIGRATIONS_CHANNELS: LegacyConfigMigrationSpec[] = [
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
            accounts[accountId] = account;
          }
          channel.accounts = accounts;
        }
        channels[channelId] = channel;
      }
      raw.channels = channels;
    },
  }),
  defineLegacyConfigMigration({
    id: "channels.streaming-keys->channels.streaming",
    describe: "Normalize legacy streaming keys to channels.<provider>.streaming (Telegram/Slack)",
    legacyRules: CHANNEL_STREAMING_RULES,
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      const migrateProviderEntry = (params: {
        provider: "telegram" | "discord" | "slack";
        entry: Record<string, unknown>;
        pathPrefix: string;
      }) => {
        if (params.provider === "telegram") {
          moveLegacyStreamingShapeForPath({
            entry: params.entry,
            pathPrefix: params.pathPrefix,
            changes,
            resolveMode: resolveTelegramPreviewStreamMode,
          });
          return;
        }

        moveLegacyStreamingShapeForPath({
          entry: params.entry,
          pathPrefix: params.pathPrefix,
          changes,
          resolveMode: resolveSlackStreamingMode,
          resolveNativeTransport: resolveSlackNativeStreaming,
        });
      };

      const migrateProvider = (provider: "telegram" | "slack") => {
        const providerEntry = getRecord(channels[provider]);
        if (!providerEntry) {
          return;
        }
        migrateProviderEntry({
          provider,
          entry: providerEntry,
          pathPrefix: `channels.${provider}`,
        });
        const accounts = getRecord(providerEntry.accounts);
        if (!accounts) {
          return;
        }
        for (const [accountId, accountValue] of Object.entries(accounts)) {
          const account = getRecord(accountValue);
          if (!account) {
            continue;
          }
          migrateProviderEntry({
            provider,
            entry: account,
            pathPrefix: `channels.${provider}.accounts.${accountId}`,
          });
        }
      };

      migrateProvider("telegram");
      migrateProvider("slack");
    },
  }),
  defineLegacyConfigMigration({
    id: "channels.allow->channels.enabled",
    describe:
      "Normalize legacy nested channel allow toggles to enabled (Slack/Google Chat/Discord)",
    legacyRules: CHANNEL_ENABLED_ALIAS_RULES,
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      const migrateSlackEntry = (entry: Record<string, unknown>, pathPrefix: string) => {
        const channelEntries = getRecord(entry.channels);
        if (!channelEntries) {
          return;
        }
        for (const [channelId, channelRaw] of Object.entries(channelEntries)) {
          const channel = getRecord(channelRaw);
          if (!channel) {
            continue;
          }
          migrateAllowAliasForPath({
            entry: channel,
            pathPrefix: `${pathPrefix}.channels.${channelId}`,
            changes,
          });
          channelEntries[channelId] = channel;
        }
        entry.channels = channelEntries;
      };

      const migrateGoogleChatEntry = (entry: Record<string, unknown>, pathPrefix: string) => {
        const groups = getRecord(entry.groups);
        if (!groups) {
          return;
        }
        for (const [groupId, groupRaw] of Object.entries(groups)) {
          const group = getRecord(groupRaw);
          if (!group) {
            continue;
          }
          migrateAllowAliasForPath({
            entry: group,
            pathPrefix: `${pathPrefix}.groups.${groupId}`,
            changes,
          });
          groups[groupId] = group;
        }
        entry.groups = groups;
      };

      const migrateDiscordEntry = (entry: Record<string, unknown>, pathPrefix: string) => {
        const guilds = getRecord(entry.guilds);
        if (!guilds) {
          return;
        }
        for (const [guildId, guildRaw] of Object.entries(guilds)) {
          const guild = getRecord(guildRaw);
          if (!guild) {
            continue;
          }
          const channelEntries = getRecord(guild.channels);
          if (!channelEntries) {
            guilds[guildId] = guild;
            continue;
          }
          for (const [channelId, channelRaw] of Object.entries(channelEntries)) {
            const channel = getRecord(channelRaw);
            if (!channel) {
              continue;
            }
            migrateAllowAliasForPath({
              entry: channel,
              pathPrefix: `${pathPrefix}.guilds.${guildId}.channels.${channelId}`,
              changes,
            });
            channelEntries[channelId] = channel;
          }
          guild.channels = channelEntries;
          guilds[guildId] = guild;
        }
        entry.guilds = guilds;
      };

      const migrateProviderAccounts = (
        provider: "slack" | "googlechat" | "discord",
        migrateEntry: (entry: Record<string, unknown>, pathPrefix: string) => void,
      ) => {
        const providerEntry = getRecord(channels[provider]);
        if (!providerEntry) {
          return;
        }
        migrateEntry(providerEntry, `channels.${provider}`);
        const accounts = getRecord(providerEntry.accounts);
        if (!accounts) {
          channels[provider] = providerEntry;
          return;
        }
        for (const [accountId, accountRaw] of Object.entries(accounts)) {
          const account = getRecord(accountRaw);
          if (!account) {
            continue;
          }
          migrateEntry(account, `channels.${provider}.accounts.${accountId}`);
          accounts[accountId] = account;
        }
        providerEntry.accounts = accounts;
        channels[provider] = providerEntry;
      };

      migrateProviderAccounts("slack", migrateSlackEntry);
      migrateProviderAccounts("googlechat", migrateGoogleChatEntry);
      migrateProviderAccounts("discord", migrateDiscordEntry);
      raw.channels = channels;
    },
  }),
  defineLegacyConfigMigration({
    id: "channels.googlechat.streamMode->remove",
    describe: "Remove legacy Google Chat streamMode keys that are no longer used",
    legacyRules: GOOGLECHAT_STREAMMODE_RULES,
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      const migrateEntry = (entry: Record<string, unknown>, pathPrefix: string) => {
        if (entry.streamMode === undefined) {
          return;
        }
        delete entry.streamMode;
        changes.push(`Removed ${pathPrefix}.streamMode (legacy key no longer used).`);
      };

      const googlechat = getRecord(channels.googlechat);
      if (!googlechat) {
        return;
      }

      migrateEntry(googlechat, "channels.googlechat");

      const accounts = getRecord(googlechat.accounts);
      if (accounts) {
        for (const [accountId, accountValue] of Object.entries(accounts)) {
          const account = getRecord(accountValue);
          if (!account) {
            continue;
          }
          migrateEntry(account, `channels.googlechat.accounts.${accountId}`);
          accounts[accountId] = account;
        }
        googlechat.accounts = accounts;
      }

      channels.googlechat = googlechat;
      raw.channels = channels;
    },
  }),
];
