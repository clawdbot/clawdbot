import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyChannelAliases,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveTelegramPreviewStreamMode } from "./preview-streaming.js";

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

  const removedThreadReplies = removeRetiredTelegramDmConfig({
    entry: updated,
    pathPrefix: "channels.telegram",
    changes,
  });
  updated = removedThreadReplies.entry;
  changed = changed || removedThreadReplies.changed;

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
      resolvedMode: resolveTelegramPreviewStreamMode(entry),
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
