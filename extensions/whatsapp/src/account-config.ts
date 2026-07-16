import {
  DEFAULT_ACCOUNT_ID,
  resolveAccountEntry,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import {
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
} from "openclaw/plugin-sdk/channel-streaming";
import type { WhatsAppAccountConfig } from "./account-types.js";

function _resolveWhatsAppAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): WhatsAppAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.whatsapp?.accounts, accountId);
}

export function resolveMergedWhatsAppAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): WhatsAppAccountConfig & { accountId: string } {
  const rootCfg = params.cfg.channels?.whatsapp;
  const accountId = params.accountId?.trim() || rootCfg?.defaultAccount || DEFAULT_ACCOUNT_ID;
  const merged = resolveMergedAccountConfig<WhatsAppAccountConfig>({
    channelConfig: rootCfg as WhatsAppAccountConfig | undefined,
    accounts: rootCfg?.accounts as Record<string, Partial<WhatsAppAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
  });
  return {
    accountId,
    ...merged,
    chunkMode: resolveChannelStreamingChunkMode(merged) ?? merged.chunkMode,
    blockStreaming: resolveChannelStreamingBlockEnabled(merged) ?? merged.blockStreaming,
  };
}
