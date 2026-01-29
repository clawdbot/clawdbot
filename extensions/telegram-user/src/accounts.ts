import type { CoreConfig, TelegramUserAccountConfig } from "./types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

export type TelegramUserCredentials = {
  apiId?: number;
  apiHash?: string;
  apiIdSource: "env" | "config" | "none";
  apiHashSource: "env" | "config" | "none";
};

export type ResolvedTelegramUserAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  credentials: TelegramUserCredentials;
  config: TelegramUserAccountConfig;
};

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): TelegramUserAccountConfig | undefined {
  const accounts = cfg.channels?.["telegram-user"]?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId] as TelegramUserAccountConfig | undefined;
  if (direct) return direct;
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as TelegramUserAccountConfig | undefined) : undefined;
}

function mergeTelegramUserAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): TelegramUserAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.["telegram-user"] ??
    {}) as TelegramUserAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveCredentials(cfg: CoreConfig, accountId: string): TelegramUserCredentials {
  const merged = mergeTelegramUserAccountConfig(cfg, accountId);
  const envApiId =
    accountId === DEFAULT_ACCOUNT_ID
      ? Number.parseInt(process.env.TELEGRAM_USER_API_ID ?? "", 10)
      : Number.NaN;
  const envApiHash =
    accountId === DEFAULT_ACCOUNT_ID ? process.env.TELEGRAM_USER_API_HASH?.trim() : undefined;
  const apiId =
    Number.isFinite(envApiId) && envApiId > 0 ? envApiId : merged.apiId ?? undefined;
  const apiHash = envApiHash || merged.apiHash?.trim();
  return {
    apiId,
    apiHash,
    apiIdSource:
      Number.isFinite(envApiId) && envApiId > 0
        ? "env"
        : merged.apiId
          ? "config"
          : "none",
    apiHashSource: envApiHash ? "env" : merged.apiHash ? "config" : "none",
  };
}

export function listTelegramUserAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.["telegram-user"]?.accounts;
  const ids = accounts ? Object.keys(accounts).filter(Boolean) : [];
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  if (!ids.includes(DEFAULT_ACCOUNT_ID)) ids.push(DEFAULT_ACCOUNT_ID);
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultTelegramUserAccountId(cfg: CoreConfig): string {
  const ids = listTelegramUserAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveTelegramUserAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedTelegramUserAccount {
  const normalized = normalizeAccountId(params.accountId);
  const merged = mergeTelegramUserAccountConfig(params.cfg, normalized);
  const baseEnabled = params.cfg.channels?.["telegram-user"]?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  return {
    accountId: normalized,
    enabled,
    name: merged.name?.trim() || undefined,
    credentials: resolveCredentials(params.cfg, normalized),
    config: merged,
  };
}
