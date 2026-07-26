import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { BuzzConfigSchema } from "./config-schema.js";
import { buzzSetupAdapter, buzzSetupContract } from "./setup-core.js";
import { buzzSetupWizard } from "./setup-surface.js";
import {
  listBuzzAccountIds,
  resolveBuzzAccount,
  resolveDefaultBuzzAccountId,
  type ResolvedBuzzAccount,
} from "./types.js";

export const buzzSetupPlugin: ChannelPlugin<ResolvedBuzzAccount> = {
  id: "buzz",
  meta: {
    id: "buzz",
    label: "Buzz",
    selectionLabel: "Buzz",
    docsPath: "/channels/buzz",
    docsLabel: "buzz",
    blurb: "Connect OpenClaw agents to Buzz team rooms.",
    order: 56,
  },
  capabilities: { chatTypes: ["group"], threads: true },
  reload: { configPrefixes: ["channels.buzz"] },
  configSchema: BuzzConfigSchema,
  setup: buzzSetupAdapter,
  setupContract: buzzSetupContract,
  setupWizard: buzzSetupWizard,
  config: {
    listAccountIds: listBuzzAccountIds,
    resolveAccount: (cfg, accountId) => resolveBuzzAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultBuzzAccountId,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
        extra: { baseUrl: account.relayUrl, publicKey: account.publicKey },
      }),
  },
};
