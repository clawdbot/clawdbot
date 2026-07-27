// Channel resolution exposes read-only outbound runtime facades and performs
// optional bootstrap for deliverable channels that are not loaded yet.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../../utils/message-channel.js";
import { bootstrapOutboundChannelPlugin } from "./channel-bootstrap.runtime.js";

/** Normalizes a raw channel id and rejects non-deliverable/internal channels. */
export function normalizeDeliverableOutboundChannel(
  raw?: string | null,
): DeliverableMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function maybeBootstrapChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  bootstrapOutboundChannelPlugin(params);
}

function normalizeOutboundChannelForResolution(params: {
  channel: string;
  cfg?: OpenClawConfig;
  allowBootstrap?: boolean;
}): { channel?: DeliverableMessageChannel; didBootstrap: boolean } {
  const normalized = normalizeMessageChannel(params.channel);
  const deliverable = normalizeDeliverableOutboundChannel(normalized);
  if (deliverable || !normalized || normalized === INTERNAL_MESSAGE_CHANNEL) {
    return { channel: deliverable, didBootstrap: false };
  }

  const activeRuntimePlugin = resolveActivatedOutboundPluginFromRuntimeRegistries(normalized);
  if (activeRuntimePlugin) {
    return {
      channel: activeRuntimePlugin.id as DeliverableMessageChannel,
      didBootstrap: false,
    };
  }
  if (params.allowBootstrap !== true) {
    return { channel: undefined, didBootstrap: false };
  }

  // External channel ids remain normalized before their runtime is registered.
  // Bootstrap first, then let the runtime candidate lookup confirm sendability.
  maybeBootstrapChannelPlugin({
    channel: normalized as DeliverableMessageChannel,
    cfg: params.cfg,
  });
  const bootstrappedRuntimePlugin = resolveActivatedOutboundPluginFromRuntimeRegistries(normalized);
  return {
    // The pinned channel registry may intentionally lag the active runtime
    // registry, so strict registry validation here would hide a usable plugin.
    channel: (bootstrappedRuntimePlugin?.id ?? normalized) as DeliverableMessageChannel,
    didBootstrap: true,
  };
}

function resolveDirectFromRegistry(
  registry: ReturnType<typeof getActivePluginRegistry>,
  channel: string,
): ChannelPlugin | undefined {
  if (!registry) {
    return undefined;
  }
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!normalizedChannel) {
    return undefined;
  }
  for (const entry of registry.channels) {
    const plugin = entry?.plugin;
    if (
      normalizeOptionalLowercaseString(plugin?.id) === normalizedChannel ||
      plugin?.meta?.aliases?.some(
        (alias) => normalizeOptionalLowercaseString(alias) === normalizedChannel,
      )
    ) {
      return plugin;
    }
  }
  return undefined;
}

function messageAdapterCanSendText(
  message: ChannelMessageAdapterShape | undefined,
): message is ChannelMessageAdapterShape {
  return typeof message?.send?.text === "function";
}

function resolveSendCapableMessageAdapter(
  plugin: ChannelPlugin | undefined,
): ChannelMessageAdapterShape | undefined {
  const message = plugin?.message;
  return messageAdapterCanSendText(message) ? message : undefined;
}

function channelPluginHasRuntimeOutboundSurface(plugin: ChannelPlugin | undefined): boolean {
  return Boolean(plugin?.outbound ?? resolveSendCapableMessageAdapter(plugin));
}

function channelPluginHasActivatedOutboundSurface(plugin: ChannelPlugin | undefined): boolean {
  return Boolean(
    plugin?.outbound?.sendText ||
    plugin?.outbound?.deliveryMode === "gateway" ||
    resolveSendCapableMessageAdapter(plugin),
  );
}

function resolveRuntimeOutboundPlugin(plugin: ChannelPlugin): ChannelPlugin | undefined {
  return channelPluginHasRuntimeOutboundSurface(plugin) ? plugin : undefined;
}

function resolveActivatedOutboundPlugin(plugin: ChannelPlugin): ChannelPlugin | undefined {
  return channelPluginHasActivatedOutboundSurface(plugin) ? plugin : undefined;
}

function resolveRuntimeOutboundPluginCandidate(params: {
  loaded?: ChannelPlugin;
  runtime?: ChannelPlugin;
  setupFallback?: ChannelPlugin;
  bundled?: ChannelPlugin;
  allowSetupShell?: boolean;
  requireActivatedRuntime?: boolean;
}): ChannelPlugin | undefined {
  const hasRuntimeSurface = params.requireActivatedRuntime
    ? channelPluginHasActivatedOutboundSurface
    : channelPluginHasRuntimeOutboundSurface;
  if (hasRuntimeSurface(params.loaded)) {
    return params.loaded;
  }
  if (hasRuntimeSurface(params.runtime)) {
    return params.runtime;
  }
  if (hasRuntimeSurface(params.bundled)) {
    return params.bundled;
  }
  if (params.allowSetupShell) {
    return params.loaded ?? params.setupFallback ?? params.bundled;
  }
  return undefined;
}

function resolveValueFromRuntimeRegistries<TValue>(
  channel: string,
  resolveValue: (plugin: ChannelPlugin) => TValue | undefined,
): TValue | undefined {
  const channelRegistry = getActivePluginChannelRegistry();
  const channelPlugin = resolveDirectFromRegistry(channelRegistry, channel);
  if (channelPlugin) {
    const value = resolveValue(channelPlugin);
    if (value !== undefined) {
      return value;
    }
  }
  const activeRegistry = getActivePluginRegistry();
  if (activeRegistry && activeRegistry !== channelRegistry) {
    const activePlugin = resolveDirectFromRegistry(activeRegistry, channel);
    if (activePlugin) {
      return resolveValue(activePlugin);
    }
  }
  return undefined;
}

function resolveDirectFromRuntimeRegistries(channel: string): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistries(channel, (plugin) => plugin);
}

function resolveRuntimeOutboundPluginFromRuntimeRegistries(
  channel: string,
): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistries(channel, resolveRuntimeOutboundPlugin);
}

function resolveActivatedOutboundPluginFromRuntimeRegistries(
  channel: string,
): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistries(channel, resolveActivatedOutboundPlugin);
}

/** Resolves a deliverable outbound channel plugin, optionally bootstrapping it. */
export function resolveOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
  allowBootstrap?: boolean;
}): ChannelPlugin | undefined {
  const { channel: normalized, didBootstrap } = normalizeOutboundChannelForResolution(params);
  if (!normalized) {
    return undefined;
  }

  const resolveLoaded = () => getLoadedChannelPlugin(normalized);
  const resolve = () => getChannelPlugin(normalized);
  const current = resolveLoaded();
  const requireActivatedRuntime = params.allowBootstrap === true;
  const runtimeCurrent = requireActivatedRuntime
    ? resolveActivatedOutboundPluginFromRuntimeRegistries(normalized)
    : resolveRuntimeOutboundPluginFromRuntimeRegistries(normalized);
  const setupFallback = resolveDirectFromRuntimeRegistries(normalized);
  const bundledCurrent = resolve();
  const candidate = resolveRuntimeOutboundPluginCandidate({
    loaded: current,
    runtime: runtimeCurrent,
    setupFallback,
    bundled: bundledCurrent,
    allowSetupShell: params.allowBootstrap !== true,
    requireActivatedRuntime,
  });
  if (candidate) {
    return candidate;
  }

  if (params.allowBootstrap !== true || didBootstrap) {
    return undefined;
  }

  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return resolveRuntimeOutboundPluginCandidate({
    loaded: resolveLoaded(),
    runtime: resolveActivatedOutboundPluginFromRuntimeRegistries(normalized),
    setupFallback: resolveDirectFromRuntimeRegistries(normalized),
    bundled: resolve(),
    requireActivatedRuntime: true,
  });
}

/** Resolves the message adapter for a deliverable outbound channel. */
export function resolveOutboundChannelMessageAdapter(params: {
  channel: string;
  cfg?: OpenClawConfig;
  allowBootstrap?: boolean;
}): ChannelMessageAdapterShape | undefined {
  const { channel: normalized, didBootstrap } = normalizeOutboundChannelForResolution(params);
  if (!normalized) {
    return undefined;
  }
  const current =
    resolveSendCapableMessageAdapter(getLoadedChannelPlugin(normalized)) ??
    resolveValueFromRuntimeRegistries(normalized, resolveSendCapableMessageAdapter) ??
    resolveSendCapableMessageAdapter(getChannelPlugin(normalized));
  if (current || params.allowBootstrap !== true || didBootstrap) {
    return current;
  }
  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return (
    resolveSendCapableMessageAdapter(getLoadedChannelPlugin(normalized)) ??
    resolveValueFromRuntimeRegistries(normalized, resolveSendCapableMessageAdapter) ??
    resolveSendCapableMessageAdapter(getChannelPlugin(normalized))
  );
}
