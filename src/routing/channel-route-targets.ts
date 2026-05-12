import { normalizeChatChannelId } from "../channels/ids.js";
import { listRouteBindings } from "../config/bindings.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveAgentRoute } from "./resolve-route.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeAgentId } from "./session-key.js";

export type ChannelRouteTarget = {
  agentId: string;
  channels: string[];
};

const CHANNELS_CONFIG_META_KEYS = new Set(["defaults", "modelByChannel"]);

function hasRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeConfiguredChannelKey(raw?: string | null): string {
  return normalizeChatChannelId(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

function normalizeRouteBindingChannelKey(raw?: string | null): string {
  return normalizeLowercaseStringOrEmpty(raw);
}

function listConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  if (!hasRecord(cfg.channels)) {
    return [];
  }
  return Object.entries(cfg.channels)
    .filter(([id, value]) => {
      if (CHANNELS_CONFIG_META_KEYS.has(id)) {
        return false;
      }
      return !(hasRecord(value) && value.enabled === false);
    })
    .map(([id]) => normalizeConfiguredChannelKey(id))
    .filter(Boolean)
    .toSorted();
}

function listConfiguredChannelAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  if (!hasRecord(cfg.channels)) {
    return [];
  }
  const channel = Object.entries(cfg.channels).find(
    ([id]) => normalizeConfiguredChannelKey(id) === channelId,
  )?.[1];
  if (!hasRecord(channel) || !hasRecord(channel.accounts)) {
    return [];
  }
  return Object.entries(channel.accounts)
    .filter(([, value]) => !(hasRecord(value) && value.enabled === false))
    .map(([accountId]) => normalizeAccountId(accountId))
    .filter(Boolean)
    .toSorted();
}

function addTarget(byAgent: Map<string, Set<string>>, agentId: string, channel: string): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const trimmedChannel = channel.trim();
  if (!normalizedAgentId || !trimmedChannel) {
    return;
  }
  const channels = byAgent.get(normalizedAgentId) ?? new Set<string>();
  channels.add(trimmedChannel);
  byAgent.set(normalizedAgentId, channels);
}

export function collectChannelRouteTargets(cfg: OpenClawConfig): ChannelRouteTarget[] {
  const byAgent = new Map<string, Set<string>>();

  for (const binding of listRouteBindings(cfg)) {
    addTarget(byAgent, binding.agentId, normalizeRouteBindingChannelKey(binding.match.channel));
  }

  for (const channel of listConfiguredChannelIds(cfg)) {
    const accountIds = listConfiguredChannelAccountIds(cfg, channel);
    const sampledAccountIds = accountIds.length > 0 ? accountIds : [DEFAULT_ACCOUNT_ID];
    for (const accountId of sampledAccountIds) {
      const route = resolveAgentRoute({
        cfg,
        channel,
        accountId,
      });
      addTarget(byAgent, route.agentId, channel);
    }
  }

  return Array.from(byAgent.entries())
    .map(([agentId, channels]) => ({
      agentId,
      channels: Array.from(channels).toSorted(),
    }))
    .filter((target) => target.channels.length > 0)
    .toSorted((a, b) => a.agentId.localeCompare(b.agentId));
}
