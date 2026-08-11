import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
// Qqbot helper module supports config shared behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applyAccountNameToChannelSection } from "openclaw/plugin-sdk/core";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/setup";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  describeAccount as engineDescribeAccount,
  formatAllowFrom as engineFormatAllowFrom,
  isAccountConfigured as engineIsAccountConfigured,
} from "../engine/config/resolve.js";
import {
  applySetupAccountConfig as engineApplySetupAccountConfig,
  validateSetupInput as engineValidateSetupInput,
} from "../engine/config/setup-logic.js";
import type { ResolvedQQBotAccount } from "../types.js";
import {
  listQQBotAccountIds,
  resolveDefaultQQBotAccountId,
  resolveQQBotAccount,
} from "./config.js";

export const qqbotMeta = {
  id: "qqbot",
  label: "QQ Bot",
  selectionLabel: "QQ Bot (Bot API)",
  docsPath: "/channels/qqbot",
  blurb: "Connect to QQ via official QQ Bot API",
  order: 50,
  preferSessionLookupForAnnounceTarget: true,
} as const;

function validateQQBotSetupInput(params: {
  accountId: string;
  input: ChannelSetupInput;
}): string | null {
  return engineValidateSetupInput(params.accountId, params.input);
}

function applyQQBotSetupAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}): OpenClawConfig {
  return engineApplySetupAccountConfig(
    params.cfg as unknown as Record<string, unknown>,
    params.accountId,
    params.input,
  ) as OpenClawConfig;
}

function isQQBotConfigured(account: ResolvedQQBotAccount | undefined): boolean {
  return engineIsAccountConfigured(account as never);
}

function describeQQBotAccount(account: ResolvedQQBotAccount | undefined) {
  return engineDescribeAccount(account as never);
}

export const qqbotConfigAdapter = {
  ...createScopedChannelConfigAdapter<ResolvedQQBotAccount>({
    sectionKey: "qqbot",
    listAccountIds: listQQBotAccountIds,
    resolveAccount: (cfg, accountId) =>
      resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true }),
    defaultAccountId: resolveDefaultQQBotAccountId,
    clearBaseFields: ["appId", "clientSecret", "clientSecretFile", "name"],
    resolveAllowFrom: (account) => account.config.allowFrom,
    formatAllowFrom: engineFormatAllowFrom,
  }),
  isConfigured: isQQBotConfigured,
  describeAccount: describeQQBotAccount,
};

const qqbotSetupAdapterShared = {
  resolveAccountId: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
    normalizeLowercaseStringOrEmpty(accountId) || resolveDefaultQQBotAccountId(cfg),
  applyAccountName: ({
    cfg,
    accountId,
    name,
  }: {
    cfg: OpenClawConfig;
    accountId: string;
    name?: string;
  }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: "qqbot",
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }: { accountId: string; input: ChannelSetupInput }) =>
    validateQQBotSetupInput({ accountId, input }),
  applyAccountConfig: ({
    cfg,
    accountId,
    input,
  }: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => applyQQBotSetupAccountConfig({ cfg, accountId, input }),
};

export const qqbotSetupContract = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <appId:secret>", description: "QQBot app id and client secret" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "QQBot client secret file" },
    },
    useEnv: {
      kind: "boolean",
      cli: { flags: "--use-env", description: "Use QQBOT environment credentials" },
    },
  },
  legacyAdapter: qqbotSetupAdapterShared,
});
