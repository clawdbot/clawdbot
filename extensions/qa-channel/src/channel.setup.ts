import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  listQaChannelAccountIds,
  resolveDefaultQaChannelAccountId,
  resolveQaChannelAccount,
  type ResolvedQaChannelAccount,
} from "./accounts.js";
import { qaChannelPluginConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { applyQaSetup } from "./setup.js";
import type { CoreConfig } from "./types.js";

const CHANNEL_ID = "qa-channel" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

export const qaChannelSetupPlugin: ChannelPlugin<ResolvedQaChannelAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  reload: { configPrefixes: ["channels.qa-channel"] },
  configSchema: qaChannelPluginConfigSchema,
  setup: {
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyQaSetup({
        cfg,
        accountId,
        input: input as Record<string, unknown>,
      }),
  },
  config: {
    listAccountIds: (cfg) => listQaChannelAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultQaChannelAccountId(cfg as CoreConfig),
    isConfigured: (account) => account.configured,
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
  },
};
