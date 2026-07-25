// Raft account resolution keeps CLI profiles scoped to their channel account.
import {
  createAccountListHelpers,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const RAFT_CHANNEL_ID = "raft" as const;

type RaftAccountConfig = {
  name?: string;
  enabled?: boolean;
  profile?: string;
  accounts?: Record<string, RaftAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedRaftAccount = {
  accountId: string;
  name: string | undefined;
  enabled: boolean;
  configured: boolean;
  profile: string | null;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers(RAFT_CHANNEL_ID, {
  normalizeAccountId,
  implicitDefaultAccount: {
    channelKeys: ["profile"],
    envVars: ["RAFT_PROFILE"],
  },
});

export const listRaftAccountIds = listAccountIds;
export const resolveDefaultRaftAccountId = resolveDefaultAccountId;

function resolveRaftConfig(cfg: OpenClawConfig): RaftAccountConfig | undefined {
  return cfg.channels?.[RAFT_CHANNEL_ID] as RaftAccountConfig | undefined;
}

export function resolveRaftAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedRaftAccount {
  const accountId = normalizeAccountId(params.accountId ?? resolveDefaultRaftAccountId(params.cfg));
  const channel = resolveRaftConfig(params.cfg);
  const merged = resolveMergedAccountConfig<RaftAccountConfig>({
    channelConfig: channel,
    accounts: channel?.accounts,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
  const configuredProfile = normalizeOptionalString(merged.profile);
  const envProfile =
    accountId === DEFAULT_ACCOUNT_ID
      ? normalizeOptionalString(process.env.RAFT_PROFILE)
      : undefined;
  const profile = configuredProfile ?? envProfile ?? null;

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled: channel?.enabled !== false && merged.enabled !== false,
    configured: Boolean(profile),
    profile,
  };
}
