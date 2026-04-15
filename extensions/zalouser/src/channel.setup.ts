import type { ResolvedZalouserAccount } from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { createZalouserPluginBase } from "./shared.js";

export const zalouserSetupPlugin: ChannelPlugin<ResolvedZalouserAccount> = {
  ...createZalouserPluginBase({
    setupWizard: zalouserSetupWizard,
    setup: zalouserSetupAdapter,
  }),
};
