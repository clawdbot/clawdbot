import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
// Msteams API module exposes the plugin public contract.
import type { ChannelDirectoryAdapter } from "openclaw/plugin-sdk/channel-contract";
import { listDirectoryEntriesFromSources } from "openclaw/plugin-sdk/directory-runtime";
import { resolveMSTeamsAccount, resolveMSTeamsAccountConfig } from "./src/accounts.js";
import { normalizeMSTeamsMessagingTarget } from "./src/resolve-allowlist.js";
import { resolveMSTeamsCredentials } from "./src/token.js";

function resolveDirectoryCredentials(
  msteamsCfg: ReturnType<typeof resolveMSTeamsAccountConfig>,
  accountId?: string | null,
) {
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  return resolveMSTeamsCredentials(msteamsCfg, {
    allowEnvFallback: resolvedAccountId === DEFAULT_ACCOUNT_ID,
    pathPrefix:
      resolvedAccountId === DEFAULT_ACCOUNT_ID
        ? "channels.msteams"
        : `channels.msteams.accounts.${resolvedAccountId}`,
  });
}

const msteamsDirectoryContractAdapter: ChannelDirectoryAdapter = {
  self: async ({ cfg, accountId }) => {
    const account = resolveMSTeamsAccount({ cfg, accountId });
    const creds = resolveDirectoryCredentials(account.config, account.accountId);
    return creds ? { kind: "user" as const, id: creds.appId, name: creds.appId } : null;
  },
  listPeers: async ({ cfg, accountId, query, limit }) => {
    const msteamsCfg = resolveMSTeamsAccountConfig(cfg, accountId);
    return listDirectoryEntriesFromSources({
      kind: "user",
      sources: [msteamsCfg.allowFrom ?? [], Object.keys(msteamsCfg.dms ?? {})],
      query,
      limit,
      normalizeId: (raw) => {
        const normalized = normalizeMSTeamsMessagingTarget(raw) ?? raw;
        const lowered = normalized.toLowerCase();
        return lowered.startsWith("user:") || lowered.startsWith("conversation:")
          ? normalized
          : `user:${normalized}`;
      },
    });
  },
  listGroups: async ({ cfg, accountId, query, limit }) => {
    const msteamsCfg = resolveMSTeamsAccountConfig(cfg, accountId);
    return listDirectoryEntriesFromSources({
      kind: "group",
      sources: [
        Object.values(msteamsCfg.teams ?? {}).flatMap((team) => Object.keys(team.channels ?? {})),
      ],
      query,
      limit,
      normalizeId: (raw) => `conversation:${raw.replace(/^conversation:/i, "").trim()}`,
    });
  },
};

export const msteamsDirectoryContractPlugin = {
  id: "msteams",
  directory: msteamsDirectoryContractAdapter,
};
