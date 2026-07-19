// Googlechat plugin module implements doctor contract behavior.
import { isDeepStrictEqual } from "node:util";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergeDeep } from "openclaw/plugin-sdk/plugin-config-runtime";
import { asObjectRecord, defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";

type GoogleChatChannelsConfig = NonNullable<OpenClawConfig["channels"]>;

// Google Chat's nested streaming schema is delivery-only ({chunkMode, block});
// it has no preview mode (legacy streamMode is removed outright above), so
// only the delivery flat aliases migrate. The plugin doctor below then
// materializes Google Chat's root < accounts.default < named precedence.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "googlechat",
  streaming: { defaultMode: "partial", deliveryOnly: true },
});

function hasLegacyGoogleChatStreamMode(value: unknown): boolean {
  return asObjectRecord(value)?.streamMode !== undefined;
}

function hasLegacyGoogleChatGroupAllowAlias(value: unknown): boolean {
  const groups = asObjectRecord(asObjectRecord(value)?.groups);
  if (!groups) {
    return false;
  }
  return Object.values(groups).some((group) => Object.hasOwn(asObjectRecord(group) ?? {}, "allow"));
}

function hasLegacyAccountAliases(value: unknown, match: (entry: unknown) => boolean): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => match(account));
}

function normalizeGoogleChatGroups(params: {
  groups: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { groups: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextGroups = { ...params.groups };
  for (const [groupId, groupValue] of Object.entries(params.groups)) {
    const group = asObjectRecord(groupValue);
    if (!group || !Object.hasOwn(group, "allow")) {
      continue;
    }
    const nextGroup = { ...group };
    if (nextGroup.enabled === undefined) {
      nextGroup.enabled = group.allow;
      params.changes.push(
        `Moved ${params.pathPrefix}.${groupId}.allow → ${params.pathPrefix}.${groupId}.enabled.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.${groupId}.allow (${params.pathPrefix}.${groupId}.enabled already set).`,
      );
    }
    delete nextGroup.allow;
    nextGroups[groupId] = nextGroup;
    changed = true;
  }
  return { groups: nextGroups, changed };
}

function normalizeGoogleChatEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  let changed = false;

  if (updated.streamMode !== undefined) {
    updated = { ...updated };
    delete updated.streamMode;
    params.changes.push(`Removed ${params.pathPrefix}.streamMode (legacy key no longer used).`);
    changed = true;
  }

  const groups = asObjectRecord(updated.groups);
  if (groups) {
    const normalized = normalizeGoogleChatGroups({
      groups,
      pathPrefix: `${params.pathPrefix}.groups`,
      changes: params.changes,
    });
    if (normalized.changed) {
      updated = { ...updated, groups: normalized.groups };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "googlechat"],
    message: "channels.googlechat.streamMode is legacy and no longer used; it is removed on load.",
    match: hasLegacyGoogleChatStreamMode,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      "channels.googlechat.accounts.<id>.streamMode is legacy and no longer used; it is removed on load.",
    match: (value) => hasLegacyAccountAliases(value, hasLegacyGoogleChatStreamMode),
  },
  {
    path: ["channels", "googlechat"],
    message:
      'channels.googlechat.groups.<id>.allow is legacy; use channels.googlechat.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyGoogleChatGroupAllowAlias,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      'channels.googlechat.accounts.<id>.groups.<id>.allow is legacy; use channels.googlechat.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountAliases(value, hasLegacyGoogleChatGroupAllowAlias),
  },
  ...streamingAliasMigration.legacyConfigRules,
];

function normalizeRetiredGoogleChatKeys(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord(
    (cfg.channels as Record<string, unknown> | undefined)?.googlechat,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed;

  const root = normalizeGoogleChatEntry({
    entry: updated,
    pathPrefix: "channels.googlechat",
    changes,
  });
  updated = root.entry;
  changed = root.changed;

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = asObjectRecord(accountValue);
      if (!account) {
        continue;
      }
      const normalized = normalizeGoogleChatEntry({
        entry: account,
        pathPrefix: `channels.googlechat.accounts.${accountId}`,
        changes,
      });
      if (!normalized.changed) {
        continue;
      }
      nextAccounts[accountId] = normalized.entry;
      accountsChanged = true;
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
      ...cfg,
      channels: {
        ...cfg.channels,
        googlechat: updated as GoogleChatChannelsConfig["googlechat"],
      },
    },
    changes,
  };
}

// Runtime replaces streaming at each layer. When doctor creates an object from
// flat aliases, materialize the effective root < accounts.default < named value
// so the canonical runtime path preserves the pre-migration behavior.
function materializeMigratedAccountStreaming(params: {
  cfg: OpenClawConfig;
  accountsBefore: Record<string, unknown> | null;
  changes: string[];
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.googlechat);
  const accounts = asObjectRecord(entry?.accounts);
  if (!entry || !accounts) {
    return params.cfg;
  }
  const rootStreaming = asObjectRecord(entry.streaming);
  const defaultKey = Object.hasOwn(accounts, "default")
    ? "default"
    : Object.keys(accounts).find((key) => key.trim().toLowerCase() === "default");

  let accountsChanged = false;
  const nextAccounts = { ...accounts };
  const accountIds = Object.keys(accounts).toSorted((left, right) =>
    left === defaultKey ? -1 : right === defaultKey ? 1 : left.localeCompare(right),
  );
  for (const accountId of accountIds) {
    const accountBefore = asObjectRecord(params.accountsBefore?.[accountId]);
    if (accountBefore?.streaming !== undefined) {
      continue;
    }
    const account = asObjectRecord(nextAccounts[accountId]);
    const created = asObjectRecord(account?.streaming);
    if (!account || !created) {
      continue;
    }
    const defaultStreaming = defaultKey
      ? asObjectRecord(asObjectRecord(nextAccounts[defaultKey])?.streaming)
      : null;
    const inherited =
      accountId === defaultKey ? rootStreaming : (defaultStreaming ?? rootStreaming);
    if (!inherited) {
      continue;
    }
    const materialized = asObjectRecord(mergeDeep(inherited, created));
    if (!materialized || isDeepStrictEqual(materialized, created)) {
      continue;
    }
    nextAccounts[accountId] = { ...account, streaming: materialized };
    accountsChanged = true;
    const sourcePath =
      accountId !== defaultKey && defaultKey && defaultStreaming
        ? `channels.googlechat.accounts.${defaultKey}.streaming`
        : "channels.googlechat.streaming";
    params.changes.push(
      `Copied ${sourcePath} into channels.googlechat.accounts.${accountId}.streaming to keep inherited settings while migrating flat streaming keys.`,
    );
  }
  if (!accountsChanged) {
    return params.cfg;
  }
  return {
    ...params.cfg,
    channels: {
      ...channels,
      googlechat: { ...entry, accounts: nextAccounts },
    },
  } as OpenClawConfig;
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const retired = normalizeRetiredGoogleChatKeys(cfg);
  const accountsBefore = asObjectRecord(
    asObjectRecord((retired.config.channels as Record<string, unknown> | undefined)?.googlechat)
      ?.accounts,
  );
  const aliases = streamingAliasMigration.normalizeChannelConfig({
    cfg: retired.config,
    changes: retired.changes,
  });
  return {
    config: materializeMigratedAccountStreaming({
      cfg: aliases.config,
      accountsBefore,
      changes: aliases.changes,
    }),
    changes: aliases.changes,
  };
}
