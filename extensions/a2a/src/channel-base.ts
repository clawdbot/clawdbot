import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import {
  listA2aChannelAccountIds,
  resolveA2aChannelAccount,
  resolveDefaultA2aChannelAccountId,
} from "./accounts.js";
import { a2aPluginConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

export const A2A_CHANNEL_ID = "a2a" as const;

const a2aChannelRuntimeMeta = {
  id: A2A_CHANNEL_ID,
  label: "A2A",
  selectionLabel: "A2A (Agent-to-Agent Protocol)",
  docsPath: "/channels/a2a",
  docsLabel: "a2a",
  blurb: "Connect external agents through the A2A v1.0 protocol.",
  order: 75,
};

type A2aChannelPluginBase = Pick<
  ChannelPlugin<ResolvedA2aChannelAccount>,
  "id" | "meta" | "capabilities" | "reload" | "configSchema" | "setupContract" | "config"
>;

export function createA2aChannelPluginBase(): A2aChannelPluginBase {
  return {
    id: A2A_CHANNEL_ID,
    meta: a2aChannelRuntimeMeta,
    capabilities: { chatTypes: ["direct"] },
    reload: { configPrefixes: ["channels.a2a"] },
    configSchema: a2aPluginConfigSchema,
    setupContract: defineChannelSetupContract({
      // Setup must end with a usable channel: A2A stays unconfigured until at
      // least one peer credential exists, so the wizard collects that pair.
      fields: {
        advertisedUrl: {
          kind: "string",
          cli: {
            flags: "--advertised-url <url>",
            description: "Public Gateway origin published in the A2A agent card",
          },
        },
        peerName: {
          kind: "string",
          cli: { flags: "--peer-name <name>", description: "A2A peer identifier to authorize" },
        },
        peerToken: {
          kind: "string",
          sensitive: true,
          cli: { flags: "--peer-token <token>", description: "Bearer token for the A2A peer" },
        },
      },
      adapter: {
        applyAccountConfig: ({ cfg, input }) => {
          // SAFETY: defineChannelSetupContract validates input against the field keys declared above.
          const setup = input as {
            advertisedUrl?: string;
            peerName?: string;
            peerToken?: string;
          };
          const current = resolveA2aChannelAccount({ cfg }).config;
          const peerName = setup.peerName?.trim();
          const peerToken = setup.peerToken?.trim();
          const advertisedUrl = setup.advertisedUrl?.trim();
          return {
            ...cfg,
            channels: {
              ...cfg.channels,
              a2a: {
                ...current,
                enabled: true,
                ...(advertisedUrl ? { advertisedUrl } : {}),
                ...(peerName && peerToken
                  ? { peers: { ...current.peers, [peerName]: { token: peerToken } } }
                  : {}),
              },
            },
          };
        },
      },
    }),
    config: {
      listAccountIds: listA2aChannelAccountIds,
      resolveAccount: (cfg, accountId) => resolveA2aChannelAccount({ cfg, accountId }),
      defaultAccountId: resolveDefaultA2aChannelAccountId,
      isConfigured: (account) => account.configured,
      isEnabled: (account) => account.enabled,
      resolveAllowFrom: ({ cfg, accountId }) =>
        Object.keys(resolveA2aChannelAccount({ cfg, accountId }).config.peers ?? {}),
    },
  };
}
