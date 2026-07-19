// Whatsapp plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedWhatsAppAccount } from "./accounts.js";
import { isWhatsAppAuthConfigured } from "./channel-runtime-loader.js";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import { whatsappSetupAdapter } from "./setup-core.js";
import { createWhatsAppPluginBase, whatsappSetupWizardProxy } from "./shared.js";
import { detectWhatsAppLegacyStateMigrations } from "./state-migrations.js";

export const whatsappSetupPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  ...createWhatsAppPluginBase({
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
    },
    setupWizard: whatsappSetupWizardProxy,
    setup: whatsappSetupAdapter,
    isConfigured: async (account) => await isWhatsAppAuthConfigured(account.authDir),
  }),
  lifecycle: {
    detectLegacyStateMigrations: ({ oauthDir }) =>
      detectWhatsAppLegacyStateMigrations({ oauthDir }),
  },
};
