import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeChatType,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { isSecretRef, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import type { SlackAccountConfig } from "./runtime-api.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";

export type SlackTokenSource = "env" | "config" | "none";

export type ResolvedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  appToken?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("slack");
export const listSlackAccountIds = listAccountIds;
export const resolveDefaultSlackAccountId = resolveDefaultAccountId;

export function mergeSlackAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig {
  return resolveMergedAccountConfig<SlackAccountConfig>({
    channelConfig: cfg.channels?.slack as SlackAccountConfig,
    accounts: cfg.channels?.slack?.accounts as Record<string, Partial<SlackAccountConfig>>,
    accountId,
  });
}

export function resolveSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  /**
   * When true, account-level credential reads (`botToken`, `appToken`,
   * `userToken`) silently become `undefined` for unresolved `SecretRef`
   * inputs instead of throwing. Default is false to preserve the strict
   * behavior expected by boot-time provider initialization, which must
   * surface unresolved channel SecretRefs loudly.
   *
   * Pass `true` from call sites that already have a separately-resolved
   * credential override (for example `sendMessageSlack` receives an explicit
   * `opts.token` derived from the boot-time monitor context) and only need
   * the rest of the account info (account id, dm policy, channel settings,
   * etc.). The downstream consumer's existing `if (!token)` guard still
   * surfaces a clean "missing token" error when no explicit override is
   * supplied either.
   *
   * Without this opt-in, an inactive `channels.slack.accounts.*.botToken`
   * SecretRef left in the runtime snapshot (per the inspect/strict
   * separation introduced in #66818) blows up the strict resolver path even
   * though the actual send already has a valid boot-resolved token. See
   * #68237.
   */
  tolerateUnresolvedSecrets?: boolean;
}): ResolvedSlackAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  // Per-credential env-var fallback gating: in tolerant mode, only block
  // the `SLACK_*_TOKEN` env fallback for credentials whose configured value
  // is an unresolved `SecretRef` object. Otherwise (config field is a
  // resolved string, or unset entirely) keep the original env fallback so
  // legitimate env-only setups (no per-account config token, just
  // `SLACK_BOT_TOKEN` in the process env) keep working. This avoids
  // credential confusion (CWE-287) on misconfigured deployments where an
  // unresolved SecretRef would otherwise be silently overridden by a stray
  // env var, while preserving the env-only contract that callers like
  // `extensions/slack/src/channel.ts` rely on when omitting `opts.token`.
  const baseAllowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const tolerantMode = params.tolerateUnresolvedSecrets === true;
  const blockBotEnv = tolerantMode && isSecretRef(merged.botToken);
  const blockAppEnv = tolerantMode && isSecretRef(merged.appToken);
  const blockUserEnv = tolerantMode && isSecretRef(merged.userToken);
  const envBot =
    baseAllowEnv && !blockBotEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : undefined;
  const envApp =
    baseAllowEnv && !blockAppEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : undefined;
  const envUser =
    baseAllowEnv && !blockUserEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : undefined;
  const configBot = tolerantMode
    ? normalizeSecretInputString(merged.botToken)
    : resolveSlackBotToken(merged.botToken, `channels.slack.accounts.${accountId}.botToken`);
  const configApp = tolerantMode
    ? normalizeSecretInputString(merged.appToken)
    : resolveSlackAppToken(merged.appToken, `channels.slack.accounts.${accountId}.appToken`);
  const configUser = tolerantMode
    ? normalizeSecretInputString(merged.userToken)
    : resolveSlackUserToken(merged.userToken, `channels.slack.accounts.${accountId}.userToken`);
  const botToken = configBot ?? envBot;
  const appToken = configApp ?? envApp;
  const userToken = configUser ?? envUser;
  const botTokenSource: SlackTokenSource = configBot ? "config" : envBot ? "env" : "none";
  const appTokenSource: SlackTokenSource = configApp ? "config" : envApp ? "env" : "none";
  const userTokenSource: SlackTokenSource = configUser ? "config" : envUser ? "env" : "none";

  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    botToken,
    appToken,
    userToken,
    botTokenSource,
    appTokenSource,
    userTokenSource,
    config: merged,
    groupPolicy: merged.groupPolicy,
    textChunkLimit: merged.textChunkLimit,
    mediaMaxMb: merged.mediaMaxMb,
    reactionNotifications: merged.reactionNotifications,
    reactionAllowlist: merged.reactionAllowlist,
    replyToMode: merged.replyToMode,
    replyToModeByChatType: merged.replyToModeByChatType,
    actions: merged.actions,
    slashCommand: merged.slashCommand,
    dm: merged.dm,
    channels: merged.channels,
  };
}

export function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[] {
  return listSlackAccountIds(cfg)
    .map((accountId) => resolveSlackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveSlackReplyToMode(
  account: ResolvedSlackAccount,
  chatType?: string | null,
): "off" | "first" | "all" | "batched" {
  const normalized = normalizeChatType(chatType ?? undefined);
  if (normalized && account.replyToModeByChatType?.[normalized] !== undefined) {
    return account.replyToModeByChatType[normalized] ?? "off";
  }
  if (normalized === "direct" && account.dm?.replyToMode !== undefined) {
    return account.dm.replyToMode;
  }
  return account.replyToMode ?? "off";
}
