import type { FeishuAccountConfig, MoltbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

export type ResolvedFeishuAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  config: FeishuAccountConfig;
};

function listConfiguredAccountIds(cfg: MoltbotConfig): string[] {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listFeishuAccountIds(cfg: MoltbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultFeishuAccountId(cfg: MoltbotConfig): string {
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: MoltbotConfig,
  accountId: string,
): FeishuAccountConfig | undefined {
  const accounts = cfg.channels?.feishu?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as FeishuAccountConfig | undefined;
}

function mergeFeishuAccountConfig(cfg: MoltbotConfig, accountId: string): FeishuAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.feishu ?? {}) as FeishuAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveFeishuAccount(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.feishu?.enabled !== false;
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const appId = merged.appId?.trim() || undefined;
  const appSecret = merged.appSecret?.trim() || undefined;
  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    appId,
    appSecret,
    config: merged,
  };
}

export function listEnabledFeishuAccounts(cfg: MoltbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
