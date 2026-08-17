// Msteams plugin module implements account config behavior.
import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
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
  if (!accounts) {
    return undefined;
  }
  for (const [key, value] of Object.entries(accounts)) {
    if (normalizeAccountId(key) === accountId) {
      return value;
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
      // SAFETY: IDENTITY_FIELDS only contains writable keys shared by both config shapes.
      next[field] = account[field] as never;
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
  // SAFETY: MSTeamsConfig's public contract owns the optional multi-account fields.
  const channelConfig = cfg.channels?.msteams as MSTeamsMultiAccountConfig | undefined;
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
  const accountId = normalizeAccountId(params.accountId ?? DEFAULT_ACCOUNT_ID);
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
  const configured = Boolean(
    resolveMSTeamsCredentials(config, {
      allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
      pathPrefix:
        accountId === DEFAULT_ACCOUNT_ID
          ? "channels.msteams"
          : `channels.msteams.accounts.${accountId}`,
    }),
  );
  return {
    accountId,
    enabled: channelEnabled && accountEnabled,
    configured,
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
