// Whatsapp helper module supports account config behavior.
import {
  DEFAULT_ACCOUNT_ID,
  resolveAccountEntry,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type { WhatsAppAccountConfig } from "./account-types.js";

function resolveWhatsAppDefaultAccountSharedConfig(
  cfg: OpenClawConfig,
): Partial<WhatsAppAccountConfig> | undefined {
  const defaultAccount = resolveAccountEntry(cfg.channels?.whatsapp?.accounts, DEFAULT_ACCOUNT_ID);
  if (!defaultAccount) {
    return undefined;
  }
  const {
    enabled: _ignoredEnabled,
    name: _ignoredName,
    authDir: _ignoredAuthDir,
    selfChatMode: _ignoredSelfChatMode,
    ...sharedDefaults
  } = defaultAccount;
  return sharedDefaults;
}

export function resolveMergedWhatsAppAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): WhatsAppAccountConfig & { accountId: string } {
  const rootCfg = params.cfg.channels?.whatsapp;
  const accountId = params.accountId?.trim() || rootCfg?.defaultAccount || DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<WhatsAppAccountConfig>({
    channelConfig: {
      ...rootCfg,
      ...(accountId === DEFAULT_ACCOUNT_ID
        ? undefined
        : resolveWhatsAppDefaultAccountSharedConfig(params.cfg)),
    },
    accounts: rootCfg?.accounts as Record<string, Partial<WhatsAppAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
  return { accountId, ...merged };
}
