// ClickClack plugin module exposes a setup-only channel surface.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { clickClackConfigAdapter, clickClackMeta } from "./channel-config.js";
import { clickClackConfigSchema } from "./config-schema.js";
import { clickClackSetupAdapter, clickClackSetupContract } from "./setup-core.js";
import { clickClackSetupWizard } from "./setup-surface.js";
import type { ResolvedClickClackAccount } from "./types.js";

export const clickClackSetupPlugin: ChannelPlugin<ResolvedClickClackAccount> = {
  id: "clickclack",
  meta: clickClackMeta,
  capabilities: {
    chatTypes: ["direct", "group"],
    threads: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.clickclack"] },
  configSchema: clickClackConfigSchema,
  config: clickClackConfigAdapter,
  setup: clickClackSetupAdapter,
  setupContract: clickClackSetupContract,
  setupWizard: clickClackSetupWizard,
};
