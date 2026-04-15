import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
  listDirectoryEntriesFromSources,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { ChannelPlugin } from "./channel-api.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { resolveMSTeamsCredentials } from "./token.js";

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

export const msteamsDirectoryAdapter: NonNullable<ChannelPlugin["directory"]> =
  createChannelDirectoryAdapter({
    self: async ({ cfg }) => {
      const creds = resolveMSTeamsCredentials(cfg.channels?.msteams);
      if (!creds) {
        return null;
      }
      return { kind: "user" as const, id: creds.appId, name: creds.appId };
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
          const lowered = normalizeLowercaseStringOrEmpty(normalized);
          if (lowered.startsWith("user:") || lowered.startsWith("conversation:")) {
            return normalized;
          }
          return `user:${normalized}`;
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
    ...createRuntimeDirectoryLiveAdapter({
      getRuntime: loadMSTeamsChannelRuntime,
      listPeersLive: (runtime) => runtime.listMSTeamsDirectoryPeersLive,
      listGroupsLive: (runtime) => runtime.listMSTeamsDirectoryGroupsLive,
    }),
  });
