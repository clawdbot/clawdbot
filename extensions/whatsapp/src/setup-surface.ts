import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  setSetupChannelEnabled,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { listWhatsAppAccountIds, resolveWhatsAppAuthDir } from "./accounts.js";
import { formatWhatsAppWebAuthStatusState, readWebAuthState } from "./auth-store.js";

const channel = "whatsapp" as const;

type WhatsAppSetupLinkState = "linked" | "not-linked" | "unstable";

async function readWhatsAppSetupLinkState(
  cfg: OpenClawConfig,
  accountId: string,
): Promise<WhatsAppSetupLinkState> {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  return await readWebAuthState(authDir);
}

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
        if ((await readWhatsAppSetupLinkState(cfg, resolvedAccountId)) === "linked") {
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
              state: await readWhatsAppSetupLinkState(cfg, resolvedAccountId),
            }),
          ),
        )
      ).find((entry) => entry.state === "linked" || entry.state === "unstable");
      const labelAccountId = accountId ?? linkedAccountId?.accountId;
      const label = labelAccountId
        ? `WhatsApp (${labelAccountId === DEFAULT_ACCOUNT_ID ? "default" : labelAccountId})`
        : "WhatsApp";
      const stateLabel = configured
        ? formatWhatsAppWebAuthStatusState("linked")
        : formatWhatsAppWebAuthStatusState(linkedAccountId?.state ?? "not-linked");
      return [`${label}: ${stateLabel}`];
    },
  },
  resolveShouldPromptAccountIds: ({ shouldPromptAccountIds }) => shouldPromptAccountIds,
  credentials: [],
  finalize: async (params) =>
    await (await import("./setup-finalize.js")).finalizeWhatsAppSetup(params),
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  onAccountRecorded: (accountId, options) => {
    options?.onAccountId?.(channel, accountId);
  },
};
