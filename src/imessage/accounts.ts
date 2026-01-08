import type { ClawdbotConfig } from "../config/config.js";
import type { IMessageAccountConfig } from "../config/types.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../routing/session-key.js";

export type ResolvedIMessageAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  config: IMessageAccountConfig;
};

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = cfg.imessage?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listIMessageAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultIMessageAccountId(cfg: ClawdbotConfig): string {
  const ids = listIMessageAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): IMessageAccountConfig | undefined {
  const accounts = cfg.imessage?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as IMessageAccountConfig | undefined;
}

function mergeIMessageAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): IMessageAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.imessage ??
    {}) as IMessageAccountConfig & { accounts?: unknown };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveIMessageAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedIMessageAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.imessage?.enabled !== false;
  const merged = mergeIMessageAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: merged.name?.trim() || undefined,
    config: merged,
  };
}

export function listEnabledIMessageAccounts(
  cfg: ClawdbotConfig,
): ResolvedIMessageAccount[] {
  return listIMessageAccountIds(cfg)
    .map((accountId) => resolveIMessageAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
