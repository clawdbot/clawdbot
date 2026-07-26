// Imessage plugin module implements channel.setup behavior.
import type { ResolvedIMessageAccount } from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { imessageSetupAdapter, imessageSetupContract } from "./setup-core.js";
import { createIMessagePluginBase, imessageSetupWizard } from "./shared.js";

export const imessageSetupPlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  ...createIMessagePluginBase({
    setupWizard: imessageSetupWizard,
    setup: imessageSetupAdapter,
    setupContract: imessageSetupContract,
  }),
};
