import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  msteamsConfigAdapter,
  msteamsMeta,
  resolveMSTeamsDmPolicy,
  type ResolvedMSTeamsAccount,
} from "./channel-config.js";
import { collectMSTeamsSecurityFindings } from "./channel-security.js";
import { MSTeamsChannelConfigSchema } from "./config-schema.js";
import { msteamsSetupContract } from "./setup-core.js";
import { msteamsSetupWizard } from "./setup-surface.js";

export const msteamsSetupPlugin: ChannelPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...msteamsMeta,
    aliases: [...msteamsMeta.aliases],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    polls: true,
    threads: true,
    media: true,
    reactions: true,
  },
  reload: { configPrefixes: ["channels.msteams"], noopPrefixes: ["messages.inbound"] },
  configSchema: MSTeamsChannelConfigSchema,
  config: {
    ...msteamsConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
        extra: { tokenStatus: account.tokenStatus },
      }),
  },
  security: {
    resolveDmPolicy: resolveMSTeamsDmPolicy,
    collectWarnings: collectMSTeamsSecurityFindings,
  },
  setupWizard: msteamsSetupWizard,
  setupContract: msteamsSetupContract,
};
