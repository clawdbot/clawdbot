import {
  createAccountListHelpers,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/account-helpers";
// Zalouser plugin module implements accounts behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedZalouserAccount, ZalouserAccountConfig, ZalouserConfig } from "./types.js";

const loadZalouserAccountsRuntime = createLazyRuntimeModule(() => import("./accounts.runtime.js"));

const {
  listAccountIds: listZalouserAccountIds,
  resolveDefaultAccountId: resolveDefaultZalouserAccountId,
  resolveAccountConfig: resolveMergedZalouserAccountConfig,
} = createAccountListHelpers<ZalouserAccountConfig>("zalouser", {
  omitKeys: ["defaultAccount"],
  implicitDefaultAccount: {
    channelKeys: ["profile"],
    envVars: ["ZALOUSER_PROFILE", "ZCA_PROFILE"],
  },
});
export { listZalouserAccountIds, resolveDefaultZalouserAccountId };

function mergeZalouserAccountConfig(cfg: OpenClawConfig, accountId: string): ZalouserAccountConfig {
  const merged = resolveMergedZalouserAccountConfig(cfg, accountId);
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
    mediaMaxBytes: resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId,
      resolveChannelLimitMb: () => merged.mediaMaxMb,
    }),
    config: merged,
  };
}

export async function checkZcaAuthenticated(
  profile: string,
  options?: { credentialPersistence?: "persist" | "read-only" },
): Promise<boolean> {
  return await (await loadZalouserAccountsRuntime()).checkZaloAuthenticated(profile, options);
}

export type { ResolvedZalouserAccount } from "./types.js";
