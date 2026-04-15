import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";

export type TelegramTokenSource = "env" | "tokenFile" | "config" | "none";

export type TelegramTokenResolution = BaseTokenResolution & {
  source: TelegramTokenSource;
};

type RuntimeTokenValueResolution =
  | { status: "available"; value: string }
  | { status: "configured_unavailable" }
  | { status: "missing" };

function resolveEnvSecretRefValue(params: {
  cfg?: Pick<OpenClawConfig, "secrets">;
  provider: string;
  id: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      throw new Error(
        `Secret provider "${params.provider}" has source "${providerConfig.source}" but ref requests "env".`,
      );
    }
    if (providerConfig.allowlist && !providerConfig.allowlist.includes(params.id)) {
      throw new Error(
        `Environment variable "${params.id}" is not allowlisted in secrets.providers.${params.provider}.allowlist.`,
      );
    }
  } else if (
    params.provider !== resolveDefaultSecretProviderAlias({ secrets: params.cfg?.secrets }, "env")
  ) {
    throw new Error(
      `Secret provider "${params.provider}" is not configured (ref: env:${params.provider}:${params.id}).`,
    );
  }
  return normalizeSecretInputString((params.env ?? process.env)[params.id]);
}

function resolveRuntimeTokenValue(params: {
  cfg?: Pick<OpenClawConfig, "secrets">;
  value: unknown;
  path: string;
}): RuntimeTokenValueResolution {
  const resolved = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return {
      status: "available",
      value: resolved.value,
    };
  }
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  if (resolved.ref.source === "env") {
    const envValue = resolveEnvSecretRefValue({
      cfg: params.cfg,
      provider: resolved.ref.provider,
      id: resolved.ref.id,
    });
    if (envValue) {
      return {
        status: "available",
        value: envValue,
      };
    }
    return { status: "configured_unavailable" };
  }
  // Runtime resolution stays strict for non-env SecretRefs.
  resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg?.secrets?.defaults,
    mode: "strict",
  });
  return { status: "configured_unavailable" };
}

type ResolveTelegramTokenOpts = {
  envToken?: string | null;
  accountId?: string | null;
  logMissingFile?: (message: string) => void;
};

export function resolveTelegramToken(
  cfg?: OpenClawConfig,
  opts: ResolveTelegramTokenOpts = {},
): TelegramTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const telegramCfg = cfg?.channels?.telegram;

  // Account IDs are normalized for routing (e.g. lowercased). Config keys may not
  // be normalized, so resolve per-account config by matching normalized IDs.
  const resolveAccountCfg = (id: string): TelegramAccountConfig | undefined => {
    const accounts = telegramCfg?.accounts;
    return Array.isArray(accounts)
      ? undefined
      : resolveNormalizedAccountEntry(accounts, id, normalizeAccountId);
  };

  const accountCfg = resolveAccountCfg(
    accountId !== DEFAULT_ACCOUNT_ID ? accountId : DEFAULT_ACCOUNT_ID,
  );

  // When a non-default accountId is explicitly specified but not found in config,
  // decide whether to fall through to channel-level defaults based on whether
  // the config has an explicit accounts section (multi-bot setup).
  //
  // Multi-bot: accounts section exists with entries → block fallthrough to prevent
  // routing via the wrong bot's token.
  //
  // Single-bot: no accounts section (or empty) → allow fallthrough so that
  // binding-created accountIds inherit the channel-level token.
  // See: https://github.com/openclaw/openclaw/issues/53876
  if (accountId !== DEFAULT_ACCOUNT_ID && !accountCfg) {
    const accounts = telegramCfg?.accounts;
    const hasConfiguredAccounts =
      !!accounts &&
      typeof accounts === "object" &&
      !Array.isArray(accounts) &&
      Object.keys(accounts).length > 0;
    if (hasConfiguredAccounts) {
      opts.logMissingFile?.(
        `channels.telegram.accounts: unknown accountId "${accountId}" — not found in config, refusing channel-level fallback`,
      );
      return { token: "", source: "none" };
    }
  }

  const accountTokenFile = accountCfg?.tokenFile?.trim();
  if (accountTokenFile) {
    const token = tryReadSecretFileSync(
      accountTokenFile,
      `channels.telegram.accounts.${accountId}.tokenFile`,
      { rejectSymlink: true },
    );
    if (token) {
      return { token, source: "tokenFile" };
    }
    opts.logMissingFile?.(
      `channels.telegram.accounts.${accountId}.tokenFile not found or unreadable: ${accountTokenFile}`,
    );
    return { token: "", source: "none" };
  }

  const accountToken = resolveRuntimeTokenValue({
    cfg,
    value: accountCfg?.botToken,
    path: `channels.telegram.accounts.${accountId}.botToken`,
  });
  if (accountToken.status === "available") {
    return { token: accountToken.value, source: "config" };
  }
  if (accountToken.status === "configured_unavailable") {
    return { token: "", source: "none" };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const tokenFile = telegramCfg?.tokenFile?.trim();
  if (tokenFile) {
    const token = tryReadSecretFileSync(tokenFile, "channels.telegram.tokenFile", {
      rejectSymlink: true,
    });
    if (token) {
      return { token, source: "tokenFile" };
    }
    opts.logMissingFile?.(`channels.telegram.tokenFile not found or unreadable: ${tokenFile}`);
    return { token: "", source: "none" };
  }

  const configToken = resolveRuntimeTokenValue({
    cfg,
    value: telegramCfg?.botToken,
    path: "channels.telegram.botToken",
  });
  if (configToken.status === "available") {
    return { token: configToken.value, source: "config" };
  }
  if (configToken.status === "configured_unavailable") {
    return { token: "", source: "none" };
  }

  const envToken = allowEnv ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim() : "";
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
