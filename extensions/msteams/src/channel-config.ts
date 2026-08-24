import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
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
    const accounts = cfg.channels?.msteams?.accounts;
    const rawAccountKey = accounts
      ? Object.keys(accounts).find((key) => normalizeAccountId(key) === account.accountId)
      : undefined;
    const hasAccountPolicyOverride =
      rawAccountKey !== undefined && accounts?.[rawAccountKey]?.groupPolicy !== undefined;
    const configPath =
      account.accountId === DEFAULT_ACCOUNT_ID && !hasAccountPolicyOverride
        ? "channels.msteams"
        : `channels.msteams.accounts.${rawAccountKey ?? account.accountId}`;
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
    for (const key of Object.keys(nextAccounts)) {
      if (normalizeAccountId(key) === DEFAULT_ACCOUNT_ID) {
        delete nextAccounts[key];
      }
    }
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
        ...(defaultAccount && normalizeAccountId(defaultAccount) !== DEFAULT_ACCOUNT_ID
          ? { defaultAccount }
          : {}),
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
