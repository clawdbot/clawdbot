// Zalouser plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedZalouserAccount } from "./accounts.js";
import { zalouserSetupContract } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { createZalouserPluginBase } from "./shared.js";

export const zalouserSetupPlugin: ChannelPlugin<ResolvedZalouserAccount> = {
  ...createZalouserPluginBase({
    setupWizard: zalouserSetupWizard,
    setupContract: zalouserSetupContract,
  }),
};
