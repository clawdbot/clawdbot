import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
  resolveAccountEntry,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { z } from "zod";
import type { GoogleChatAccountConfig } from "./types.config.js";

export type GoogleChatCredentialSource = "file" | "inline" | "env" | "none";

export type ResolvedGoogleChatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: GoogleChatAccountConfig;
  credentialSource: GoogleChatCredentialSource;
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
};

export type GoogleChatConfigAccessorAccount = {
  config: GoogleChatAccountConfig;
};

const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const JsonRecordSchema = z.record(z.string(), z.unknown());

const {
  listAccountIds: listGoogleChatAccountIds,
  resolveDefaultAccountId: resolveDefaultGoogleChatAccountId,
} = createAccountListHelpers("googlechat");
export { listGoogleChatAccountIds, resolveDefaultGoogleChatAccountId };

export function mergeGoogleChatAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): GoogleChatAccountConfig {
  const raw = cfg.channels?.["googlechat"] ?? {};
  const base = resolveMergedAccountConfig<GoogleChatAccountConfig>({
    channelConfig: raw as GoogleChatAccountConfig,
    accounts: raw.accounts as Record<string, Partial<GoogleChatAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
  const defaultAccountConfig = resolveAccountEntry(raw.accounts, DEFAULT_ACCOUNT_ID) ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return base;
  }
  const {
    enabled: _ignoredEnabled,
    dangerouslyAllowNameMatching: _ignoredDangerouslyAllowNameMatching,
    serviceAccount: _ignoredServiceAccount,
    serviceAccountRef: _ignoredServiceAccountRef,
    serviceAccountFile: _ignoredServiceAccountFile,
    ...defaultAccountShared
  } = defaultAccountConfig;
  // In multi-account setups, allow accounts.default to provide shared defaults
  // (for example webhook/audience fields) while preserving top-level and account overrides.
  return { ...defaultAccountShared, ...base } as GoogleChatAccountConfig;
}

export function resolveGoogleChatConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): GoogleChatConfigAccessorAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? params.cfg.channels?.googlechat?.defaultAccount,
  );
  return { config: mergeGoogleChatAccountConfig(params.cfg, accountId) };
}

function parseServiceAccount(value: unknown): Record<string, unknown> | null {
  if (isSecretRef(value)) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return safeParseJsonWithSchema(JsonRecordSchema, trimmed);
  }

  return safeParseWithSchema(JsonRecordSchema, value);
}

function resolveCredentialsFromConfig(params: {
  accountId: string;
  account: GoogleChatAccountConfig;
}): {
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
  source: GoogleChatCredentialSource;
} {
  const { account, accountId } = params;
  const inline = parseServiceAccount(account.serviceAccount);
  if (inline) {
    return { credentials: inline, source: "inline" };
  }

  if (isSecretRef(account.serviceAccount)) {
    throw new Error(
      `channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccount.source}:${account.serviceAccount.provider}:${account.serviceAccount.id}". Resolve this command against an active gateway runtime snapshot before reading it.`,
    );
  }

  if (isSecretRef(account.serviceAccountRef)) {
    throw new Error(
      `channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccountRef.source}:${account.serviceAccountRef.provider}:${account.serviceAccountRef.id}". Resolve this command against an active gateway runtime snapshot before reading it.`,
    );
  }

  const file = normalizeOptionalString(account.serviceAccountFile);
  if (file) {
    return { credentialsFile: file, source: "file" };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envJson = process.env[ENV_SERVICE_ACCOUNT];
    const envInline = parseServiceAccount(envJson);
    if (envInline) {
      return { credentials: envInline, source: "env" };
    }
    const envFile = normalizeOptionalString(process.env[ENV_SERVICE_ACCOUNT_FILE]);
    if (envFile) {
      return { credentialsFile: envFile, source: "env" };
    }
  }

  return { source: "none" };
}

export function resolveGoogleChatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedGoogleChatAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? params.cfg.channels?.["googlechat"]?.defaultAccount,
  );
  const baseEnabled = params.cfg.channels?.["googlechat"]?.enabled !== false;
  const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentialsFromConfig({ accountId, account: merged });

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled,
    config: merged,
    credentialSource: credentials.source,
    credentials: credentials.credentials,
    credentialsFile: credentials.credentialsFile,
  };
}

export function listEnabledGoogleChatAccounts(cfg: OpenClawConfig): ResolvedGoogleChatAccount[] {
  return listGoogleChatAccountIds(cfg)
    .map((accountId) => resolveGoogleChatAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
