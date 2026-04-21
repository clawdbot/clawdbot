import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { qqbotConfigAdapter, qqbotMeta, qqbotSetupAdapterShared } from "./channel-config-shared.js";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import { qqbotSetupWizard } from "./setup-surface.js";
import type { ResolvedQQBotAccount } from "./types.js";

export const qqbotBasePluginFields = {
  id: "qqbot",
  setupWizard: qqbotSetupWizard,
  meta: {
    ...qqbotMeta,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  configSchema: qqbotChannelConfigSchema,
  config: {
    ...qqbotConfigAdapter,
  },
  setup: {
    ...qqbotSetupAdapterShared,
  },
} satisfies Partial<ChannelPlugin<ResolvedQQBotAccount>> & {
  id: "qqbot";
};
