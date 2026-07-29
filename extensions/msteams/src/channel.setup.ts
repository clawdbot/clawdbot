// Msteams plugin module implements channel.setup behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  msteamsConfigAdapter,
  msteamsMeta,
  type ResolvedMSTeamsAccount,
} from "./channel-config.js";
import { MSTeamsChannelConfigSchema } from "./config-schema.js";
import { msteamsSetupAdapter, msteamsSetupContract } from "./setup-core.js";
import { msteamsSetupWizard } from "./setup-surface.js";
import { resolveMSTeamsCredentials } from "./token.js";

export const msteamsSetupPlugin: ChannelPlugin<ResolvedMSTeamsAccount> = {
  id: "msteams",
  meta: {
    ...msteamsMeta,
    aliases: [...msteamsMeta.aliases],
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.msteams"] },
  configSchema: MSTeamsChannelConfigSchema,
  config: {
    ...msteamsConfigAdapter,
    isConfigured: (_account, cfg) => Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)),
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
      }),
  },
  setupWizard: msteamsSetupWizard,
  setup: msteamsSetupAdapter,
  setupContract: msteamsSetupContract,
};
