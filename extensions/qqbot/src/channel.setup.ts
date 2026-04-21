import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import "./bridge/bootstrap.js";
import { qqbotConfigAdapter, qqbotMeta, qqbotSetupAdapterShared } from "./bridge/config-shared.js";
import { qqbotSetupWizard } from "./bridge/setup/surface.js";
import { qqbotChannelConfigSchema } from "./config-schema.js";
import type { ResolvedQQBotAccount } from "./types.js";

/**
 * Setup-only QQBot plugin — lightweight subset used during `openclaw onboard`
 * and `openclaw configure` without pulling the full runtime dependencies.
 */
export const qqbotSetupPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
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
};
