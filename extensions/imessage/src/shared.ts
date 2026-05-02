import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  formatTrimmedAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createChannelPluginBase } from "openclaw/plugin-sdk/core";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  type ResolvedIMessageAccount,
} from "./accounts.js";
import { getChatChannelMeta, type ChannelPlugin } from "./channel-api.js";
import { IMessageChannelConfigSchema } from "./config-schema.js";
import {
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "./media-contract.js";
import { createIMessageSetupWizardProxy } from "./setup-core.js";

const IMESSAGE_CHANNEL = "imessage" as const;

async function loadIMessageChannelRuntime() {
  return await import("./channel.runtime.js");
}

export const imessageSetupWizard = createIMessageSetupWizardProxy(
  async () => (await loadIMessageChannelRuntime()).imessageSetupWizard,
);

const imessageConfigAdapter = createScopedChannelConfigAdapter<ResolvedIMessageAccount>({
  sectionKey: IMESSAGE_CHANNEL,
  listAccountIds: listIMessageAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveIMessageAccount),
  defaultAccountId: resolveDefaultIMessageAccountId,
  clearBaseFields: ["cliPath", "dbPath", "service", "region", "name"],
  resolveAllowFrom: (account: ResolvedIMessageAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) => formatTrimmedAllowFromEntries(allowFrom),
  resolveDefaultTo: (account: ResolvedIMessageAccount) => account.config.defaultTo,
});

export const imessageSecurityAdapter =
  createRestrictSendersChannelSecurity<ResolvedIMessageAccount>({
    channelKey: IMESSAGE_CHANNEL,
    resolveDmPolicy: (account) => account.config.dmPolicy,
    resolveDmAllowFrom: (account) => account.config.allowFrom,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    surface: "iMessage groups",
    openScope: "any member",
    groupPolicyPath: "channels.imessage.groupPolicy",
    groupAllowFromPath: "channels.imessage.groupAllowFrom",
    mentionGated: false,
    policyPathSuffix: "dmPolicy",
  });

export function createIMessagePluginBase(params: {
  setupWizard?: NonNullable<ChannelPlugin<ResolvedIMessageAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedIMessageAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedIMessageAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "reload"
  | "configSchema"
  | "config"
  | "security"
  | "setup"
  | "messaging"
> {
  const base = createChannelPluginBase({
    id: IMESSAGE_CHANNEL,
    meta: {
      ...getChatChannelMeta(IMESSAGE_CHANNEL),
      aliases: ["imsg"],
      showConfigured: false,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
    },
    reload: { configPrefixes: ["channels.imessage"] },
    configSchema: IMessageChannelConfigSchema,
    config: {
      ...imessageConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
        }),
    },
    security: imessageSecurityAdapter,
    setup: params.setup,
  });
  return {
    ...base,
    messaging: {
      resolveInboundAttachmentRoots: (params) =>
        resolveIMessageAttachmentRoots({ accountId: params.accountId, cfg: params.cfg }),
      resolveRemoteInboundAttachmentRoots: (params) =>
        resolveIMessageRemoteAttachmentRoots({ accountId: params.accountId, cfg: params.cfg }),
    },
  } as Pick<
    ChannelPlugin<ResolvedIMessageAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "reload"
    | "configSchema"
    | "config"
    | "security"
    | "setup"
    | "messaging"
  >;
}
