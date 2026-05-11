import {
  addWildcardAllowFrom,
  applySetupAccountConfigPatch,
  type ChannelSetupDmPolicy,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  patchChannelConfigForAccount,
} from "openclaw/plugin-sdk/setup";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts.js";
import { promptTelegramAllowFromForAccount } from "./setup-core.js";

const channel = "telegram" as const;

export function ensureTelegramDefaultGroupMentionGate(
  cfg: OpenClawConfig,
  accountId: string,
): OpenClawConfig {
  const resolved = resolveTelegramAccount({ cfg, accountId });
  const wildcardGroup = resolved.config.groups?.["*"];
  if (wildcardGroup?.requireMention !== undefined) {
    return cfg;
  }
  return patchChannelConfigForAccount({
    cfg,
    channel,
    accountId,
    patch: {
      groups: {
        ...resolved.config.groups,
        "*": {
          ...wildcardGroup,
          requireMention: true,
        },
      },
    },
  });
}

export function shouldShowTelegramDmAccessWarning(cfg: OpenClawConfig, accountId: string): boolean {
  const merged = mergeTelegramAccountConfig(cfg, accountId);
  const policy = merged.dmPolicy ?? "pairing";
  const hasAllowFrom =
    Array.isArray(merged.allowFrom) &&
    merged.allowFrom.some((entry) => normalizeOptionalString(String(entry)));
  return policy === "pairing" && !hasAllowFrom;
}

export function buildTelegramDmAccessWarningLines(accountId: string): string[] {
  const configBase =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.telegram"
      : `channels.telegram.accounts.${accountId}`;
  return [
    "Your bot is using DM policy: pairing.",
    "Any Telegram user who discovers the bot can send pairing requests.",
    "For private use, configure an allowlist with your Telegram user id:",
    "  " + formatCliCommand(`openclaw config set ${configBase}.dmPolicy "allowlist"`),
    "  " + formatCliCommand(`openclaw config set ${configBase}.allowFrom '["YOUR_USER_ID"]'`),
    `Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`,
  ];
}

export const telegramSetupDmPolicy: ChannelSetupDmPolicy = {
  label: "Telegram",
  channel,
  policyKey: "channels.telegram.dmPolicy",
  allowFromKey: "channels.telegram.allowFrom",
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultTelegramAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.telegram.accounts.${accountId ?? resolveDefaultTelegramAccountId(cfg)}.dmPolicy`,
          allowFromKey: `channels.telegram.accounts.${accountId ?? resolveDefaultTelegramAccountId(cfg)}.allowFrom`,
        }
      : {
          policyKey: "channels.telegram.dmPolicy",
          allowFromKey: "channels.telegram.allowFrom",
        },
  getCurrent: (cfg, accountId) =>
    mergeTelegramAccountConfig(cfg, accountId ?? resolveDefaultTelegramAccountId(cfg)).dmPolicy ??
    "pairing",
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
    const merged = mergeTelegramAccountConfig(cfg, resolvedAccountId);
    const patch = {
      dmPolicy: policy,
      ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(merged.allowFrom) } : {}),
    };
    return accountId == null && resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId: resolvedAccountId,
          patch,
        })
      : patchChannelConfigForAccount({
          cfg,
          channel,
          accountId: resolvedAccountId,
          patch,
        });
  },
  promptAllowFrom: promptTelegramAllowFromForAccount,
};
