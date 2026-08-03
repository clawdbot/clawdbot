// Qa Channel plugin module implements accounts behavior.
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig, QaChannelAccountConfig, ResolvedQaChannelAccount } from "./types.js";

const DEFAULT_POLL_TIMEOUT_MS = 1_000;

const {
  listAccountIds: listQaChannelAccountIds,
  resolveDefaultAccountId: resolveDefaultQaChannelAccountId,
  resolveAccountConfig: resolveMergedQaAccountConfig,
} = createAccountListHelpers<QaChannelAccountConfig>("qa-channel", {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  implicitDefaultAccount: {
    channelKeys: ["baseUrl"],
  },
});

export { listQaChannelAccountIds, resolveDefaultQaChannelAccountId };

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
