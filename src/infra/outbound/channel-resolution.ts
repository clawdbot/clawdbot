// Channel resolution exposes read-only outbound runtime facades and performs
// optional bootstrap for deliverable channels that are not loaded yet.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { bootstrapOutboundChannelPlugin } from "./channel-bootstrap.runtime.js";

/** Normalizes a raw channel id and rejects non-deliverable/internal channels. */
export function normalizeDeliverableOutboundChannel(raw?: string | null): string | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function maybeBootstrapChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
}): PluginRegistry | undefined {
  return bootstrapOutboundChannelPlugin(params);
}

function getOutboundRuntimeRegistry(): PluginRegistry | null {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

function normalizeOutboundChannelForResolution(params: {
  channel: string;
  cfg?: OpenClawConfig;
  allowBootstrap?: boolean;
}): {
  channel?: string;
  didBootstrap: boolean;
  bootstrapRegistry?: PluginRegistry;
} {
  const normalized = normalizeMessageChannel(params.channel);
  const deliverable = normalizeDeliverableOutboundChannel(normalized);
  if (deliverable || !normalized || normalized === INTERNAL_MESSAGE_CHANNEL) {
    return { channel: deliverable, didBootstrap: false };
  }

  const activeRuntimePlugin = resolveActivatedOutboundPluginFromRuntimeRegistry(
    normalized,
    getOutboundRuntimeRegistry() ?? undefined,
  );
  if (activeRuntimePlugin) {
    return {
      channel: activeRuntimePlugin.id,
      didBootstrap: false,
    };
  }
  if (params.allowBootstrap !== true) {
    return { channel: undefined, didBootstrap: false };
  }

  // External channel ids remain normalized before their runtime is registered.
  // Bootstrap first, then let the runtime candidate lookup confirm sendability.
  const bootstrapRegistry = maybeBootstrapChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
  });
  const bootstrappedRuntimePlugin = resolveActivatedOutboundPluginFromRuntimeRegistry(
    normalized,
    bootstrapRegistry,
  );
  return {
    channel: bootstrappedRuntimePlugin?.id ?? normalized,
    didBootstrap: true,
    ...(bootstrapRegistry ? { bootstrapRegistry } : {}),
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

function resolveValueFromRuntimeRegistry<TValue>(
  channel: string,
  resolveValue: (plugin: ChannelPlugin) => TValue | undefined,
  registry: PluginRegistry | null | undefined = getOutboundRuntimeRegistry(),
): TValue | undefined {
  const plugin = resolveDirectFromRegistry(registry ?? null, channel);
  return plugin ? resolveValue(plugin) : undefined;
}

function resolveDirectFromRuntimeRegistry(
  channel: string,
  registry?: PluginRegistry,
): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistry(channel, (plugin) => plugin, registry);
}

function resolveRuntimeOutboundPluginFromRuntimeRegistry(
  channel: string,
  registry?: PluginRegistry,
): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistry(channel, resolveRuntimeOutboundPlugin, registry);
}

function resolveActivatedOutboundPluginFromRuntimeRegistry(
  channel: string,
  registry?: PluginRegistry,
): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistry(channel, resolveActivatedOutboundPlugin, registry);
}

/** Resolves a deliverable outbound channel plugin, optionally bootstrapping it. */
export function resolveOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
  allowBootstrap?: boolean;
}): ChannelPlugin | undefined {
  const {
    channel: normalized,
    didBootstrap,
    bootstrapRegistry,
  } = normalizeOutboundChannelForResolution(params);
  if (!normalized) {
    return undefined;
  }

  const resolveLoaded = () => getLoadedChannelPlugin(normalized);
  const resolve = () => getChannelPlugin(normalized);
  const current = resolveLoaded();
  const requireActivatedRuntime = params.allowBootstrap === true;
  const runtimeCurrent = requireActivatedRuntime
    ? resolveActivatedOutboundPluginFromRuntimeRegistry(normalized, bootstrapRegistry)
    : resolveRuntimeOutboundPluginFromRuntimeRegistry(normalized, bootstrapRegistry);
  const setupFallback = resolveDirectFromRuntimeRegistry(normalized, bootstrapRegistry);
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

  const registry = maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return resolveRuntimeOutboundPluginCandidate({
    loaded: resolveLoaded(),
    runtime: resolveActivatedOutboundPluginFromRuntimeRegistry(normalized, registry),
    setupFallback: resolveDirectFromRuntimeRegistry(normalized, registry),
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
  const {
    channel: normalized,
    didBootstrap,
    bootstrapRegistry,
  } = normalizeOutboundChannelForResolution(params);
  if (!normalized) {
    return undefined;
  }
  const current =
    resolveSendCapableMessageAdapter(getLoadedChannelPlugin(normalized)) ??
    resolveValueFromRuntimeRegistry(
      normalized,
      resolveSendCapableMessageAdapter,
      bootstrapRegistry,
    ) ??
    resolveSendCapableMessageAdapter(getChannelPlugin(normalized));
  if (current || params.allowBootstrap !== true || didBootstrap) {
    return current;
  }
  const registry = maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return (
    resolveSendCapableMessageAdapter(getLoadedChannelPlugin(normalized)) ??
    resolveValueFromRuntimeRegistry(normalized, resolveSendCapableMessageAdapter, registry) ??
    resolveSendCapableMessageAdapter(getChannelPlugin(normalized))
  );
}
