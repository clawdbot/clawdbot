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
      fields: {},
      adapter: {
        applyAccountConfig: ({ cfg }) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            a2a: { ...resolveA2aChannelAccount({ cfg }).config, enabled: true },
          },
        }),
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
