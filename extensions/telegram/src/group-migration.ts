import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

type TelegramGroups = Record<string, TelegramGroupConfig>;

type MigrationScope = "account" | "global";

export type TelegramGroupMigrationResult = {
  migrated: boolean;
  skippedExisting: boolean;
  scopes: MigrationScope[];
};

function resolveAccountGroups(
  cfg: OpenClawConfig,
  accountId?: string | null,
): { groups?: TelegramGroups } {
  if (!accountId) {
    return {};
  }
  const normalized = normalizeAccountId(accountId);
  const accounts = cfg.channels?.telegram?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return {};
  }
  const exact = accounts[normalized];
  if (exact?.groups) {
    return { groups: exact.groups };
  }
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === normalizeLowercaseStringOrEmpty(normalized),
  );
  return { groups: matchKey ? accounts[matchKey]?.groups : undefined };
}

export function migrateTelegramGroupsInPlace(
  groups: TelegramGroups | undefined,
  oldChatId: string,
  newChatId: string,
): { migrated: boolean; skippedExisting: boolean } {
  if (!groups) {
    return { migrated: false, skippedExisting: false };
  }
  if (oldChatId === newChatId) {
    return { migrated: false, skippedExisting: false };
  }
  if (!Object.hasOwn(groups, oldChatId)) {
    return { migrated: false, skippedExisting: false };
  }
  if (Object.hasOwn(groups, newChatId)) {
    return { migrated: false, skippedExisting: true };
  }
  groups[newChatId] = groups[oldChatId];
  delete groups[oldChatId];
  return { migrated: true, skippedExisting: false };
}

export function migrateTelegramGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChatId: string;
  newChatId: string;
}): TelegramGroupMigrationResult {
  const scopes: MigrationScope[] = [];
  let migrated = false;
  let skippedExisting = false;

  const migrationTargets: Array<{
    scope: MigrationScope;
    groups: TelegramGroups | undefined;
  }> = [
    { scope: "account", groups: resolveAccountGroups(params.cfg, params.accountId).groups },
    { scope: "global", groups: params.cfg.channels?.telegram?.groups },
  ];

  for (const target of migrationTargets) {
    const result = migrateTelegramGroupsInPlace(target.groups, params.oldChatId, params.newChatId);
    if (result.migrated) {
      migrated = true;
      scopes.push(target.scope);
    }
    if (result.skippedExisting) {
      skippedExisting = true;
    }
  }

  return { migrated, skippedExisting, scopes };
}
