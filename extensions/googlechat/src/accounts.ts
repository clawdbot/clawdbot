import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

import type { GoogleChatAccountConfig, GoogleChatConfig } from "./types.config.js";
import { readGogRefreshTokenSync, resolveGogCredentialsFile } from "./gog.js";

export type GoogleChatAppCredentialSource = "file" | "inline" | "env" | "none";
export type GoogleChatUserCredentialSource = "file" | "inline" | "env" | "none";
export type GoogleChatCredentialSource = "file" | "inline" | "env" | "oauth" | "none";

export type ResolvedGoogleChatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: GoogleChatAccountConfig;
  credentialSource: GoogleChatCredentialSource;
  appCredentialSource: GoogleChatAppCredentialSource;
  userCredentialSource: GoogleChatUserCredentialSource;
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
};

const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const ENV_GOG_ACCOUNT = "GOG_ACCOUNT";
const ENV_GOG_CLIENT = "GOG_CLIENT";
const ENV_OAUTH_CLIENT_ID = "GOOGLE_CHAT_OAUTH_CLIENT_ID";
const ENV_OAUTH_CLIENT_SECRET = "GOOGLE_CHAT_OAUTH_CLIENT_SECRET";
const ENV_OAUTH_CLIENT_FILE = "GOOGLE_CHAT_OAUTH_CLIENT_FILE";
const ENV_OAUTH_REFRESH_TOKEN = "GOOGLE_CHAT_OAUTH_REFRESH_TOKEN";
const ENV_OAUTH_REFRESH_TOKEN_FILE = "GOOGLE_CHAT_OAUTH_REFRESH_TOKEN_FILE";

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.["googlechat"] as GoogleChatConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listGoogleChatAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultGoogleChatAccountId(cfg: ClawdbotConfig): string {
  const channel = cfg.channels?.["googlechat"] as GoogleChatConfig | undefined;
  if (channel?.defaultAccount?.trim()) return channel.defaultAccount.trim();
  const ids = listGoogleChatAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): GoogleChatAccountConfig | undefined {
  const accounts = (cfg.channels?.["googlechat"] as GoogleChatConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as GoogleChatAccountConfig | undefined;
}

function mergeGoogleChatAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): GoogleChatAccountConfig {
  const raw = (cfg.channels?.["googlechat"] ?? {}) as GoogleChatConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as GoogleChatAccountConfig;
}

function parseServiceAccount(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveCredentialsFromConfig(params: {
  accountId: string;
  account: GoogleChatAccountConfig;
}): {
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
  source: GoogleChatAppCredentialSource;
} {
  const { account, accountId } = params;
  const inline = parseServiceAccount(account.serviceAccount);
  if (inline) {
    return { credentials: inline, source: "inline" };
  }

  const file = account.serviceAccountFile?.trim();
  if (file) {
    return { credentialsFile: file, source: "file" };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envJson = process.env[ENV_SERVICE_ACCOUNT];
    const envInline = parseServiceAccount(envJson);
    if (envInline) {
      return { credentials: envInline, source: "env" };
    }
    const envFile = process.env[ENV_SERVICE_ACCOUNT_FILE]?.trim();
    if (envFile) {
      return { credentialsFile: envFile, source: "env" };
    }
  }

  return { source: "none" };
}

function resolveUserAuthSource(params: {
  accountId: string;
  account: GoogleChatAccountConfig;
}): GoogleChatUserCredentialSource {
  const { account, accountId } = params;
  const gogAccount = account.gogAccount?.trim() || process.env[ENV_GOG_ACCOUNT]?.trim() || undefined;
  const gogClient = account.gogClient?.trim() || process.env[ENV_GOG_CLIENT]?.trim() || undefined;
  const clientId = account.oauthClientId?.trim();
  const clientSecret = account.oauthClientSecret?.trim();
  const clientFile = account.oauthClientFile?.trim();
  const refreshToken = account.oauthRefreshToken?.trim();
  const refreshTokenFile = account.oauthRefreshTokenFile?.trim();

  const hasInlineClient = hasNonEmptyString(clientId) && hasNonEmptyString(clientSecret);
  const hasFileClient = hasNonEmptyString(clientFile);
  const hasInlineRefresh = hasNonEmptyString(refreshToken);
  const hasFileRefresh = hasNonEmptyString(refreshTokenFile);
  const hasGogClient = account.oauthFromGog
    ? Boolean(resolveGogCredentialsFile({ gogClient, gogAccount }))
    : false;
  const hasGogRefresh = account.oauthFromGog
    ? Boolean(readGogRefreshTokenSync({ gogAccount, gogClient }))
    : false;

  const hasEnvClient =
    accountId === DEFAULT_ACCOUNT_ID &&
    hasNonEmptyString(process.env[ENV_OAUTH_CLIENT_ID]) &&
    hasNonEmptyString(process.env[ENV_OAUTH_CLIENT_SECRET]);
  const hasEnvClientFile =
    accountId === DEFAULT_ACCOUNT_ID && hasNonEmptyString(process.env[ENV_OAUTH_CLIENT_FILE]);
  const hasEnvRefresh =
    accountId === DEFAULT_ACCOUNT_ID && hasNonEmptyString(process.env[ENV_OAUTH_REFRESH_TOKEN]);
  const hasEnvRefreshFile =
    accountId === DEFAULT_ACCOUNT_ID &&
    hasNonEmptyString(process.env[ENV_OAUTH_REFRESH_TOKEN_FILE]);

  const hasClient =
    hasInlineClient || hasFileClient || hasEnvClient || hasEnvClientFile || hasGogClient;
  const hasRefresh =
    hasInlineRefresh || hasFileRefresh || hasEnvRefresh || hasEnvRefreshFile || hasGogRefresh;
  if (!hasClient || !hasRefresh) return "none";

  if (hasFileClient || hasFileRefresh) return "file";
  if (hasEnvClient || hasEnvClientFile || hasEnvRefresh || hasEnvRefreshFile) return "env";
  return "inline";
}

export function resolveGoogleChatAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedGoogleChatAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled =
    (params.cfg.channels?.["googlechat"] as GoogleChatConfig | undefined)?.enabled !== false;
  const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentialsFromConfig({ accountId, account: merged });
  const userCredentialSource = resolveUserAuthSource({ accountId, account: merged });
  const credentialSource =
    credentials.source !== "none"
      ? credentials.source
      : userCredentialSource !== "none"
        ? "oauth"
        : "none";

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    credentialSource,
    appCredentialSource: credentials.source,
    userCredentialSource,
    credentials: credentials.credentials,
    credentialsFile: credentials.credentialsFile,
  };
}

export function listEnabledGoogleChatAccounts(cfg: ClawdbotConfig): ResolvedGoogleChatAccount[] {
  return listGoogleChatAccountIds(cfg)
    .map((accountId) => resolveGoogleChatAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
