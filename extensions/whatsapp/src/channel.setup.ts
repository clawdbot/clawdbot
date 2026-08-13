// Whatsapp plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedWhatsAppAccount } from "./accounts.js";
import { readWhatsAppAccountLinkState } from "./channel-runtime-loader.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { whatsappSetupContract } from "./setup-core.js";
import { createWhatsAppPluginBase, whatsappSetupWizardProxy } from "./shared.js";

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase({
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
    },
    setupWizard: whatsappSetupWizardProxy,
    setupContract: whatsappSetupContract,
    isConfigured: (account) => Boolean(account.authDir),
    isLinked: async (account) => await readWhatsAppAccountLinkState(account.authDir),
  }),
};
