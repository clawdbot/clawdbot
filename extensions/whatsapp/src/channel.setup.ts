import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { type ResolvedWhatsAppAccount } from "./accounts.js";
import { readWebAuthState } from "./auth-store.js";
import { resolveWhatsAppGroupIntroHint } from "./group-intro.js";
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
      resolveGroupIntroHint: resolveWhatsAppGroupIntroHint,
    },
    setupWizard: whatsappSetupWizardProxy,
    setup: whatsappSetupAdapter,
    isConfigured: async (account) => (await readWebAuthState(account.authDir)) === "linked",
  }),
  lifecycle: {
    detectLegacyStateMigrations: ({ oauthDir }) =>
      detectWhatsAppLegacyStateMigrations({ oauthDir }),
  },
};
