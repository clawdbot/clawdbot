import {
  createAccountActionGate,
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { DiscordAccountConfig, DiscordActionConfig, OpenClawConfig } from "./runtime-api.js";
import { resolveDiscordToken } from "./token.js";

export type ResolvedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  config: DiscordAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("discord");
export const listDiscordAccountIds = listAccountIds;
export const resolveDefaultDiscordAccountId = resolveDefaultAccountId;

export function resolveDiscordAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DiscordAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}

export function mergeDiscordAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DiscordAccountConfig {
  return resolveMergedAccountConfig<DiscordAccountConfig>({
    channelConfig: cfg.channels?.discord as DiscordAccountConfig | undefined,
    accounts: cfg.channels?.discord?.accounts as
      | Record<string, Partial<DiscordAccountConfig>>
      | undefined,
    accountId,
  });
}

export function createDiscordActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof DiscordActionConfig, defaultValue?: boolean) => boolean {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  return createAccountActionGate({
    baseActions: params.cfg.channels?.discord?.actions,
    accountActions: resolveDiscordAccountConfig(params.cfg, accountId)?.actions,
  });
}

export function resolveDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveDiscordToken(params.cfg, { accountId });
  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

export function resolveDiscordMaxLinesPerMessage(params: {
  cfg: OpenClawConfig;
  discordConfig?: DiscordAccountConfig | null;
  accountId?: string | null;
}): number | undefined {
  if (typeof params.discordConfig?.maxLinesPerMessage === "number") {
    return params.discordConfig.maxLinesPerMessage;
  }
  return resolveDiscordAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).config.maxLinesPerMessage;
}

function resolveDiscordAccountTokenOwner(params: {
  cfg: OpenClawConfig;
  token: string;
}): string | undefined {
  const token = params.token.trim();
  if (!token) {
    return undefined;
  }
  let owner: { accountId: string; priority: number; index: number } | undefined;
  const accountIds = listDiscordAccountIds(params.cfg);
  for (const [index, accountId] of accountIds.entries()) {
    const account = resolveDiscordAccount({ cfg: params.cfg, accountId });
    const accountToken = account.token.trim();
    if (!account.enabled || accountToken !== token) {
      continue;
    }
    const priority = account.tokenSource === "config" ? 2 : account.tokenSource === "env" ? 1 : 0;
    if (!owner || priority > owner.priority) {
      owner = { accountId: account.accountId, priority, index };
      continue;
    }
    if (priority === owner.priority && index < owner.index) {
      owner = { accountId: account.accountId, priority, index };
    }
  }
  return owner?.accountId;
}

export function resolveDiscordDuplicateTokenOwner(params: {
  cfg: OpenClawConfig;
  account: ResolvedDiscordAccount;
}): string | undefined {
  const owner = resolveDiscordAccountTokenOwner({
    cfg: params.cfg,
    token: params.account.token,
  });
  return owner && owner !== params.account.accountId ? owner : undefined;
}

export function isDiscordAccountEnabledForRuntime(
  account: ResolvedDiscordAccount,
  cfg: OpenClawConfig,
): boolean {
  return account.enabled && !resolveDiscordDuplicateTokenOwner({ cfg, account });
}

export function resolveDiscordAccountDisabledReason(
  account: ResolvedDiscordAccount,
  cfg: OpenClawConfig,
): string {
  if (!account.enabled) {
    return "disabled";
  }
  const owner = resolveDiscordDuplicateTokenOwner({ cfg, account });
  return owner ? `duplicate bot token; using account "${owner}"` : "disabled";
}

export function listEnabledDiscordAccounts(cfg: OpenClawConfig): ResolvedDiscordAccount[] {
  return listDiscordAccountIds(cfg)
    .map((accountId) => resolveDiscordAccount({ cfg, accountId }))
    .filter((account) => isDiscordAccountEnabledForRuntime(account, cfg));
}
