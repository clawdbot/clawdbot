// Telegram plugin module implements shared config adapter behavior.
import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "./accounts.js";

const TELEGRAM_CHANNEL = "telegram" as const;

type TelegramConfigAccessorAccount = {
  config: TelegramAccountConfig;
};

export function findTelegramTokenOwnerAccountId(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): string | null {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const tokenOwners = new Map<string, string>();
  for (const id of listTelegramAccountIds(params.cfg)) {
    const account = inspectTelegramAccount({ cfg: params.cfg, accountId: id });
    const token = (account.token ?? "").trim();
    if (!token) {
      continue;
    }
    const ownerAccountId = tokenOwners.get(token);
    if (!ownerAccountId) {
      tokenOwners.set(token, account.accountId);
      continue;
    }
    if (account.accountId === normalizedAccountId) {
      return ownerAccountId;
    }
  }
  return null;
}

export function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

/**
 * Returns true when the runtime token resolver (`resolveTelegramToken`) would
 * block channel-level fallthrough for the given accountId. This mirrors the
 * guard in `token.ts` so that status-check functions (`isConfigured`,
 * `unconfiguredReason`, `describeAccount`) stay consistent with the gateway
 * runtime behavior.
 *
 * The guard fires when:
 *   1. The accountId is not the default account, AND
 *   2. The config has an explicit `accounts` section with entries, AND
 *   3. The accountId is not found in that `accounts` section.
 *
 * See: https://github.com/openclaw/openclaw/issues/53876
 */
function isBlockedByMultiBotGuard(cfg: OpenClawConfig, accountId: string): boolean {
  if (normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const accounts = cfg.channels?.telegram?.accounts;
  const hasConfiguredAccounts =
    Boolean(accounts) &&
    typeof accounts === "object" &&
    !Array.isArray(accounts) &&
    Object.keys(accounts).length > 0;
  if (!hasConfiguredAccounts) {
    return false;
  }
  // Use resolveNormalizedAccountEntry (same as resolveTelegramToken in token.ts)
  // so keys such as "Carey Notifications" match "carey-notifications".
  return !resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
}

export function resolveTelegramConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramConfigAccessorAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  return { config: mergeTelegramAccountConfig(params.cfg, accountId) };
}

export const telegramConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedTelegramAccount,
  TelegramConfigAccessorAccount
>({
  sectionKey: TELEGRAM_CHANNEL,
  listAccountIds: listTelegramAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveTelegramAccount),
  resolveAccessorAccount: resolveTelegramConfigAccessorAccount,
  inspectAccount: adaptScopedAccountAccessor(inspectTelegramAccount),
  defaultAccountId: resolveDefaultTelegramAccountId,
  clearBaseFields: ["botToken", "tokenFile", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

export function createTelegramPluginConfig(): ChannelPlugin<ResolvedTelegramAccount>["config"] {
  return {
    ...telegramConfigAdapter,
    hasConfiguredState: ({ env }) =>
      typeof env?.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.trim().length > 0,
    isConfigured: (account, cfg) => {
      // Inspect the complete token resolution, including channel-level fallbacks used by
      // binding-created account IDs in a single-bot setup.
      if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
        return false;
      }
      const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
      // "configured_unavailable" is configured state, but cannot start the runtime.
      if (!inspected.token?.trim()) {
        return false;
      }
      return !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId });
    },
    unconfiguredReason: (account, cfg) => {
      if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
        return `not configured: unknown accountId "${account.accountId}" in multi-bot setup`;
      }
      const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
      if (!inspected.token?.trim()) {
        return inspected.tokenStatus === "configured_unavailable"
          ? `not configured: token ${inspected.tokenSource} is configured but unavailable`
          : "not configured";
      }
      const ownerAccountId = findTelegramTokenOwnerAccountId({
        cfg,
        accountId: account.accountId,
      });
      return ownerAccountId
        ? formatDuplicateTelegramTokenReason({ accountId: account.accountId, ownerAccountId })
        : "not configured";
    },
    describeAccount: (account, cfg) => {
      if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: false,
          tokenSource: "none" as const,
        };
      }
      const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured:
          inspected.tokenStatus !== "missing" &&
          !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId }),
        tokenSource: inspected.tokenSource,
        tokenStatus: inspected.tokenStatus,
      };
    },
  };
}
