import { getActivePluginChannelRegistryFromState } from "../../plugins/runtime-channel-state.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { normalizeMessageChannel } from "../../utils/message-channel-core.js";

const TARGET_KIND_PREFIXES = new Set([
  "channel",
  "conversation",
  "dm",
  "group",
  "room",
  "thread",
  "user",
]);

export type ChannelTargetProviderPrefix = {
  prefix: string;
  channel: string;
};

function resolvePluginTargetPrefix(prefix: string): string | undefined {
  const normalizedPrefix = normalizeOptionalLowercaseString(prefix);
  if (!normalizedPrefix) {
    return undefined;
  }
  const registry = getActivePluginChannelRegistryFromState();
  for (const entry of registry?.channels ?? []) {
    const plugin = entry.plugin;
    const channelId = normalizeOptionalLowercaseString(plugin.id);
    const candidates = plugin.messaging?.targetPrefixes ?? [];
    if (
      channelId &&
      candidates.some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedPrefix,
      )
    ) {
      return channelId;
    }
  }
  return undefined;
}

function resolveChannelTargetProviderPrefix(
  raw?: string | null,
): ChannelTargetProviderPrefix | undefined {
  const match = /^\s*([a-z][a-z0-9_-]*):/i.exec(raw ?? "");
  const prefix = normalizeOptionalLowercaseString(match?.[1]);
  if (!prefix || TARGET_KIND_PREFIXES.has(prefix)) {
    return undefined;
  }
  const channel = resolvePluginTargetPrefix(prefix);
  return channel ? { prefix, channel } : undefined;
}

export function resolveTargetPrefixedChannel(raw?: string | null): string | undefined {
  return resolveChannelTargetProviderPrefix(raw)?.channel;
}

export function validateTargetProviderPrefix(params: {
  channel: string;
  to?: string | null;
}): Error | undefined {
  const selectedChannel =
    normalizeMessageChannel(params.channel) ?? normalizeOptionalLowercaseString(params.channel);
  if (!selectedChannel || selectedChannel === "last") {
    return undefined;
  }
  const prefixed = resolveChannelTargetProviderPrefix(params.to);
  if (!prefixed || prefixed.channel === selectedChannel) {
    return undefined;
  }
  return new Error(
    `Target prefix "${prefixed.prefix}:" belongs to ${prefixed.channel}, not ${selectedChannel}.`,
  );
}
