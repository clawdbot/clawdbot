// Signal plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedSignalAccount } from "./accounts.js";
import { signalSetupContract } from "./setup-core.js";
import { createSignalPluginBase, signalSetupWizard } from "./shared.js";

export const signalSetupPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  ...createSignalPluginBase({
    setupWizard: signalSetupWizard,
    setupContract: signalSetupContract,
  }),
};
