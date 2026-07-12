// Telegram plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyChannelAliases,
  resolveLegacyAliasStreamingMode,
} from "openclaw/plugin-sdk/runtime-doctor";

function hasLegacyTelegramStreamingAliases(value: unknown): boolean {
  return hasLegacyStreamingAliases(value, { includePreviewChunk: true });
}

function hasRetiredTelegramDmConfig(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  if (asObjectRecord(entry.dm)) {
    return true;
  }
  return Object.values(asObjectRecord(entry.direct) ?? {}).some(
    (direct) => asObjectRecord(direct)?.threadReplies !== undefined,
  );
}

function hasRetiredTelegramAccountDmConfig(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasRetiredTelegramDmConfig(account));
}

function hasRetiredTelegramNativeDraftConfig(value: unknown): boolean {
  const entry = asObjectRecord(value);
  const streaming = asObjectRecord(entry?.streaming);
  const preview = asObjectRecord(streaming?.preview);
  return (
    preview?.nativeToolProgress !== undefined || preview?.nativeToolProgressAllowFrom !== undefined
  );
}

function hasRetiredTelegramGroupHistoryContextConfig(value: unknown): boolean {
  return asObjectRecord(value)?.includeGroupHistoryContext !== undefined;
}

function hasRetiredTelegramAccountNativeDraftConfig(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasRetiredTelegramNativeDraftConfig(account));
}

function hasRetiredTelegramAccountGroupHistoryContextConfig(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) =>
    hasRetiredTelegramGroupHistoryContextConfig(account),
  );
}

function removeRetiredTelegramDmConfig(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  let changed = false;
  const dm = asObjectRecord(updated.dm);
  if (dm) {
    const { dm: _ignored, ...rest } = updated;
    updated = rest;
    params.changes.push(
      dm.threadReplies === undefined
        ? `Removed ${params.pathPrefix}.dm.`
        : `Removed ${params.pathPrefix}.dm.threadReplies; DM topic sessions now follow Telegram getMe.has_topics_enabled.`,
    );
    changed = true;
  }

  const direct = asObjectRecord(updated.direct);
  if (direct) {
    let directChanged = false;
    const nextDirect = { ...direct };
    for (const [chatId, rawDirectConfig] of Object.entries(direct)) {
      const directConfig = asObjectRecord(rawDirectConfig);
      if (!directConfig || directConfig.threadReplies === undefined) {
        continue;
      }
      const nextDirectConfig = { ...directConfig };
      delete nextDirectConfig.threadReplies;
      nextDirect[chatId] = nextDirectConfig;
      params.changes.push(
        `Removed ${params.pathPrefix}.direct.${chatId}.threadReplies; DM topic sessions now follow Telegram getMe.has_topics_enabled.`,
      );
      directChanged = true;
    }
    if (directChanged) {
      updated = { ...updated, direct: nextDirect };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

function removeRetiredTelegramNativeDraftConfig(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const streaming = asObjectRecord(params.entry.streaming);
  const preview = asObjectRecord(streaming?.preview);
  if (
    !streaming ||
    !preview ||
    (preview.nativeToolProgress === undefined && preview.nativeToolProgressAllowFrom === undefined)
  ) {
    return { entry: params.entry, changed: false };
  }

  const nextPreview = { ...preview };
  delete nextPreview.nativeToolProgress;
  delete nextPreview.nativeToolProgressAllowFrom;
  const nextStreaming = { ...streaming };
  if (Object.keys(nextPreview).length > 0) {
    nextStreaming.preview = nextPreview;
  } else {
    delete nextStreaming.preview;
  }

  const updated =
    Object.keys(nextStreaming).length > 0
      ? { ...params.entry, streaming: nextStreaming }
      : Object.fromEntries(Object.entries(params.entry).filter(([key]) => key !== "streaming"));
  params.changes.push(
    `Removed ${params.pathPrefix}.streaming.preview native draft keys; Telegram previews now use rich send/edit messages.`,
  );
  return { entry: updated, changed: true };
}

function removeRetiredTelegramGroupHistoryContextConfig(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  preserveRecentHistoryLimit?: number;
}): { entry: Record<string, unknown>; changed: boolean } {
  if (params.entry.includeGroupHistoryContext === undefined) {
    return { entry: params.entry, changed: false };
  }
  const { includeGroupHistoryContext, ...rest } = params.entry;
  let updated = includeGroupHistoryContext === "none" ? { ...rest, historyLimit: 0 } : rest;
  if (
    includeGroupHistoryContext === "recent" &&
    params.preserveRecentHistoryLimit !== undefined &&
    updated.historyLimit === undefined
  ) {
    updated = { ...updated, historyLimit: params.preserveRecentHistoryLimit };
  }
  const historyLimitNote =
    includeGroupHistoryContext === "none"
      ? " and set historyLimit to 0"
      : includeGroupHistoryContext === "recent" &&
          params.preserveRecentHistoryLimit !== undefined &&
          params.entry.historyLimit === undefined
        ? ` and set historyLimit to ${params.preserveRecentHistoryLimit}`
        : "";
  params.changes.push(
    `Removed ${params.pathPrefix}.includeGroupHistoryContext${historyLimitNote}; Telegram group history is always on for groups and bounded by historyLimit.`,
  );
  return { entry: updated, changed: true };
}

function resolveCompatibleDefaultGroupEntry(section: Record<string, unknown>): {
  groups: Record<string, unknown>;
  entry: Record<string, unknown>;
} | null {
  const existingGroups = section.groups;
  if (existingGroups !== undefined && !asObjectRecord(existingGroups)) {
    return null;
  }
  const groups = asObjectRecord(existingGroups) ?? {};
  const defaultKey = "*";
  const existingEntry = groups[defaultKey];
  if (existingEntry !== undefined && !asObjectRecord(existingEntry)) {
    return null;
  }
  const entry = asObjectRecord(existingEntry) ?? {};
  return { groups, entry };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "telegram", "groupMentionsOnly"],
    message:
      'channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups."*".requireMention instead. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "telegram"],
    message:
      'channels.telegram.dm and direct.<chatId>.threadReplies were removed; DM topic sessions now follow Telegram getMe.has_topics_enabled, so topics-enabled bots may use thread-scoped DM sessions. Run "openclaw doctor --fix".',
    match: hasRetiredTelegramDmConfig,
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      'channels.telegram.accounts.<id>.dm and direct.<chatId>.threadReplies were removed; DM topic sessions now follow Telegram getMe.has_topics_enabled, so topics-enabled bots may use thread-scoped DM sessions. Run "openclaw doctor --fix".',
    match: hasRetiredTelegramAccountDmConfig,
  },
  {
    path: ["channels", "telegram"],
    message:
      'channels.telegram.streaming.preview.nativeToolProgress and nativeToolProgressAllowFrom were removed; Telegram previews now use rich send/edit messages. Run "openclaw doctor --fix".',
    match: hasRetiredTelegramNativeDraftConfig,
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      'channels.telegram.accounts.<id>.streaming.preview.nativeToolProgress and nativeToolProgressAllowFrom were removed; Telegram previews now use rich send/edit messages. Run "openclaw doctor --fix".',
    match: hasRetiredTelegramAccountNativeDraftConfig,
  },
  {
    path: ["channels", "telegram"],
    message:
      'channels.telegram.includeGroupHistoryContext was removed; Telegram group history is always on for groups and bounded by historyLimit. Run "openclaw doctor --fix".',
    match: hasRetiredTelegramGroupHistoryContextConfig,
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      'channels.telegram.accounts.<id>.includeGroupHistoryContext was removed; Telegram group history is always on for groups and bounded by historyLimit. Run "openclaw doctor --fix".',
    match: hasRetiredTelegramAccountGroupHistoryContextConfig,
  },
  {
    path: ["channels", "telegram"],
    message:
      "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: hasLegacyTelegramStreamingAliases,
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      "channels.telegram.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyTelegramStreamingAliases),
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.telegram);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;
  const rootGroupHistoryContextMode = updated.includeGroupHistoryContext;
  const rootGroupHistoryLimitBeforeMigration =
    typeof updated.historyLimit === "number"
      ? updated.historyLimit
      : (cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT);

  const removedThreadReplies = removeRetiredTelegramDmConfig({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
  });
  updated = removedThreadReplies.entry;
  changed = changed || removedThreadReplies.changed;

  const removedNativeDraft = removeRetiredTelegramNativeDraftConfig({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
  });
  updated = removedNativeDraft.entry;
  changed = changed || removedNativeDraft.changed;

  const removedGroupHistoryContext = removeRetiredTelegramGroupHistoryContextConfig({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
  });
  updated = removedGroupHistoryContext.entry;
  changed = changed || removedGroupHistoryContext.changed;

  if (updated.groupMentionsOnly !== undefined) {
    const defaultGroupEntry = resolveCompatibleDefaultGroupEntry(updated);
    if (!defaultGroupEntry) {
      changes.push(
        "Skipped channels.telegram.groupMentionsOnly migration because channels.telegram.groups already has an incompatible shape; fix remaining issues manually.",
      );
    } else {
      const { groups, entry } = defaultGroupEntry;
      if (entry.requireMention === undefined) {
        entry.requireMention = updated.groupMentionsOnly;
        groups["*"] = entry;
        updated = { ...updated, groups };
        changes.push(
          'Moved channels.telegram.groupMentionsOnly → channels.telegram.groups."*".requireMention.',
        );
      } else {
        changes.push(
          'Removed channels.telegram.groupMentionsOnly (channels.telegram.groups."*" already set).',
        );
      }
      const { groupMentionsOnly: _ignored, ...rest } = updated;
      updated = rest;
      changed = true;
    }
  }

  const aliases = normalizeLegacyChannelAliases({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
    resolveStreamingOptions: (entry) => ({
      includePreviewChunk: true,
      // Runtime mode resolution dropped legacy streamMode reads; the doctor
      // resolver keeps them so migration preserves configured intent.
      resolvedMode: resolveLegacyAliasStreamingMode(entry, "partial"),
    }),
  });
  updated = aliases.entry;
  changed = changed || aliases.changed;

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      const accountRemovedThreadReplies = removeRetiredTelegramDmConfig({
        entry: account,
        pathPrefix: `channels.telegram.accounts.${accountId}`,
        changes,
      });
      if (accountRemovedThreadReplies.changed) {
        nextAccounts[accountId] = accountRemovedThreadReplies.entry;
        accountsChanged = true;
      }
      const accountRemovedNativeDraft = removeRetiredTelegramNativeDraftConfig({
        entry: nextAccounts[accountId] as Record<string, unknown>,
        pathPrefix: `channels.telegram.accounts.${accountId}`,
        changes,
      });
      if (accountRemovedNativeDraft.changed) {
        nextAccounts[accountId] = accountRemovedNativeDraft.entry;
        accountsChanged = true;
      }
      const accountRemovedGroupHistoryContext = removeRetiredTelegramGroupHistoryContextConfig({
        entry: nextAccounts[accountId] as Record<string, unknown>,
        pathPrefix: `channels.telegram.accounts.${accountId}`,
        changes,
        ...(rootGroupHistoryContextMode === "none"
          ? { preserveRecentHistoryLimit: rootGroupHistoryLimitBeforeMigration }
          : {}),
      });
      if (accountRemovedGroupHistoryContext.changed) {
        nextAccounts[accountId] = accountRemovedGroupHistoryContext.entry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed && changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        telegram: updated as unknown as NonNullable<OpenClawConfig["channels"]>["telegram"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}
