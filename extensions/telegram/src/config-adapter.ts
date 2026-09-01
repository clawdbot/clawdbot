// Telegram plugin module implements shared config adapter behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
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
      const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
      // Configured-unavailable credentials remain visible but cannot start the runtime.
      return inspected.configured && Boolean(inspected.token.trim());
    },
    unconfiguredReason: (account, cfg) => {
      const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
      return (
        inspected.stateReason ??
        (inspected.tokenStatus === "configured_unavailable"
          ? `not configured: token ${inspected.tokenSource} is configured but unavailable`
          : "not configured")
      );
    },
    describeAccount: (account, cfg) => {
      const inspected = inspectTelegramAccount({ cfg, accountId: account.accountId });
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: inspected.configured,
        tokenSource: inspected.tokenSource,
        tokenStatus: inspected.tokenStatus,
      };
    },
  };
}
