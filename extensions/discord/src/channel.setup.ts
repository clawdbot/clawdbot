// Discord plugin module implements channel.setup behavior.
import type { ResolvedDiscordAccount } from "./accounts.js";
import type { ChannelPlugin } from "./channel-api.js";
import { discordSetupWizard } from "./channel.runtime.js";
import { discordSetupAdapter, discordSetupContract } from "./setup-adapter.js";
import { createDiscordPluginBase } from "./shared.js";

export const discordSetupPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  ...createDiscordPluginBase({
    setupWizard: discordSetupWizard,
    setup: discordSetupAdapter,
    setupContract: discordSetupContract,
  }),
};
