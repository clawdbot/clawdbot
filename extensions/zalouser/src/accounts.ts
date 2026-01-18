import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

import { runZca, parseJsonOutput } from "./zca.js";
import type { ResolvedZalouserAccount, ZalouserAccountConfig, ZalouserConfig } from "./types.js";

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.zalouser as ZalouserConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listZalouserAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultZalouserAccountId(cfg: ClawdbotConfig): string {
  const zalouserConfig = cfg.channels?.zalouser as ZalouserConfig | undefined;
  if (zalouserConfig?.defaultAccount?.trim()) return zalouserConfig.defaultAccount.trim();
  const ids = listZalouserAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): ZalouserAccountConfig | undefined {
  const accounts = (cfg.channels?.zalouser as ZalouserConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as ZalouserAccountConfig | undefined;
}

function mergeZalouserAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): ZalouserAccountConfig {
  const raw = (cfg.channels?.zalouser ?? {}) as ZalouserConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveZcaProfile(config: ZalouserAccountConfig, accountId: string): string {
  if (config.profile?.trim()) return config.profile.trim();
  if (process.env.ZCA_PROFILE?.trim()) return process.env.ZCA_PROFILE.trim();
  if (accountId !== DEFAULT_ACCOUNT_ID) return accountId;
  return "default";
}

export async function checkZcaAuthenticated(profile: string): Promise<boolean> {
  const result = await runZca(["auth", "status"], { profile, timeout: 5000 });
  return result.ok;
}

export async function resolveZalouserAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): Promise<ResolvedZalouserAccount> {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.zalouser as ZalouserConfig | undefined)?.enabled !== false;
  const merged = mergeZalouserAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const profile = resolveZcaProfile(merged, accountId);
  const authenticated = await checkZcaAuthenticated(profile);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    profile,
    authenticated,
    config: merged,
  };
}

export function resolveZalouserAccountSync(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedZalouserAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.zalouser as ZalouserConfig | undefined)?.enabled !== false;
  const merged = mergeZalouserAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const profile = resolveZcaProfile(merged, accountId);

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    profile,
    authenticated: false, // unknown without async check
    config: merged,
  };
}

export async function listEnabledZalouserAccounts(
  cfg: ClawdbotConfig,
): Promise<ResolvedZalouserAccount[]> {
  const ids = listZalouserAccountIds(cfg);
  const accounts = await Promise.all(
    ids.map((accountId) => resolveZalouserAccount({ cfg, accountId }))
  );
  return accounts.filter((account) => account.enabled);
}

export async function getZcaUserInfo(profile: string): Promise<{ userId?: string; displayName?: string } | null> {
  const result = await runZca(["me", "info", "-j"], { profile, timeout: 10000 });
  if (!result.ok) return null;
  return parseJsonOutput<{ userId?: string; displayName?: string }>(result.stdout);
}

export type { ResolvedZalouserAccount } from "./types.js";
