// Slack plugin module implements account inspect behavior.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasSlackAccountCredentials } from "./account-configured.js";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import {
  mergeSlackAccountConfig,
  resolveDefaultSlackAccountId,
  type SlackTokenSource,
} from "./accounts.js";

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
  identity?: "user";
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

function resolveInspectedSlackToken(
  configured: ReturnType<typeof inspectSlackToken>,
  envToken: string | undefined,
): { token?: string; source: SlackTokenSource; status: SlackCredentialStatus } {
  // A configured SecretRef remains authoritative while unavailable; read-only
  // inspection must not make a lower-precedence environment token look active.
  return configured.status === "missing" && envToken
    ? { token: envToken, source: "env", status: "available" }
    : configured;
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
  const identity = merged.postAs ?? "bot";
  const isHttpMode = mode === "http";
  const isRelayMode = mode === "relay";

  const configBot = inspectSlackToken(merged.botToken);
  const configApp = inspectSlackToken(merged.appToken);
  const configSigningSecret = inspectSlackToken(merged.signingSecret);
  const configUser = inspectSlackToken(merged.userToken);

  const envBot = allowEnv
    ? normalizeSecretInputString(params.envBotToken ?? process.env.SLACK_BOT_TOKEN)
    : undefined;
  const envApp =
    allowEnv && !isRelayMode
      ? normalizeSecretInputString(params.envAppToken ?? process.env.SLACK_APP_TOKEN)
      : undefined;
  const envUser = allowEnv
    ? normalizeSecretInputString(params.envUserToken ?? process.env.SLACK_USER_TOKEN)
    : undefined;

  const botCredential = resolveInspectedSlackToken(configBot, envBot);
  const appCredential = resolveInspectedSlackToken(configApp, envApp);
  const userCredential = resolveInspectedSlackToken(configUser, envUser);

  return {
    accountId,
    enabled,
    ...(identity === "user" ? { identity } : {}),
    name: normalizeOptionalString(merged.name),
    mode,
    botToken: botCredential.token,
    appToken: appCredential.token,
    ...(isHttpMode ? { signingSecret: configSigningSecret.token } : {}),
    userToken: userCredential.token,
    botTokenSource: botCredential.source,
    appTokenSource: appCredential.source,
    ...(isHttpMode ? { signingSecretSource: configSigningSecret.source } : {}),
    userTokenSource: userCredential.source,
    botTokenStatus: botCredential.status,
    appTokenStatus: appCredential.status,
    ...(isHttpMode ? { signingSecretStatus: configSigningSecret.status } : {}),
    userTokenStatus: userCredential.status,
    configured: hasSlackAccountCredentials({
      config: merged,
      identityTokenConfigured:
        (identity === "user" ? userCredential : botCredential).status !== "missing",
      appTokenConfigured: appCredential.status !== "missing",
    }),
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
