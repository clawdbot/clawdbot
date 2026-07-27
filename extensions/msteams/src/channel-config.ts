import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createHybridChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAllowlistProviderGroupPolicyWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "../runtime-api.js";
import { DEFAULT_ACCOUNT_ID } from "../runtime-api.js";
import {
  inspectMSTeamsAccount,
  listMSTeamsAccountIds,
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
  type ResolvedMSTeamsAccount,
} from "./accounts.js";

export type { ResolvedMSTeamsAccount } from "./accounts.js";

export const msteamsMeta = {
  id: "msteams",
  label: "Microsoft Teams",
  selectionLabel: "Microsoft Teams (Bot Framework)",
  docsPath: "/channels/msteams",
  docsLabel: "msteams",
  blurb: "Teams SDK; enterprise support.",
  aliases: ["teams"],
  order: 60,
} as const;

export const collectMSTeamsSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: OpenClawConfig;
  accountId?: string | null;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.msteams !== undefined,
  resolveGroupPolicy: ({ cfg, accountId }) =>
    resolveMSTeamsAccount({ cfg, accountId }).config.groupPolicy,
  collect: ({ cfg, accountId, groupPolicy }) => {
    if (groupPolicy !== "open") {
      return [];
    }
    const account = resolveMSTeamsAccount({ cfg, accountId });
    const configPath =
      account.accountId === DEFAULT_ACCOUNT_ID
        ? "channels.msteams"
        : `channels.msteams.accounts.${account.accountId}`;
    return [
      `- MS Teams[${account.accountId}] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set ${configPath}.groupPolicy="allowlist" + ${configPath}.groupAllowFrom to restrict senders.`,
    ];
  },
});

function deleteMSTeamsDefaultAccountIdentity(cfg: OpenClawConfig): OpenClawConfig {
  const msteams = cfg.channels?.msteams;
  if (!msteams) {
    return cfg;
  }
  const {
    appId: _appId,
    appPassword: _appPassword,
    accounts,
    defaultAccount,
    webhook,
    ...rest
  } = msteams;
  const nextAccounts = accounts ? { ...accounts } : undefined;
  if (nextAccounts) {
    delete nextAccounts[DEFAULT_ACCOUNT_ID];
  }
  const nextWebhook = webhook ? { ...webhook } : undefined;
  if (nextWebhook) {
    delete nextWebhook.port;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...rest,
        ...(defaultAccount && defaultAccount !== DEFAULT_ACCOUNT_ID ? { defaultAccount } : {}),
        ...(nextAccounts && Object.keys(nextAccounts).length > 0 ? { accounts: nextAccounts } : {}),
        ...(nextWebhook && Object.keys(nextWebhook).length > 0 ? { webhook: nextWebhook } : {}),
      },
    },
  };
}

const msteamsBaseConfigAdapter = createHybridChannelConfigAdapter<
  ResolvedMSTeamsAccount,
  ReturnType<typeof resolveMSTeamsAccountConfig>
>({
  sectionKey: "msteams",
  listAccountIds: listMSTeamsAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMSTeamsAccount),
  resolveAccessorAccount: ({ cfg, accountId }) => resolveMSTeamsAccountConfig(cfg, accountId),
  inspectAccount: adaptScopedAccountAccessor(inspectMSTeamsAccount),
  defaultAccountId: resolveDefaultMSTeamsAccountId,
  clearBaseFields: ["appId", "appPassword"],
  preserveSectionOnDefaultDelete: true,
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

export const msteamsConfigAdapter = {
  ...msteamsBaseConfigAdapter,
  deleteAccount: (params: { cfg: OpenClawConfig; accountId: string }) =>
    params.accountId === DEFAULT_ACCOUNT_ID
      ? deleteMSTeamsDefaultAccountIdentity(params.cfg)
      : msteamsBaseConfigAdapter.deleteAccount!(params),
};
