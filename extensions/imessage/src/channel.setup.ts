// Imessage plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { imessageSetupContract } from "./setup-core.js";
import { createIMessagePluginBase, imessageSetupWizard } from "./shared.js";

export const imessageSetupPlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  ...createIMessagePluginBase({
    setupWizard: imessageSetupWizard,
    setupContract: imessageSetupContract,
  }),
};
