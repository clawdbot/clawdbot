import { normalizeAccountId } from "openclaw/plugin-sdk/account-core";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolvedDirectoryEntriesLister } from "openclaw/plugin-sdk/directory-config-runtime";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveDefaultTelegramAccountSelection } from "./account-selection.js";

type TelegramDirectoryAccount = {
  config: TelegramAccountConfig;
};

function resolveTelegramDirectoryAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramDirectoryAccount {
  const resolvedAccountId = accountId?.trim()
    ? normalizeAccountId(accountId)
    : resolveDefaultTelegramAccountSelection(cfg).accountId;
  return {
    config: mergeTelegramAccountConfig(cfg, resolvedAccountId),
  };
}

export const listTelegramDirectoryPeersFromConfig =
  createResolvedDirectoryEntriesLister<TelegramDirectoryAccount>({
    kind: "user",
    resolveAccount: (cfg, accountId) => resolveTelegramDirectoryAccount(cfg, accountId),
    resolveSources: (account) => [
      mapAllowFromEntries(account.config.allowFrom),
      Object.keys(account.config.dms ?? {}),
    ],
    normalizeId: (entry) => {
      const trimmed = entry.replace(/^(telegram|tg):/i, "").trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    },
  });

export const listTelegramDirectoryGroupsFromConfig =
  createResolvedDirectoryEntriesLister<TelegramDirectoryAccount>({
    kind: "group",
    resolveAccount: (cfg, accountId) => resolveTelegramDirectoryAccount(cfg, accountId),
    resolveSources: (account) => [Object.keys(account.config.groups ?? {})],
    normalizeId: (entry) => entry.trim() || null,
  });
