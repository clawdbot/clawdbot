import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { listCombinedAccountIds } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { resolveDefaultDiscordAccountId } from "./accounts.js";
import { mergeDiscordAccountConfig, resolveDiscordAccountConfig } from "./accounts.js";
import type { DiscordAccountConfig } from "./runtime-api.js";
import { resolveDiscordToken } from "./token.js";

type InspectedDiscordSetupAccount = {
  accountId: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: "available" | "configured_unavailable" | "missing";
  configured: boolean;
  config: DiscordAccountConfig;
};

function inspectConfiguredToken(value: unknown): {
  token: string;
  tokenSource: "config";
  tokenStatus: "available" | "configured_unavailable";
} | null {
  const normalized = normalizeSecretInputString(value);
  if (normalized) {
    return {
      token: normalized.replace(/^Bot\s+/i, ""),
      tokenSource: "config",
      tokenStatus: "available",
    };
  }
  if (hasConfiguredSecretInput(value)) {
    return {
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    };
  }
  return null;
}

export function listDiscordSetupAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.discord?.accounts;
  return listCombinedAccountIds({
    configuredAccountIds:
      accounts && typeof accounts === "object" && !Array.isArray(accounts)
        ? Object.keys(accounts).map((accountId) => normalizeAccountId(accountId))
        : [],
    implicitAccountId: DEFAULT_ACCOUNT_ID,
  });
}

export function resolveDefaultDiscordSetupAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultDiscordAccountId(cfg);
}

export function resolveDiscordSetupAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { accountId: string; config: DiscordAccountConfig } {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordSetupAccountId(params.cfg),
  );
  return {
    accountId,
    config: mergeDiscordAccountConfig(params.cfg, accountId),
  };
}

export function inspectDiscordSetupAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedDiscordSetupAccount {
  const { accountId, config } = resolveDiscordSetupAccountConfig(params);
  const enabled = params.cfg.channels?.discord?.enabled !== false && config.enabled !== false;
  const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
  const hasAccountToken = Boolean(
    accountConfig &&
    Object.prototype.hasOwnProperty.call(accountConfig as Record<string, unknown>, "token"),
  );
  const accountToken = inspectConfiguredToken(accountConfig?.token);
  if (accountToken) {
    return {
      accountId,
      enabled,
      token: accountToken.token,
      tokenSource: accountToken.tokenSource,
      tokenStatus: accountToken.tokenStatus,
      configured: true,
      config,
    };
  }
  if (hasAccountToken) {
    return {
      accountId,
      enabled,
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      configured: false,
      config,
    };
  }

  const channelToken = inspectConfiguredToken(params.cfg.channels?.discord?.token);
  if (channelToken) {
    return {
      accountId,
      enabled,
      token: channelToken.token,
      tokenSource: channelToken.tokenSource,
      tokenStatus: channelToken.tokenStatus,
      configured: true,
      config,
    };
  }

  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  if (tokenResolution.token) {
    return {
      accountId,
      enabled,
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      tokenStatus: "available",
      configured: true,
      config,
    };
  }

  return {
    accountId,
    enabled,
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    configured: false,
    config,
  };
}
