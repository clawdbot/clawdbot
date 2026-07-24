import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelAccountEnabled } from "../../channels/account-summary.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";

function resolveListedAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): string | undefined {
  return params.plugin.config
    .listAccountIds(params.cfg)
    .find((candidate) => normalizeOptionalAccountId(candidate) === params.accountId);
}

function isExplicitAccountDisabled(params: {
  cfg: OpenClawConfig;
  channel: string;
  listedAccountId: string;
}): boolean {
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.channel
  ];
  if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
    return false;
  }
  const channelRecord = channelConfig as {
    enabled?: unknown;
    accounts?: Record<string, { enabled?: unknown }>;
  };
  if (channelRecord.enabled === false) {
    return true;
  }
  return resolveAccountEntry(channelRecord.accounts, params.listedAccountId)?.enabled === false;
}

/**
 * Binds a caller-supplied message account to one listed channel account.
 * Host-derived defaults and binding accounts bypass this helper by design.
 */
export function validateExplicitMessageAccountSelection(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: unknown;
  plugin?: ChannelPlugin;
  checkResolvedAccount?: boolean;
}): string | undefined {
  const rawAccountId = normalizeOptionalString(params.accountId);
  if (!rawAccountId) {
    return undefined;
  }
  const accountId = normalizeOptionalAccountId(rawAccountId);
  if (!accountId) {
    throw new Error(`Invalid account ID "${rawAccountId}".`);
  }
  const channel = normalizeOptionalString(params.channel);
  if (!channel) {
    return accountId;
  }
  const plugin =
    params.plugin ??
    resolveOutboundChannelPlugin({
      channel,
      cfg: params.cfg,
    }) ??
    getChannelPlugin(channel);
  if (!plugin) {
    return accountId;
  }
  const listedAccountId = resolveListedAccountId({ plugin, cfg: params.cfg, accountId });
  if (!listedAccountId) {
    throw new Error(`Unknown account "${rawAccountId}" for channel ${channel}.`);
  }
  if (isExplicitAccountDisabled({ cfg: params.cfg, channel: plugin.id, listedAccountId })) {
    throw new Error(`Account "${listedAccountId}" for channel ${channel} is disabled.`);
  }
  if (params.checkResolvedAccount !== false) {
    const account = plugin.config.resolveAccount(params.cfg, accountId);
    if (!resolveChannelAccountEnabled({ plugin, account, cfg: params.cfg })) {
      throw new Error(`Account "${listedAccountId}" for channel ${channel} is disabled.`);
    }
  }
  return accountId;
}
