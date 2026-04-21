import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { ResolvedQQBotAccount, QQBotAccountConfig } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";

interface QQBotChannelConfig extends QQBotAccountConfig {
  accounts?: Record<string, QQBotAccountConfig>;
  defaultAccount?: string;
}

function normalizeConfiguredDefaultAccountId(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

function normalizeQQBotAccountConfig(account: QQBotAccountConfig | undefined): QQBotAccountConfig {
  if (!account) {
    return {};
  }
  return {
    ...account,
    ...(account.audioFormatPolicy ? { audioFormatPolicy: { ...account.audioFormatPolicy } } : {}),
  };
}

function normalizeAppId(raw: unknown): string {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (typeof raw === "number") {
    return String(raw);
  }
  return "";
}

function buildQQBotAccountConfigPatch(input: {
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  name?: string;
}): Partial<QQBotAccountConfig> {
  return {
    ...(input.appId ? { appId: input.appId } : {}),
    ...(input.clientSecret
      ? { clientSecret: input.clientSecret, clientSecretFile: undefined }
      : input.clientSecretFile
        ? { clientSecretFile: input.clientSecretFile, clientSecret: undefined }
        : {}),
    ...(input.name ? { name: input.name } : {}),
  };
}

/** List all configured QQBot account IDs. */
export function listQQBotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  if (qqbot?.appId || process.env.QQBOT_APP_ID) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/** Resolve the default QQBot account ID. */
export function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  const configuredDefaultAccountId = normalizeConfiguredDefaultAccountId(qqbot?.defaultAccount);
  if (
    configuredDefaultAccountId &&
    (configuredDefaultAccountId === DEFAULT_ACCOUNT_ID ||
      Boolean(qqbot?.accounts?.[configuredDefaultAccountId]?.appId))
  ) {
    return configuredDefaultAccountId;
  }
  if (qqbot?.appId || process.env.QQBOT_APP_ID) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (qqbot?.accounts) {
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0) {
      return ids[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

/** Resolve QQBot account config for runtime or setup flows. */
export function resolveQQBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
  opts?: { allowUnresolvedSecretRef?: boolean },
): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? resolveDefaultQQBotAccountId(cfg);
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  let accountConfig: QQBotAccountConfig = {};
  let appId = "";
  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // Default account reads from top-level config and keeps the full field surface.
    accountConfig = normalizeQQBotAccountConfig(qqbot);
    appId = normalizeAppId(qqbot?.appId);
  } else {
    // Named accounts read from channels.qqbot.accounts.
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = normalizeQQBotAccountConfig(account);
    appId = normalizeAppId(account?.appId);
  }

  const clientSecretPath =
    resolvedAccountId === DEFAULT_ACCOUNT_ID
      ? "channels.qqbot.clientSecret"
      : `channels.qqbot.accounts.${resolvedAccountId}.clientSecret`;

  // Resolve clientSecret from config, file, or environment.
  if (hasConfiguredSecretInput(accountConfig.clientSecret)) {
    clientSecret = opts?.allowUnresolvedSecretRef
      ? (normalizeSecretInputString(accountConfig.clientSecret) ?? "")
      : (normalizeResolvedSecretInputString({
          value: accountConfig.clientSecret,
          path: clientSecretPath,
        }) ?? "");
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    try {
      clientSecret = fs.readFileSync(accountConfig.clientSecretFile, "utf8").trim();
      secretSource = "file";
    } catch {
      secretSource = "none";
    }
  } else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = "env";
  }

  // AppId can also fall back to an environment variable.
  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(process.env.QQBOT_APP_ID);
  }

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    markdownSupport: accountConfig.markdownSupport !== false,
    config: accountConfig,
  };
}

/** Apply account config updates back into the OpenClaw config object. */
export function applyQQBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: {
    appId?: string;
    clientSecret?: string;
    clientSecretFile?: string;
    name?: string;
  },
): OpenClawConfig {
  const next = { ...cfg };
  const accountConfigPatch = buildQQBotAccountConfigPatch(input);

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // Default allowFrom to ["*"] when not yet configured.
    const existingConfig = (next.channels?.qqbot as QQBotChannelConfig) || {};
    const allowFrom = existingConfig.allowFrom ?? ["*"];

    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> | undefined),
        enabled: true,
        allowFrom,
        ...accountConfigPatch,
      },
    };
  } else {
    // Default allowFrom to ["*"] when not yet configured.
    const existingAccountConfig =
      (next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {};
    const allowFrom = existingAccountConfig.allowFrom ?? ["*"];

    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> | undefined),
        enabled: true,
        accounts: {
          ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts,
          [accountId]: {
            ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId],
            enabled: true,
            allowFrom,
            ...accountConfigPatch,
          },
        },
      },
    };
  }

  return next;
}
