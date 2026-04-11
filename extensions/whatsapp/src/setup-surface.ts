import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { DEFAULT_ACCOUNT_ID, setSetupChannelEnabled } from "openclaw/plugin-sdk/setup";
import { listWhatsAppAccountIds } from "./accounts.js";
import { detectWhatsAppLinked, finalizeWhatsAppSetup } from "./setup-finalize.js";

const channel = "whatsapp" as const;

export const whatsappSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "linked",
    unconfiguredLabel: "not linked",
    configuredHint: "linked",
    unconfiguredHint: "not linked",
    configuredScore: 5,
    unconfiguredScore: 4,
    resolveConfigured: async ({ cfg, accountId }) => {
      for (const resolvedAccountId of accountId ? [accountId] : listWhatsAppAccountIds(cfg)) {
        if (await detectWhatsAppLinked(cfg, resolvedAccountId)) {
          return true;
        }
      }
      return false;
    },
    resolveStatusLines: async ({ cfg, accountId, configured }) => {
      const linkedAccountId = (
        await Promise.all(
          (accountId ? [accountId] : listWhatsAppAccountIds(cfg)).map(
            async (resolvedAccountId) => ({
              accountId: resolvedAccountId,
              linked: await detectWhatsAppLinked(cfg, resolvedAccountId),
            }),
          ),
        )
      ).find((entry) => entry.linked)?.accountId;
      const labelAccountId = accountId ?? linkedAccountId;
      const label = labelAccountId
        ? `WhatsApp (${labelAccountId === DEFAULT_ACCOUNT_ID ? "default" : labelAccountId})`
        : "WhatsApp";
      return [`${label}: ${configured ? "linked" : "not linked"}`];
    },
  },
  resolveShouldPromptAccountIds: ({ shouldPromptAccountIds }) => shouldPromptAccountIds,
  credentials: [],
  finalize: async ({ cfg, accountId, forceAllowFrom, prompter, runtime }) =>
    await finalizeWhatsAppSetup({ cfg, accountId, forceAllowFrom, prompter, runtime }),
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  onAccountRecorded: (accountId, options) => {
    options?.onAccountId?.(channel, accountId);
  },
};
