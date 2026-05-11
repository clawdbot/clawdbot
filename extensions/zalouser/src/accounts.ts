import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedZalouserAccount, ZalouserAccountConfig, ZalouserConfig } from "./types.js";

let zalouserAccountsRuntimePromise: Promise<typeof import("./accounts.runtime.js")> | undefined;

async function loadZalouserAccountsRuntime() {
  zalouserAccountsRuntimePromise ??= import("./accounts.runtime.js");
  return await zalouserAccountsRuntimePromise;
}

const {
  listAccountIds: listZalouserAccountIds,
  resolveDefaultAccountId: resolveDefaultZalouserAccountId,
} = createAccountListHelpers("zalouser");
export { listZalouserAccountIds, resolveDefaultZalouserAccountId };

function mergeZalouserAccountConfig(cfg: OpenClawConfig, accountId: string): ZalouserAccountConfig {
  const merged = resolveMergedAccountConfig<ZalouserAccountConfig>({
    channelConfig: cfg.channels?.zalouser as ZalouserAccountConfig | undefined,
    accounts: (cfg.channels?.zalouser as ZalouserConfig | undefined)?.accounts as
      | Record<string, Partial<ZalouserAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
  return {
    ...merged,
    // Match Telegram's safe default: groups stay allowlisted unless explicitly opened.
    groupPolicy: merged.groupPolicy ?? "allowlist",
  };
}

function resolveProfile(config: ZalouserAccountConfig, accountId: string): string {
  if (config.profile?.trim()) {
    return config.profile.trim();
  }
  if (process.env.ZALOUSER_PROFILE?.trim()) {
    return process.env.ZALOUSER_PROFILE.trim();
  }
  if (process.env.ZCA_PROFILE?.trim()) {
    return process.env.ZCA_PROFILE.trim();
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return accountId;
  }
  return "default";
}

function resolveZalouserAccountBase(params: { cfg: OpenClawConfig; accountId?: string | null }) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultZalouserAccountId(params.cfg),
  );
  const baseEnabled =
    (params.cfg.channels?.zalouser as ZalouserConfig | undefined)?.enabled !== false;
  const merged = mergeZalouserAccountConfig(params.cfg, accountId);
  return {
    accountId,
    enabled: baseEnabled && merged.enabled !== false,
    merged,
    profile: resolveProfile(merged, accountId),
  };
}

export async function resolveZalouserAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ResolvedZalouserAccount> {
  const { accountId, enabled, merged, profile } = resolveZalouserAccountBase(params);
  const authenticated = await (await loadZalouserAccountsRuntime()).checkZaloAuthenticated(profile);

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled,
    profile,
    authenticated,
    config: merged,
  };
}

export function resolveZalouserAccountSync(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZalouserAccount {
  const { accountId, enabled, merged, profile } = resolveZalouserAccountBase(params);

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled,
    profile,
    authenticated: false,
    config: merged,
  };
}

export async function listEnabledZalouserAccounts(
  cfg: OpenClawConfig,
): Promise<ResolvedZalouserAccount[]> {
  const ids = listZalouserAccountIds(cfg);
  const accounts = await Promise.all(
    ids.map((accountId) => resolveZalouserAccount({ cfg, accountId })),
  );
  return accounts.filter((account) => account.enabled);
}

export async function getZcaUserInfo(
  profile: string,
): Promise<{ userId?: string; displayName?: string } | null> {
  const info = await (await loadZalouserAccountsRuntime()).getZaloUserInfo(profile);
  if (!info) {
    return null;
  }
  return {
    userId: info.userId,
    displayName: info.displayName,
  };
}

export async function checkZcaAuthenticated(profile: string): Promise<boolean> {
  return await (await loadZalouserAccountsRuntime()).checkZaloAuthenticated(profile);
}

export type { ResolvedZalouserAccount } from "./types.js";
