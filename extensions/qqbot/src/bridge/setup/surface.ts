import {
  createStandardChannelSetupStatus,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { isAccountConfigured } from "../../engine/config/resolve.js";
import { listQQBotAccountIds, resolveQQBotAccount } from "../config.js";
import { finalizeQQBotSetup } from "./finalize.js";

const channel = "qqbot" as const;

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "QQ Bot",
    configuredLabel: "configured",
    unconfiguredLabel: "needs AppID + AppSercet",
    configuredHint: "configured",
    unconfiguredHint: "needs AppID + AppSercet",
    configuredScore: 1,
    unconfiguredScore: 6,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listQQBotAccountIds(cfg)).some((resolvedAccountId) => {
        const account = resolveQQBotAccount(cfg, resolvedAccountId, {
          allowUnresolvedSecretRef: true,
        });
        return isAccountConfigured(account as never);
      }),
  }),
  credentials: [],
  finalize: async ({ cfg, accountId, forceAllowFrom, prompter, runtime }) =>
    await finalizeQQBotSetup({ cfg, accountId, forceAllowFrom, prompter, runtime }),
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
