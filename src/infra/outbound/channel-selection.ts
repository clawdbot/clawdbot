import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import {
  listDeliverableMessageChannels,
  type DeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export type MessageChannelId = DeliverableMessageChannel;

const getMessageChannels = () => listDeliverableMessageChannels();

function isKnownChannel(value: string): boolean {
  return getMessageChannels().includes(value as MessageChannelId);
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") return true;
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

async function isPluginConfigured(plugin: ChannelPlugin, cfg: MoltbotConfig): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  if (accountIds.length === 0) return false;

  for (const accountId of accountIds) {
    const account = plugin.config.resolveAccount(cfg, accountId);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) continue;
    if (!plugin.config.isConfigured) return true;
    const configured = await plugin.config.isConfigured(account, cfg);
    if (configured) return true;
  }

  return false;
}

export async function listConfiguredMessageChannels(
  cfg: MoltbotConfig,
): Promise<MessageChannelId[]> {
  const channels: MessageChannelId[] = [];
  for (const plugin of listChannelPlugins()) {
    if (!isKnownChannel(plugin.id)) continue;
    if (await isPluginConfigured(plugin, cfg)) {
      channels.push(plugin.id as MessageChannelId);
    }
  }
  return channels;
}

export async function resolveMessageChannelSelection(params: {
  cfg: MoltbotConfig;
  channel?: string | null;
}): Promise<{ channel: MessageChannelId; configured: MessageChannelId[] }> {
  const normalized = normalizeMessageChannel(params.channel);
  if (normalized) {
    if (!isKnownChannel(normalized)) {
      throw new Error(`Unknown channel: ${String(normalized)}`);
    }
    return {
      channel: normalized as MessageChannelId,
      configured: await listConfiguredMessageChannels(params.cfg),
    };
  }

  const configured = await listConfiguredMessageChannels(params.cfg);
  if (configured.length === 1) {
    return { channel: configured[0], configured };
  }
  if (configured.length === 0) {
    throw new Error("Channel is required (no configured channels detected).");
  }
  throw new Error(
    `Channel is required when multiple channels are configured: ${configured.join(", ")}`,
  );
}
