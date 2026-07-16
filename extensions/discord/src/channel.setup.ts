import { type ResolvedDiscordAccount } from "./accounts.js";
import { type ChannelPlugin } from "./channel-api.js";
import { discordSetupWizard } from "./channel.runtime.js";
import { discordSetupAdapter } from "./setup-adapter.js";
import { createDiscordPluginBase } from "./shared.js";

export const discordSetupPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  ...createDiscordPluginBase({
    setupWizard: discordSetupWizard,
    setup: discordSetupAdapter,
  }),
};
