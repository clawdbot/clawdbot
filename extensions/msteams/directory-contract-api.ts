// Msteams API module exposes the plugin public contract.
import type { ChannelDirectoryAdapter } from "openclaw/plugin-sdk/channel-contract";
import { listDirectoryEntriesFromSources } from "openclaw/plugin-sdk/directory-runtime";
import { normalizeMSTeamsMessagingTarget } from "./src/resolve-allowlist.js";
import { resolveMSTeamsCredentials } from "./src/token.js";

const msteamsDirectoryContractAdapter: ChannelDirectoryAdapter = {
  self: async ({ cfg }) => {
    const creds = resolveMSTeamsCredentials(cfg.channels?.msteams);
    return creds ? { kind: "user" as const, id: creds.appId, name: creds.appId } : null;
  },
  listPeers: async ({ cfg, query, limit }) =>
    listDirectoryEntriesFromSources({
      kind: "user",
      sources: [
        cfg.channels?.msteams?.allowFrom ?? [],
        Object.keys(cfg.channels?.msteams?.dms ?? {}),
      ],
      query,
      limit,
      normalizeId: (raw) => {
        const normalized = normalizeMSTeamsMessagingTarget(raw) ?? raw;
        const lowered = normalized.toLowerCase();
        return lowered.startsWith("user:") || lowered.startsWith("conversation:")
          ? normalized
          : `user:${normalized}`;
      },
    }),
  listGroups: async ({ cfg, query, limit }) =>
    listDirectoryEntriesFromSources({
      kind: "group",
      sources: [
        Object.values(cfg.channels?.msteams?.teams ?? {}).flatMap((team) =>
          Object.keys(team.channels ?? {}),
        ),
      ],
      query,
      limit,
      normalizeId: (raw) => `conversation:${raw.replace(/^conversation:/i, "").trim()}`,
    }),
};

export const msteamsDirectoryContractPlugin = {
  id: "msteams",
  directory: msteamsDirectoryContractAdapter,
};
