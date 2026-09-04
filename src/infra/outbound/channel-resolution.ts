// Channel resolution exposes read-only outbound runtime facades and performs
// optional bootstrap for deliverable channels that are not loaded yet.
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
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
import { findChannelPluginInRegistry } from "./runtime-visible-channels.js";

/** Normalizes a raw channel id and rejects non-deliverable/internal channels. */
export function normalizeDeliverableOutboundChannel(raw?: string | null): string | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function getOutboundRuntimeRegistry(): PluginRegistry | null {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

function normalizeOutboundChannelForResolution(params: {
  channel: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  allowBootstrap?: boolean;
  requiredAction?: ChannelMessageActionName;
}): {
  channel?: string;
  didBootstrap: boolean;
  bootstrapRegistry?: PluginRegistry;
} {
  const normalized = normalizeMessageChannel(params.channel);
  const deliverable =
    normalized && isDeliverableMessageChannel(normalized) ? normalized : undefined;
  if (deliverable || !normalized || normalized === INTERNAL_MESSAGE_CHANNEL) {
    return { channel: deliverable, didBootstrap: false };
  }

  const activeRuntimePlugin = resolveActivatedOutboundPluginFromRuntimeRegistry(
    normalized,
    getOutboundRuntimeRegistry() ?? undefined,
    params.requiredAction,
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
  const bootstrapRegistry = bootstrapOutboundChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAction: params.requiredAction,
  });
  const bootstrappedRuntimePlugin = resolveActivatedOutboundPluginFromRuntimeRegistry(
    normalized,
    bootstrapRegistry,
    params.requiredAction,
  );
  return {
    channel: bootstrappedRuntimePlugin?.id ?? normalized,
    didBootstrap: true,
    ...(bootstrapRegistry ? { bootstrapRegistry } : {}),
  };
}

function resolveSendCapableMessageAdapter(
  plugin: ChannelPlugin | undefined,
): ChannelMessageAdapterShape | undefined {
  const message = plugin?.message;
  return typeof message?.send?.text === "function" ? message : undefined;
}

function channelPluginHasRuntimeOutboundSurface(
  plugin: ChannelPlugin | undefined,
  requiredAction?: ChannelMessageActionName,
): boolean {
  return Boolean(
    plugin?.outbound ??
    resolveSendCapableMessageAdapter(plugin) ??
    (requiredAction &&
      plugin?.actions?.handleAction &&
      (!plugin.actions.supportsAction ||
        plugin.actions.supportsAction({ action: requiredAction }))),
  );
}

function channelPluginHasActivatedOutboundSurface(
  plugin: ChannelPlugin | undefined,
  requiredAction?: ChannelMessageActionName,
): boolean {
  return Boolean(
    plugin?.outbound?.sendText ||
    plugin?.outbound?.deliveryMode === "gateway" ||
    resolveSendCapableMessageAdapter(plugin) ||
    (requiredAction &&
      plugin?.actions?.handleAction &&
      (!plugin.actions.supportsAction ||
        plugin.actions.supportsAction({ action: requiredAction }))),
  );
}

function resolveRuntimeOutboundPlugin(
  plugin: ChannelPlugin,
  requiredAction?: ChannelMessageActionName,
): ChannelPlugin | undefined {
  return channelPluginHasRuntimeOutboundSurface(plugin, requiredAction) ? plugin : undefined;
}

function resolveActivatedOutboundPlugin(
  plugin: ChannelPlugin,
  requiredAction?: ChannelMessageActionName,
): ChannelPlugin | undefined {
  return channelPluginHasActivatedOutboundSurface(plugin, requiredAction) ? plugin : undefined;
}

function resolveRuntimeOutboundPluginCandidate(params: {
  loaded?: ChannelPlugin;
  runtime?: ChannelPlugin;
  setupFallback?: ChannelPlugin;
  bundled?: ChannelPlugin;
  allowSetupShell?: boolean;
  requireActivatedRuntime?: boolean;
  requiredAction?: ChannelMessageActionName;
}): ChannelPlugin | undefined {
  const hasRuntimeSurface = params.requireActivatedRuntime
    ? (plugin: ChannelPlugin | undefined) =>
        channelPluginHasActivatedOutboundSurface(plugin, params.requiredAction)
    : (plugin: ChannelPlugin | undefined) =>
        channelPluginHasRuntimeOutboundSurface(plugin, params.requiredAction);
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
  const plugin = findChannelPluginInRegistry(registry, channel);
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
  requiredAction?: ChannelMessageActionName,
): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistry(
    channel,
    (plugin) => resolveRuntimeOutboundPlugin(plugin, requiredAction),
    registry,
  );
}

function resolveActivatedOutboundPluginFromRuntimeRegistry(
  channel: string,
  registry?: PluginRegistry,
  requiredAction?: ChannelMessageActionName,
): ChannelPlugin | undefined {
  return resolveValueFromRuntimeRegistry(
    channel,
    (plugin) => resolveActivatedOutboundPlugin(plugin, requiredAction),
    registry,
  );
}

/** Resolves a deliverable outbound channel plugin, optionally bootstrapping it. */
export function resolveOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  allowBootstrap?: boolean;
  requiredAction?: ChannelMessageActionName;
}): ChannelPlugin | undefined {
  const {
    channel: normalized,
    didBootstrap,
    bootstrapRegistry,
  } = normalizeOutboundChannelForResolution(params);
  if (!normalized) {
    return undefined;
  }

  const scopedPlugin = findChannelPluginInRegistry(
    bootstrapRegistry ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
    normalized,
  );
  if (scopedPlugin) {
    // A selected registration owns absent capabilities too. Only explicit
    // activation may replace a setup shell; never borrow a same-id sender.
    if (
      params.allowBootstrap !== true ||
      channelPluginHasActivatedOutboundSurface(scopedPlugin, params.requiredAction)
    ) {
      return scopedPlugin;
    }
    if (didBootstrap) {
      return undefined;
    }
    return resolveActivatedOutboundPluginFromRuntimeRegistry(
      normalized,
      bootstrapOutboundChannelPlugin({ ...params, channel: normalized }),
      params.requiredAction,
    );
  }

  const resolveLoaded = () => getLoadedChannelPlugin(normalized);
  const resolve = () => getChannelPlugin(normalized);
  const current = resolveLoaded();
  const requireActivatedRuntime = params.allowBootstrap === true;
  const runtimeCurrent = requireActivatedRuntime
    ? resolveActivatedOutboundPluginFromRuntimeRegistry(
        normalized,
        bootstrapRegistry,
        params.requiredAction,
      )
    : resolveRuntimeOutboundPluginFromRuntimeRegistry(
        normalized,
        bootstrapRegistry,
        params.requiredAction,
      );
  const setupFallback = resolveDirectFromRuntimeRegistry(normalized, bootstrapRegistry);
  const bundledCurrent = resolve();
  const candidate = resolveRuntimeOutboundPluginCandidate({
    loaded: current,
    runtime: runtimeCurrent,
    setupFallback,
    bundled: bundledCurrent,
    allowSetupShell: params.allowBootstrap !== true,
    requireActivatedRuntime,
    requiredAction: params.requiredAction,
  });
  if (candidate) {
    return candidate;
  }

  if (params.allowBootstrap !== true || didBootstrap) {
    return undefined;
  }

  const registry = bootstrapOutboundChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAction: params.requiredAction,
  });
  return resolveRuntimeOutboundPluginCandidate({
    loaded: resolveLoaded(),
    runtime: resolveActivatedOutboundPluginFromRuntimeRegistry(
      normalized,
      registry,
      params.requiredAction,
    ),
    setupFallback: resolveDirectFromRuntimeRegistry(normalized, registry),
    bundled: resolve(),
    requireActivatedRuntime: true,
    requiredAction: params.requiredAction,
  });
}

/** Resolves the message adapter for a deliverable outbound channel. */
export function resolveOutboundChannelMessageAdapter(params: {
  channel: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  allowBootstrap?: boolean;
}): ChannelMessageAdapterShape | undefined {
  return resolveSendCapableMessageAdapter(resolveOutboundChannelPlugin(params));
}
