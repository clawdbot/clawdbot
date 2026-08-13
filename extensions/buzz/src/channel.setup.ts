import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buzzConfigAdapter } from "./channel-config.js";
import { BuzzConfigSchema } from "./config-schema.js";
import { buzzSetupContract } from "./setup-core.js";
import { buzzSetupWizard } from "./setup-surface.js";
import type { ResolvedBuzzAccount } from "./types.js";

export const buzzSetupPlugin: ChannelPlugin<ResolvedBuzzAccount> = {
  id: "buzz",
  meta: {
    id: "buzz",
    label: "Buzz",
    selectionLabel: "Buzz",
    docsPath: "/channels/buzz",
    docsLabel: "buzz",
    blurb: "Connect OpenClaw agents to Buzz team rooms.",
    markdownCapable: true,
    order: 56,
  },
  capabilities: { chatTypes: ["group"], threads: true },
  reload: { configPrefixes: ["channels.buzz"] },
  configSchema: BuzzConfigSchema,
  setupContract: buzzSetupContract,
  setupWizard: buzzSetupWizard,
  config: buzzConfigAdapter,
};
