import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import {
  mergeSlackAccountConfig,
  resolveDefaultSlackAccountId,
  type SlackTokenSource,
} from "./accounts.js";
import type { SlackAccountConfig } from "./runtime-api.js";

export type SlackCredentialStatus = "available" | "configured_unavailable" | "missing";

export type InspectedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  mode?: SlackAccountConfig["mode"];
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  signingSecretSource?: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  botTokenStatus: SlackCredentialStatus;
  appTokenStatus: SlackCredentialStatus;
  signingSecretStatus?: SlackCredentialStatus;
  userTokenStatus: SlackCredentialStatus;
  configured: boolean;
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;

function inspectSlackToken(value: unknown): {
  token?: string;
  source: Exclude<SlackTokenSource, "env">;
  status: SlackCredentialStatus;
} {
  const token = normalizeSecretInputString(value);
  if (token) {
    return {
      token,
      source: "config",
      status: "available",
    };
  }
  if (hasConfiguredSecretInput(value)) {
    return {
      source: "config",
      status: "configured_unavailable",
    };
  }
  return {
    source: "none",
    status: "missing",
  };
}

export function inspectSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envBotToken?: string | null;
  envAppToken?: string | null;
  envUserToken?: string | null;
}): InspectedSlackAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  );
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.slack?.enabled !== false && merged.enabled !== false;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const mode = merged.mode ?? "socket";
  const isHttpMode = mode === "http";

  const configBot = inspectSlackToken(merged.botToken);
  const configApp = inspectSlackToken(merged.appToken);
  const configSigningSecret = inspectSlackToken(merged.signingSecret);
  const configUser = inspectSlackToken(merged.userToken);

  const envBot = allowEnv
    ? normalizeSecretInputString(params.envBotToken ?? process.env.SLACK_BOT_TOKEN)
    : undefined;
  const envApp = allowEnv
    ? normalizeSecretInputString(params.envAppToken ?? process.env.SLACK_APP_TOKEN)
    : undefined;
  const envUser = allowEnv
    ? normalizeSecretInputString(params.envUserToken ?? process.env.SLACK_USER_TOKEN)
    : undefined;

  const botToken = configBot.token ?? envBot;
  const appToken = configApp.token ?? envApp;
  const signingSecret = configSigningSecret.token;
  const userToken = configUser.token ?? envUser;
  const botTokenSource: SlackTokenSource = configBot.token
    ? "config"
    : configBot.status === "configured_unavailable"
      ? "config"
      : envBot
        ? "env"
        : "none";
  const appTokenSource: SlackTokenSource = configApp.token
    ? "config"
    : configApp.status === "configured_unavailable"
      ? "config"
      : envApp
        ? "env"
        : "none";
  const signingSecretSource: SlackTokenSource = configSigningSecret.token
    ? "config"
    : configSigningSecret.status === "configured_unavailable"
      ? "config"
      : "none";
  const userTokenSource: SlackTokenSource = configUser.token
    ? "config"
    : configUser.status === "configured_unavailable"
      ? "config"
      : envUser
        ? "env"
        : "none";

  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    mode,
    botToken,
    appToken,
    ...(isHttpMode ? { signingSecret } : {}),
    userToken,
    botTokenSource,
    appTokenSource,
    ...(isHttpMode ? { signingSecretSource } : {}),
    userTokenSource,
    botTokenStatus: configBot.token
      ? "available"
      : configBot.status === "configured_unavailable"
        ? "configured_unavailable"
        : envBot
          ? "available"
          : "missing",
    appTokenStatus: configApp.token
      ? "available"
      : configApp.status === "configured_unavailable"
        ? "configured_unavailable"
        : envApp
          ? "available"
          : "missing",
    ...(isHttpMode
      ? {
          signingSecretStatus: configSigningSecret.token
            ? "available"
            : configSigningSecret.status === "configured_unavailable"
              ? "configured_unavailable"
              : "missing",
        }
      : {}),
    userTokenStatus: configUser.token
      ? "available"
      : configUser.status === "configured_unavailable"
        ? "configured_unavailable"
        : envUser
          ? "available"
          : "missing",
    configured: isHttpMode
      ? (configBot.status !== "missing" || Boolean(envBot)) &&
        configSigningSecret.status !== "missing"
      : (configBot.status !== "missing" || Boolean(envBot)) &&
        (configApp.status !== "missing" || Boolean(envApp)),
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
