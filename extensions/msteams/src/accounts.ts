// Msteams plugin module implements account config behavior.
import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import type { MSTeamsConfig, OpenClawConfig } from "../runtime-api.js";
import { resolveMSTeamsCredentials } from "./token.js";

export type MSTeamsMultiAccountConfig = MSTeamsConfig & {
  accounts?: Record<string, Partial<MSTeamsConfig>>;
  defaultAccount?: string;
};

export type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  tokenStatus: "available" | "configured_unavailable" | "missing";
  credentialDiagnostics?: Extract<
    ReturnType<typeof tryReadSecretFileSync>,
    { status: "configured_unavailable" }
  >["diagnostic"][];
  config: MSTeamsConfig;
};

const IDENTITY_FIELDS = ["appId", "appPassword"] as const;

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("msteams", {
  normalizeAccountId,
  implicitDefaultAccount: {
    channelKeys: ["appId", "appPassword"],
    envVars: ["MSTEAMS_APP_ID", "MSTEAMS_APP_PASSWORD", "MSTEAMS_TENANT_ID"],
  },
});

export const listMSTeamsAccountIds = listAccountIds;
export const resolveDefaultMSTeamsAccountId = resolveDefaultAccountId;

function resolveMSTeamsChannelConfig(cfg: OpenClawConfig): MSTeamsMultiAccountConfig | undefined {
  return cfg.channels?.msteams as MSTeamsMultiAccountConfig | undefined; // SAFETY: the public config contract owns these optional fields.
}

export function withAccountScopedMSTeamsConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  accountConfig: MSTeamsConfig;
}): OpenClawConfig {
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      msteams:
        params.accountId === DEFAULT_ACCOUNT_ID
          ? params.accountConfig
          : { ...params.accountConfig, defaultAccount: params.accountId },
    },
  };
}

function accountDefinesIdentity(account: Partial<MSTeamsConfig> | undefined): boolean {
  return Boolean(account?.appId || account?.appPassword || account?.webhook?.port);
}

function resolveMSTeamsAccountEntry(
  accounts: Record<string, Partial<MSTeamsConfig>> | undefined,
  accountId: string,
): Partial<MSTeamsConfig> | undefined {
  const key = resolveMSTeamsAccountEntryKey(accounts, accountId);
  return key ? accounts?.[key] : undefined;
}

export function resolveMSTeamsAccountEntryKey(
  accounts: Record<string, Partial<MSTeamsConfig>> | undefined,
  accountId: string,
): string | undefined {
  if (!accounts) {
    return undefined;
  }
  for (const key of Object.keys(accounts)) {
    if (normalizeAccountId(key) === accountId) {
      return key;
    }
  }
  return undefined;
}

function isAccountScopedChannelConfig(
  channelConfig: MSTeamsMultiAccountConfig | undefined,
  accountId: string,
): boolean {
  if (!channelConfig) {
    return false;
  }
  const accounts = channelConfig.accounts;
  return (
    normalizeAccountId(channelConfig.defaultAccount) === accountId &&
    (!accounts || Object.keys(accounts).length === 0) &&
    accountDefinesIdentity(channelConfig)
  );
}

function clearNamedAccountInheritedIdentity(
  merged: MSTeamsConfig,
  account: Partial<MSTeamsConfig> | undefined,
): MSTeamsConfig {
  const next: MSTeamsConfig = { ...merged };
  for (const field of IDENTITY_FIELDS) {
    if (account?.[field] === undefined) {
      delete next[field];
    } else {
      next[field] = account[field] as never; // SAFETY: both config shapes share these writable keys.
    }
  }

  const accountWebhook = account?.webhook;
  const mergedWebhook = merged.webhook;
  if (mergedWebhook || accountWebhook) {
    next.webhook = {
      ...mergedWebhook,
      ...accountWebhook,
    };
    if (accountWebhook?.port === undefined) {
      delete next.webhook.port;
    }
  }
  return next;
}

export function resolveMSTeamsAccountConfig(
  cfg: OpenClawConfig,
  accountId?: string | null,
): MSTeamsConfig {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultMSTeamsAccountId(cfg));
  const channelConfig = resolveMSTeamsChannelConfig(cfg);
  const account = resolveMSTeamsAccountEntry(channelConfig?.accounts, resolvedAccountId);
  const merged = resolveMergedAccountConfig<MSTeamsConfig>({
    channelConfig,
    accounts: channelConfig?.accounts,
    accountId: resolvedAccountId,
    normalizeAccountId,
    omitKeys: ["defaultAccount"],
    nestedObjectKeys: [
      "webhook",
      "markdown",
      "streaming",
      "blockStreamingCoalesce",
      "dms",
      "teams",
      "heartbeat",
      "healthMonitor",
      "delegatedAuth",
      "sso",
    ],
  });

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    return merged;
  }
  if (!account && isAccountScopedChannelConfig(channelConfig, resolvedAccountId)) {
    return merged;
  }
  return clearNamedAccountInheritedIdentity(merged, account);
}

export function resolveMSTeamsRuntimeAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  msteamsCfg?: MSTeamsConfig;
}) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMSTeamsAccountId(params.cfg),
  );
  const config = params.msteamsCfg ?? resolveMSTeamsAccountConfig(params.cfg, accountId);
  const credentials = resolveMSTeamsCredentials(config, {
    allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    pathPrefix:
      accountId === DEFAULT_ACCOUNT_ID
        ? "channels.msteams"
        : `channels.msteams.accounts.${accountId}`,
  });
  return { accountId, config, credentials };
}

export function resolveMSTeamsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMSTeamsAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMSTeamsAccountId(params.cfg),
  );
  const channelEnabled = params.cfg.channels?.msteams?.enabled !== false;
  const config = resolveMSTeamsAccountConfig(params.cfg, accountId);
  const accountEnabled = config.enabled !== false;
  const pathPrefix =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.msteams"
      : `channels.msteams.accounts.${accountId}`;
  const credentials = resolveMSTeamsCredentials(config, {
    allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    pathPrefix,
  });
  const certificatePath =
    credentials?.type === "federated" && !credentials.useManagedIdentity
      ? credentials.certificatePath
      : undefined;
  const channelConfig = resolveMSTeamsChannelConfig(params.cfg);
  const rawAccountKey = resolveMSTeamsAccountEntryKey(channelConfig?.accounts, accountId);
  const rawAccount = rawAccountKey ? channelConfig?.accounts?.[rawAccountKey] : undefined;
  const certificateConfigPath = rawAccount?.certificatePath?.trim()
    ? `channels.msteams.accounts.${rawAccountKey}.certificatePath`
    : channelConfig?.certificatePath?.trim()
      ? "channels.msteams.certificatePath"
      : "env.MSTEAMS_CERTIFICATE_PATH";
  const certificate = certificatePath
    ? tryReadSecretFileSync(certificatePath, "Microsoft Teams certificate", undefined, {
        configPath: certificateConfigPath,
      })
    : undefined;
  const unavailable = certificate?.status === "configured_unavailable";
  return {
    accountId,
    enabled: channelEnabled && accountEnabled,
    configured: Boolean(credentials),
    tokenStatus: !credentials ? "missing" : unavailable ? "configured_unavailable" : "available",
    ...(unavailable ? { credentialDiagnostics: [certificate.diagnostic] } : {}),
    config,
  };
}

export function inspectMSTeamsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Record<string, unknown> {
  const account = resolveMSTeamsAccount(params);
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    hasIdentity:
      account.accountId === DEFAULT_ACCOUNT_ID ||
      accountDefinesIdentity(
        resolveMSTeamsAccountEntry(params.cfg.channels?.msteams?.accounts, account.accountId),
      ),
    port: account.config.webhook?.port ?? null,
    path: account.config.webhook?.path ?? "/api/messages",
  };
}
