import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { CoreConfig, QaChannelAccountConfig, ResolvedQaChannelAccount } from "./types.js";

const DEFAULT_POLL_TIMEOUT_MS = 1_000;

const {
  listAccountIds: listQaChannelAccountIds,
  resolveDefaultAccountId: resolveDefaultQaChannelAccountId,
} = createAccountListHelpers("qa-channel", { normalizeAccountId });

export { listQaChannelAccountIds, resolveDefaultQaChannelAccountId };

function resolveMergedQaAccountConfig(cfg: CoreConfig, accountId: string): QaChannelAccountConfig {
  return resolveMergedAccountConfig<QaChannelAccountConfig>({
    channelConfig: cfg.channels?.["qa-channel"] as QaChannelAccountConfig | undefined,
    accounts: cfg.channels?.["qa-channel"]?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

export function resolveQaChannelAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedQaChannelAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = resolveMergedQaAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.["qa-channel"]?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const baseUrl = merged.baseUrl?.trim() ?? "";
  const botUserId = merged.botUserId?.trim() || "openclaw";
  const botDisplayName = merged.botDisplayName?.trim() || "OpenClaw QA";
  return {
    accountId,
    enabled,
    configured: Boolean(baseUrl),
    name: normalizeOptionalString(merged.name),
    baseUrl,
    botUserId,
    botDisplayName,
    pollTimeoutMs: merged.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    config: {
      ...merged,
      allowFrom: merged.allowFrom ?? ["*"],
    },
  };
}

export function listEnabledQaChannelAccounts(cfg: CoreConfig): ResolvedQaChannelAccount[] {
  return listQaChannelAccountIds(cfg)
    .map((accountId) => resolveQaChannelAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export { DEFAULT_ACCOUNT_ID };
export type { ResolvedQaChannelAccount } from "./types.js";
