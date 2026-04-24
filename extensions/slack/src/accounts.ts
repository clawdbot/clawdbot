import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import type { SlackAccountConfig } from "./runtime-api.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";

export { resolveSlackReplyToMode } from "./account-reply-mode.js";

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
}): ResolvedSlackAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const mode = merged.mode ?? "socket";
  const baseAllowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const botActive = enabled;
  const appActive = enabled && mode !== "http";
  const userActive = enabled;
  const envBot =
    botActive && baseAllowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : undefined;
  const envApp =
    appActive && baseAllowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : undefined;
  const envUser =
    userActive && baseAllowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : undefined;
  const configBot = botActive
    ? resolveSlackBotToken(merged.botToken, `channels.slack.accounts.${accountId}.botToken`)
    : undefined;
  const configApp = appActive
    ? resolveSlackAppToken(merged.appToken, `channels.slack.accounts.${accountId}.appToken`)
    : undefined;
  const configUser = userActive
    ? resolveSlackUserToken(merged.userToken, `channels.slack.accounts.${accountId}.userToken`)
    : undefined;
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
