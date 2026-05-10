import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type OfficialExternalPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHint,
} from "../../plugins/official-external-plugin-repair-hints.js";
import { defaultRuntime } from "../../runtime.js";
import {
  listDeliverableMessageChannels,
  type DeliverableMessageChannel,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";

export type MessageChannelId = DeliverableMessageChannel;
export type MessageChannelSelectionSource =
  | "explicit"
  | "tool-context-fallback"
  | "single-configured";

const getMessageChannels = () => listDeliverableMessageChannels();

function isKnownChannel(value: string): boolean {
  return getMessageChannels().includes(value as MessageChannelId);
}

function resolveKnownChannel(value?: string | null): MessageChannelId | undefined {
  const normalized = normalizeMessageChannel(value);
  if (!normalized) {
    return undefined;
  }
  if (!isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  if (!isKnownChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function resolveAvailableKnownChannel(params: {
  cfg: OpenClawConfig;
  value?: string | null;
}): MessageChannelId | undefined {
  const normalized = resolveKnownChannel(params.value);
  if (!normalized) {
    return undefined;
  }
  return resolveOutboundChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
  })
    ? normalized
    : undefined;
}

function isConfiguredChannel(cfg: OpenClawConfig, channelId: string): boolean {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  const entry = (channels as Record<string, unknown>)[channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as { enabled?: unknown }).enabled !== false;
}

function listConfiguredOfficialExternalRepairHints(
  cfg: OpenClawConfig,
): OfficialExternalPluginRepairHint[] {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => isConfiguredChannel(cfg, channelId))
    .map((channelId) =>
      resolveMissingOfficialExternalChannelPluginRepairHint({
        config: cfg,
        channelId,
      }),
    )
    .filter((hint): hint is OfficialExternalPluginRepairHint => Boolean(hint));
}

function formatMissingOfficialExternalChannelsMessage(
  hints: readonly OfficialExternalPluginRepairHint[],
): string {
  if (hints.length === 1) {
    const hint = hints[0];
    if (!hint) {
      return "";
    }
    return `Configured official external channel ${hint.label} is missing its plugin. ${hint.repairHint}`;
  }
  const labels = hints.map((hint) => hint.label).join(", ");
  const installCommands = hints.map((hint) => hint.installCommand).join("; ");
  return `Configured official external channels ${labels} are missing their plugins. Run: openclaw doctor --fix, or install individually: ${installCommands}.`;
}

function formatNoConfiguredChannelsMessage(): string {
  return [
    "Channel is required (no configured channels detected).",
    "Run openclaw channels add to configure one, or pass --channel <channel> after enabling a channel.",
    "Use openclaw channels list --all to see available channel ids.",
  ].join(" ");
}

function formatMultipleConfiguredChannelsMessage(configured: readonly string[]): string {
  return [
    `Channel is required when multiple channels are configured: ${configured.join(", ")}.`,
    "Pass --channel <channel> to choose one.",
  ].join(" ");
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

const loggedChannelSelectionErrors = new Set<string>();

function logChannelSelectionError(params: {
  pluginId: string;
  accountId: string;
  operation: "resolveAccount" | "isConfigured";
  error: unknown;
}) {
  const message = formatErrorMessage(params.error);
  const key = `${params.pluginId}:${params.accountId}:${params.operation}:${message}`;
  if (loggedChannelSelectionErrors.has(key)) {
    return;
  }
  loggedChannelSelectionErrors.add(key);
  defaultRuntime.error?.(
    `[channel-selection] ${params.pluginId}(${params.accountId}) ${params.operation} failed: ${message}`,
  );
}

async function isPluginConfigured(plugin: ChannelPlugin, cfg: OpenClawConfig): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  if (accountIds.length === 0) {
    return false;
  }

  for (const accountId of accountIds) {
    let account: unknown;
    try {
      account = plugin.config.resolveAccount(cfg, accountId);
    } catch (error) {
      logChannelSelectionError({
        pluginId: plugin.id,
        accountId,
        operation: "resolveAccount",
        error,
      });
      continue;
    }
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) {
      continue;
    }
    if (!plugin.config.isConfigured) {
      return true;
    }
    let configured = false;
    try {
      configured = await plugin.config.isConfigured(account, cfg);
    } catch (error) {
      logChannelSelectionError({
        pluginId: plugin.id,
        accountId,
        operation: "isConfigured",
        error,
      });
      continue;
    }
    if (configured) {
      return true;
    }
  }

  return false;
}

export async function listConfiguredMessageChannels(
  cfg: OpenClawConfig,
): Promise<MessageChannelId[]> {
  const channels: MessageChannelId[] = [];
  for (const plugin of listChannelPlugins()) {
    if (!isKnownChannel(plugin.id)) {
      continue;
    }
    if (await isPluginConfigured(plugin, cfg)) {
      channels.push(plugin.id);
    }
  }
  return channels;
}

export async function resolveMessageChannelSelection(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  fallbackChannel?: string | null;
}): Promise<{
  channel: MessageChannelId;
  configured: MessageChannelId[];
  source: MessageChannelSelectionSource;
}> {
  const normalized = normalizeMessageChannel(params.channel);
  if (normalized) {
    const availableExplicit = resolveAvailableKnownChannel({
      cfg: params.cfg,
      value: normalized,
    });
    if (!availableExplicit) {
      const fallback = resolveAvailableKnownChannel({
        cfg: params.cfg,
        value: params.fallbackChannel,
      });
      if (fallback) {
        return {
          channel: fallback,
          configured: [],
          source: "tool-context-fallback",
        };
      }
      if (!isKnownChannel(normalized)) {
        throw new Error(`Unknown channel: ${normalized}`);
      }
      const repairHint = isConfiguredChannel(params.cfg, normalized)
        ? resolveMissingOfficialExternalChannelPluginRepairHint({
            config: params.cfg,
            channelId: normalized,
          })
        : null;
      if (repairHint?.channelId === normalized) {
        throw new Error(`Channel is unavailable: ${normalized}. ${repairHint.repairHint}`);
      }
      throw new Error(`Channel is unavailable: ${normalized}`);
    }
    return {
      channel: availableExplicit,
      configured: [],
      source: "explicit",
    };
  }

  const fallback = resolveAvailableKnownChannel({
    cfg: params.cfg,
    value: params.fallbackChannel,
  });
  if (fallback) {
    return {
      channel: fallback,
      configured: [],
      source: "tool-context-fallback",
    };
  }

  const configured = await listConfiguredMessageChannels(params.cfg);
  if (configured.length === 1) {
    return { channel: configured[0], configured, source: "single-configured" };
  }
  if (configured.length === 0) {
    const repairHints = listConfiguredOfficialExternalRepairHints(params.cfg);
    if (repairHints.length > 0) {
      throw new Error(
        `Channel is required (no available channels detected). ${formatMissingOfficialExternalChannelsMessage(repairHints)}`,
      );
    }
    throw new Error(formatNoConfiguredChannelsMessage());
  }
  throw new Error(formatMultipleConfiguredChannelsMessage(configured));
}

export const __testing = {
  resetLoggedChannelSelectionErrors() {
    loggedChannelSelectionErrors.clear();
  },
};
