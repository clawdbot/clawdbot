// Channel resolution exposes read-only outbound runtime facades and performs
// optional bootstrap for deliverable channels that are not loaded yet.
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import { channelPluginHasNativeApprovalPromptUi } from "../../channels/plugins/native-approval-prompt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ChannelAgentPromptAdapter,
  ChannelAllowlistAdapter,
  ChannelCapabilities,
  ChannelCommandAdapter,
  ChannelConfigAdapter,
  ChannelConversationBindingSupport,
  ChannelDirectoryAdapter,
  ChannelGroupAdapter,
  ChannelMessageActionAdapter,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPairingAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistry, getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  bootstrapOutboundChannelPlugin,
  resetOutboundChannelBootstrapStateForTests,
} from "./channel-bootstrap.runtime.js";

type ChannelTargetResolver = NonNullable<ChannelMessagingAdapter["targetResolver"]>;

/** Prompt-facing channel capabilities exposed to outbound/runtime callers. */
export type ChannelPromptRuntime = {
  messageToolHints?: ChannelAgentPromptAdapter["messageToolHints"];
  messageToolCapabilities?: ChannelAgentPromptAdapter["messageToolCapabilities"];
  reactionGuidance?: ChannelAgentPromptAdapter["reactionGuidance"];
  hasNativeApprovalPromptUi?: boolean;
};

/** Read-only channel runtime facade assembled from a channel plugin. */
export type OutboundChannelRuntime = {
  id: string;
  label: string;
  chatTypes: NonNullable<ChannelCapabilities["chatTypes"]>;
  preferSessionLookupForAnnounceTarget?: ChannelPlugin["meta"]["preferSessionLookupForAnnounceTarget"];
  actions?: ChannelMessageActionAdapter;
  approvalCapability?: ChannelPlugin["approvalCapability"];
  conversationBindings?: ChannelConversationBindingSupport;
  allowlist?: ChannelAllowlistAdapter;
  pairing?: ChannelPairingAdapter;
  commands?: ChannelCommandAdapter;
  defaultAccountId?: ChannelConfigAdapter<unknown>["defaultAccountId"];
  directory?: ChannelDirectoryAdapter;
  promptRuntime?: ChannelPromptRuntime;
  inferTargetChatType?: ChannelMessagingAdapter["inferTargetChatType"];
  normalizeTarget?: ChannelMessagingAdapter["normalizeTarget"];
  looksLikeTargetId?: ChannelTargetResolver["looksLikeId"];
  targetResolverHint?: string;
  resolveMessagingTargetFallback?: ChannelTargetResolver["resolveTarget"];
  resolveSessionTarget?: ChannelMessagingAdapter["resolveSessionTarget"];
  formatTargetDisplay?: ChannelMessagingAdapter["formatTargetDisplay"];
  resolveOutboundSessionRoute?: ChannelMessagingAdapter["resolveOutboundSessionRoute"];
  buildCrossContextPresentation?: ChannelMessagingAdapter["buildCrossContextPresentation"];
  transformReplyPayload?: ChannelMessagingAdapter["transformReplyPayload"];
  resolveAllowFrom?: ChannelConfigAdapter<unknown>["resolveAllowFrom"];
  resolveDefaultTo?: ChannelConfigAdapter<unknown>["resolveDefaultTo"];
  formatAllowFrom?: ChannelPlugin["config"]["formatAllowFrom"];
  allowFromFallback?: NonNullable<ChannelPlugin["elevated"]>["allowFromFallback"];
  resolveGroupRequireMention?: ChannelGroupAdapter["resolveRequireMention"];
  resolveGroupToolPolicy?: ChannelGroupAdapter["resolveToolPolicy"];
  queueDebounceMs?: NonNullable<NonNullable<ChannelPlugin["defaults"]>["queue"]>["debounceMs"];
  buildThreadingToolContext?: ChannelThreadingAdapter["buildToolContext"];
  resolveAutoThreadId?: ChannelThreadingAdapter["resolveAutoThreadId"];
  resolveReplyToMode?: ChannelThreadingAdapter["resolveReplyToMode"];
  resolveReplyTransport?: ChannelThreadingAdapter["resolveReplyTransport"];
  outbound?: ChannelOutboundAdapter;
  resolveTarget?: ChannelOutboundAdapter["resolveTarget"];
  textChunkLimit?: ChannelOutboundAdapter["textChunkLimit"];
  shouldTreatDeliveredTextAsVisible?: ChannelOutboundAdapter["shouldTreatDeliveredTextAsVisible"];
  shouldTreatRoutedTextAsVisible?: ChannelOutboundAdapter["shouldTreatRoutedTextAsVisible"];
  targetsMatchForReplySuppression?: ChannelOutboundAdapter["targetsMatchForReplySuppression"];
  hasStructuredReplyPayload?: ChannelMessagingAdapter["hasStructuredReplyPayload"];
  blockStreamingCoalesceDefaults?: ChannelStreamingAdapter["blockStreamingCoalesceDefaults"];
};

/** Resets outbound channel bootstrap/resolution state for isolated tests. */
export function resetOutboundChannelResolutionStateForTest(): void {
  resetOutboundChannelBootstrapStateForTests();
}

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

function resolveDirectFromRegistry(
  registry: ReturnType<typeof getActivePluginRegistry>,
  channel: string,
): ChannelPlugin | undefined {
  if (!registry) {
    return undefined;
  }
  for (const entry of registry.channels) {
    const plugin = entry?.plugin;
    if (plugin?.id === channel) {
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

function resolveRuntimeOutboundPlugin(plugin: ChannelPlugin): ChannelPlugin | undefined {
  return channelPluginHasRuntimeOutboundSurface(plugin) ? plugin : undefined;
}

function resolveRuntimeOutboundPluginCandidate(params: {
  loaded?: ChannelPlugin;
  runtime?: ChannelPlugin;
  setupFallback?: ChannelPlugin;
  bundled?: ChannelPlugin;
  allowSetupShell?: boolean;
}): ChannelPlugin | undefined {
  if (channelPluginHasRuntimeOutboundSurface(params.loaded)) {
    return params.loaded;
  }
  if (params.runtime) {
    return params.runtime;
  }
  if (channelPluginHasRuntimeOutboundSurface(params.bundled)) {
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

function toOutboundChannelRuntime(plugin: ChannelPlugin): OutboundChannelRuntime {
  return {
    id: plugin.id,
    label: plugin.meta.label,
    chatTypes: plugin.capabilities.chatTypes,
    preferSessionLookupForAnnounceTarget: plugin.meta.preferSessionLookupForAnnounceTarget,
    actions: plugin.actions,
    approvalCapability: plugin.approvalCapability,
    conversationBindings: plugin.conversationBindings,
    allowlist: plugin.allowlist,
    pairing: plugin.pairing,
    commands: plugin.commands,
    defaultAccountId: plugin.config.defaultAccountId,
    directory: plugin.directory,
    promptRuntime: {
      messageToolHints: plugin.agentPrompt?.messageToolHints,
      messageToolCapabilities: plugin.agentPrompt?.messageToolCapabilities,
      reactionGuidance: plugin.agentPrompt?.reactionGuidance,
      hasNativeApprovalPromptUi: channelPluginHasNativeApprovalPromptUi(plugin),
    },
    inferTargetChatType: plugin.messaging?.inferTargetChatType,
    normalizeTarget: plugin.messaging?.normalizeTarget,
    looksLikeTargetId: plugin.messaging?.targetResolver?.looksLikeId,
    targetResolverHint: plugin.messaging?.targetResolver?.hint,
    resolveMessagingTargetFallback: plugin.messaging?.targetResolver?.resolveTarget,
    resolveSessionTarget: plugin.messaging?.resolveSessionTarget,
    formatTargetDisplay: plugin.messaging?.formatTargetDisplay,
    resolveOutboundSessionRoute: plugin.messaging?.resolveOutboundSessionRoute,
    buildCrossContextPresentation: plugin.messaging?.buildCrossContextPresentation,
    transformReplyPayload: plugin.messaging?.transformReplyPayload,
    resolveAllowFrom: plugin.config?.resolveAllowFrom,
    resolveDefaultTo: plugin.config?.resolveDefaultTo,
    formatAllowFrom: plugin.config?.formatAllowFrom,
    allowFromFallback: plugin.elevated?.allowFromFallback,
    resolveGroupRequireMention: plugin.groups?.resolveRequireMention,
    resolveGroupToolPolicy: plugin.groups?.resolveToolPolicy,
    queueDebounceMs: plugin.defaults?.queue?.debounceMs,
    buildThreadingToolContext: plugin.threading?.buildToolContext,
    resolveAutoThreadId: plugin.threading?.resolveAutoThreadId,
    resolveReplyToMode: plugin.threading?.resolveReplyToMode,
    resolveReplyTransport: plugin.threading?.resolveReplyTransport,
    outbound: plugin.outbound,
    resolveTarget: plugin.outbound?.resolveTarget,
    textChunkLimit: plugin.outbound?.textChunkLimit,
    shouldTreatDeliveredTextAsVisible: plugin.outbound?.shouldTreatDeliveredTextAsVisible,
    shouldTreatRoutedTextAsVisible: plugin.outbound?.shouldTreatRoutedTextAsVisible,
    targetsMatchForReplySuppression: plugin.outbound?.targetsMatchForReplySuppression,
    hasStructuredReplyPayload: plugin.messaging?.hasStructuredReplyPayload,
    blockStreamingCoalesceDefaults: plugin.streaming?.blockStreamingCoalesceDefaults,
  };
}

/** Resolves a deliverable outbound channel plugin, optionally bootstrapping it. */
export function resolveOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
  allowBootstrap?: boolean;
}): ChannelPlugin | undefined {
  const normalized = normalizeDeliverableOutboundChannel(params.channel);
  if (!normalized) {
    return undefined;
  }

  const resolveLoaded = () => getLoadedChannelPlugin(normalized);
  const resolve = () => getChannelPlugin(normalized);
  const current = resolveLoaded();
  const runtimeCurrent = resolveRuntimeOutboundPluginFromRuntimeRegistries(normalized);
  const setupFallback = resolveDirectFromRuntimeRegistries(normalized);
  const bundledCurrent = resolve();
  const candidate = resolveRuntimeOutboundPluginCandidate({
    loaded: current,
    runtime: runtimeCurrent,
    setupFallback,
    bundled: bundledCurrent,
    allowSetupShell: params.allowBootstrap !== true,
  });
  if (candidate) {
    return candidate;
  }

  if (params.allowBootstrap !== true) {
    return undefined;
  }

  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return resolveRuntimeOutboundPluginCandidate({
    loaded: resolveLoaded(),
    runtime: resolveRuntimeOutboundPluginFromRuntimeRegistries(normalized),
    setupFallback: resolveDirectFromRuntimeRegistries(normalized),
    bundled: resolve(),
  });
}

/** Resolves the message adapter for a deliverable outbound channel. */
export function resolveOutboundChannelMessageAdapter(params: {
  channel: string;
  cfg?: OpenClawConfig;
  allowBootstrap?: boolean;
}): ChannelMessageAdapterShape | undefined {
  const normalized = normalizeDeliverableOutboundChannel(params.channel);
  if (!normalized) {
    return undefined;
  }
  const current =
    resolveSendCapableMessageAdapter(getLoadedChannelPlugin(normalized)) ??
    resolveValueFromRuntimeRegistries(normalized, resolveSendCapableMessageAdapter) ??
    resolveSendCapableMessageAdapter(getChannelPlugin(normalized));
  if (current || params.allowBootstrap !== true) {
    return current;
  }
  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return (
    resolveSendCapableMessageAdapter(getLoadedChannelPlugin(normalized)) ??
    resolveValueFromRuntimeRegistries(normalized, resolveSendCapableMessageAdapter) ??
    resolveSendCapableMessageAdapter(getChannelPlugin(normalized))
  );
}

/** Resolves a channel plugin for read-only metadata paths. */
export function resolveOutboundChannelPluginForRead(params: {
  channel: string;
  cfg?: OpenClawConfig;
}): ChannelPlugin | undefined {
  const normalized = normalizeMessageChannel(params.channel) ?? params.channel.trim();
  if (!normalized) {
    return undefined;
  }
  const channelId = normalized as Parameters<typeof getLoadedChannelPlugin>[0];
  const current = getLoadedChannelPlugin(channelId);
  if (current) {
    return current;
  }
  const directCurrent = resolveDirectFromRuntimeRegistries(normalized);
  if (directCurrent) {
    return directCurrent;
  }
  const deliverable = normalizeDeliverableOutboundChannel(normalized);
  if (deliverable) {
    maybeBootstrapChannelPlugin({ channel: deliverable, cfg: params.cfg });
    return (
      getLoadedChannelPlugin(deliverable) ??
      resolveDirectFromRuntimeRegistries(deliverable) ??
      getChannelPlugin(deliverable)
    );
  }
  return getChannelPlugin(channelId);
}

/** Resolves the read-only outbound runtime facade for a channel. */
export function resolveOutboundChannelRuntime(params: {
  channel: string;
  cfg?: OpenClawConfig;
}): OutboundChannelRuntime | undefined {
  const plugin = resolveOutboundChannelPluginForRead(params);
  return plugin ? toOutboundChannelRuntime(plugin) : undefined;
}

/** Reads an already-loaded channel plugin without bootstrapping. */
export function resolveLoadedOutboundChannelPluginForRead(params: {
  channel: string;
}): ChannelPlugin | undefined {
  const normalized = normalizeMessageChannel(params.channel) ?? params.channel.trim();
  if (!normalized) {
    return undefined;
  }
  return (
    getLoadedChannelPlugin(normalized as Parameters<typeof getLoadedChannelPlugin>[0]) ??
    resolveDirectFromRuntimeRegistries(normalized)
  );
}
