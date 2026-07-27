import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelAccountEnabled } from "../../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { isConfiguredChannel } from "./channel-selection.js";

export type MessageBroadcastAccountPlan = {
  accountId: string;
  candidateChannels: ChannelId[];
  secretChannels: ChannelId[];
};

function resolveListedAccountId(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): string | undefined {
  const listedAccountId = params.plugin.config
    .listAccountIds(params.cfg)
    .find((candidate) => normalizeOptionalAccountId(candidate) === params.accountId);
  if (listedAccountId) {
    return listedAccountId;
  }
  const defaultAccountId = resolveChannelDefaultAccountId({
    plugin: params.plugin,
    cfg: params.cfg,
  });
  return normalizeOptionalAccountId(defaultAccountId) === params.accountId
    ? defaultAccountId
    : undefined;
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

function isPotentialBroadcastChannel(params: {
  cfg: OpenClawConfig;
  plugin: ChannelPlugin;
}): params is { cfg: OpenClawConfig; plugin: ChannelPlugin & { id: ChannelId } } {
  if (!isDeliverableMessageChannel(params.plugin.id)) {
    return false;
  }
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.plugin.id
  ];
  if (
    channelConfig &&
    typeof channelConfig === "object" &&
    !Array.isArray(channelConfig) &&
    (channelConfig as { enabled?: unknown }).enabled === false
  ) {
    return false;
  }
  if (isConfiguredChannel(params.cfg, params.plugin.id)) {
    return true;
  }
  try {
    return (
      params.plugin.config.hasConfiguredState?.({ cfg: params.cfg, env: process.env }) === true
    );
  } catch {
    return false;
  }
}

/**
 * Plans an unscoped broadcast before SecretRefs are resolved. Rejected routes
 * stay in candidateChannels for per-channel errors but cannot expose secrets.
 * Host-derived binding/default accounts do not use this explicit-account plan.
 */
export function resolveMessageBroadcastAccountPlan(params: {
  cfg: OpenClawConfig;
  accountId: unknown;
}): MessageBroadcastAccountPlan | undefined {
  const accountId = validateExplicitMessageAccountSelection({
    cfg: params.cfg,
    accountId: params.accountId,
    checkResolvedAccount: false,
  });
  if (!accountId) {
    return undefined;
  }

  const candidatePlugins = listChannelPlugins().filter((plugin) =>
    isPotentialBroadcastChannel({ cfg: params.cfg, plugin }),
  );
  const secretChannels = candidatePlugins.flatMap((plugin) => {
    try {
      validateExplicitMessageAccountSelection({
        cfg: params.cfg,
        channel: plugin.id,
        accountId,
        plugin,
        checkResolvedAccount: false,
      });
      // Prefer the SecretRef-safe metadata view. Legacy plugins without it keep
      // their existing resolver contract; a resolver that cannot read refs fails closed.
      const accountForEnablement =
        plugin.config.inspectAccount?.(params.cfg, accountId) ??
        plugin.config.resolveAccount(params.cfg, accountId);
      if (
        accountForEnablement === undefined ||
        !resolveChannelAccountEnabled({
          plugin,
          account: accountForEnablement,
          cfg: params.cfg,
        })
      ) {
        throw new Error(`Account "${accountId}" for channel ${plugin.id} is disabled.`);
      }
      return [plugin.id];
    } catch {
      return [];
    }
  });

  return {
    accountId,
    candidateChannels: candidatePlugins.map((plugin) => plugin.id),
    secretChannels,
  };
}
