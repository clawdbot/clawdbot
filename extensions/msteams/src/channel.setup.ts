// Msteams plugin module implements channel.setup behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  msteamsConfigAdapter,
  msteamsMeta,
  type ResolvedMSTeamsAccount,
} from "./channel-config.js";
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
  reload: { configPrefixes: ["channels.msteams"] },
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
  setupWizard: msteamsSetupWizard,
  setupContract: msteamsSetupContract,
};
