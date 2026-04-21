/**
 * QQBot config resolution (pure logic layer).
 * QQBot 配置解析（纯逻辑层）。
 *
 * Resolves account IDs, default account selection, and base account
 * info from raw config objects. Secret/credential resolution is
 * intentionally left to the outer layer (src/bridge/config.ts) so that
 * this module stays framework-agnostic and self-contained.
 */

import { getPlatformAdapter } from "../adapter/index.js";
import {
  asOptionalObjectRecord as asRecord,
  normalizeOptionalLowercaseString,
  normalizeStringifiedOptionalString,
  readStringField as readString,
} from "../utils/string-normalize.js";

/**
 * Default account ID, used for the unnamed top-level account.
 * 默认账号 ID，用于顶层配置中未命名的账号。
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Internal shape of the channels.qqbot config section.
 * channels.qqbot 配置节的内部结构。
 */
interface QQBotChannelConfig {
  appId?: unknown;
  clientSecret?: unknown;
  clientSecretFile?: string;
  accounts?: Record<string, Record<string, unknown>>;
  defaultAccount?: unknown;
  [key: string]: unknown;
}

/**
 * Base account resolution result (without credentials).
 * 账号基础解析结果（不含凭证信息）。
 *
 * The outer config.ts layer extends this with clientSecret / secretSource.
 */
export interface ResolvedAccountBase {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  systemPrompt?: string;
  markdownSupport: boolean;
  config: Record<string, unknown>;
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

function normalizeAccountConfig(
  account: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!account) {
    return {};
  }
  const audioPolicy = asRecord(account.audioFormatPolicy);
  return {
    ...account,
    ...(audioPolicy ? { audioFormatPolicy: { ...audioPolicy } } : {}),
  };
}

function readQQBotSection(cfg: Record<string, unknown>): QQBotChannelConfig | undefined {
  const channels = asRecord(cfg.channels);
  return asRecord(channels?.qqbot) as QQBotChannelConfig | undefined;
}

/**
 * List all configured QQBot account IDs.
 * 列出所有已配置的 QQBot 账号 ID。
 */
export function listAccountIds(cfg: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const qqbot = readQQBotSection(cfg);

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

/**
 * Resolve the default QQBot account ID.
 * 解析默认 QQBot 账号 ID（优先级：defaultAccount > 顶层 appId > 第一个命名账号）。
 */
export function resolveDefaultAccountId(cfg: Record<string, unknown>): string {
  const qqbot = readQQBotSection(cfg);
  const configuredDefaultAccountId = normalizeOptionalLowercaseString(qqbot?.defaultAccount);
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

/**
 * Resolve base account info (without credentials).
 * 解析账号基础信息（不含凭证）。
 *
 * Resolves everything except Secret/credential fields. The outer
 * config.ts layer calls this and adds Secret handling on top.
 */
export function resolveAccountBase(
  cfg: Record<string, unknown>,
  accountId?: string | null,
): ResolvedAccountBase {
  const resolvedAccountId = accountId ?? resolveDefaultAccountId(cfg);
  const qqbot = readQQBotSection(cfg);

  let accountConfig: Record<string, unknown> = {};
  let appId = "";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    accountConfig = normalizeAccountConfig(asRecord(qqbot));
    appId = normalizeAppId(qqbot?.appId);
  } else {
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = normalizeAccountConfig(asRecord(account));
    appId = normalizeAppId(asRecord(account)?.appId);
  }

  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(process.env.QQBOT_APP_ID);
  }

  return {
    accountId: resolvedAccountId,
    name: readString(accountConfig, "name"),
    enabled: accountConfig.enabled !== false,
    appId,
    systemPrompt: readString(accountConfig, "systemPrompt"),
    markdownSupport: accountConfig.markdownSupport !== false,
    config: accountConfig,
  };
}

// ---- Account config apply ----

export interface ApplyAccountInput {
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  name?: string;
}

/** Apply account config updates into a raw config object. */
export function applyAccountConfig(
  cfg: Record<string, unknown>,
  accountId: string,
  input: ApplyAccountInput,
): Record<string, unknown> {
  const next = { ...cfg };
  const channels = asRecord(cfg.channels) ?? {};
  const existingQQBot = asRecord(channels.qqbot) ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const allowFrom = (existingQQBot.allowFrom as unknown[]) ?? ["*"];
    next.channels = {
      ...channels,
      qqbot: {
        ...existingQQBot,
        enabled: true,
        allowFrom,
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.clientSecret
          ? { clientSecret: input.clientSecret, clientSecretFile: undefined }
          : input.clientSecretFile
            ? { clientSecretFile: input.clientSecretFile, clientSecret: undefined }
            : {}),
        ...(input.name ? { name: input.name } : {}),
      },
    };
  } else {
    const accounts = (existingQQBot.accounts ?? {}) as Record<string, Record<string, unknown>>;
    const existingAccount = accounts[accountId] ?? {};
    const allowFrom = (existingAccount.allowFrom as unknown[]) ?? ["*"];
    next.channels = {
      ...channels,
      qqbot: {
        ...existingQQBot,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...existingAccount,
            enabled: true,
            allowFrom,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.clientSecret
              ? { clientSecret: input.clientSecret, clientSecretFile: undefined }
              : input.clientSecretFile
                ? { clientSecretFile: input.clientSecretFile, clientSecret: undefined }
                : {}),
            ...(input.name ? { name: input.name } : {}),
          },
        },
      },
    };
  }

  return next;
}

// ---- Account status helpers ----

/** Resolved account shape expected by isAccountConfigured / describeAccount. */
export interface AccountSnapshot {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret?: string;
  secretSource?: string;
  config: Record<string, unknown> & {
    clientSecret?: unknown;
    clientSecretFile?: string;
  };
}

/** Check whether a QQBot account has been fully configured. */
export function isAccountConfigured(account: AccountSnapshot | undefined): boolean {
  return Boolean(
    account?.appId &&
    (Boolean(account?.clientSecret) ||
      getPlatformAdapter().hasConfiguredSecret(account?.config?.clientSecret) ||
      Boolean(account?.config?.clientSecretFile?.trim())),
  );
}

/** Build a summary description of an account. */
export function describeAccount(account: AccountSnapshot | undefined) {
  return {
    accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
    name: account?.name,
    enabled: account?.enabled ?? false,
    configured: isAccountConfigured(account),
    tokenSource: account?.secretSource,
  };
}

/** Normalize allowFrom entries into uppercase strings without the qqbot: prefix. */
export function formatAllowFrom(allowFrom: Array<string | number> | undefined | null): string[] {
  return (allowFrom ?? [])
    .map((entry) => normalizeStringifiedOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replace(/^qqbot:/i, ""))
    .map((entry) => entry.toUpperCase());
}
