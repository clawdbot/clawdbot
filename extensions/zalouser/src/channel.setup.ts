// Zalouser plugin module implements channel.setup behavior.
import type { ResolvedZalouserAccount } from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { zalouserSetupAdapter, zalouserSetupContract } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { createZalouserPluginBase } from "./shared.js";

export const zalouserSetupPlugin: ChannelPlugin<ResolvedZalouserAccount> = {
  ...createZalouserPluginBase({
    setupWizard: zalouserSetupWizard,
    setup: zalouserSetupAdapter,
    setupContract: zalouserSetupContract,
  }),
};
