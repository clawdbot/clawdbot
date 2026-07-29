/**
 * Public channel plugin type barrel.
 *
 * Re-exports stable plugin-facing channel types and message action names.
 */
import type { ChannelMessageActionName as ChannelMessageActionNameFromList } from "./message-action-names.js";

export { CHANNEL_MESSAGE_ACTION_NAMES } from "./message-action-names.js";
export type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAccountSnapshot,
  ChannelAgentTool,
  ChannelCapabilities,
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelGroupContext,
  ChannelHeartbeatDeps,
  ChannelId,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
  ChannelMessagingAdapter,
  ChannelMeta,
  ChannelOutboundTargetMode,
  ChannelPollResult,
  ChannelSetupInput,
  ChannelStatusIssue,
  ChannelStructuredComponents,
  ChannelThreadingAdapter,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelToolSend,
} from "./types.core.js";
export type {
  ChannelApprovalAdapter,
  ChannelApprovalCapability,
  ChannelCapabilitiesDiagnostics,
  ChannelCapabilitiesDisplayLine,
  ChannelCommandConversationContext,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
} from "./types.adapters.js";
export type { ChannelMessageCapability } from "./message-capabilities.js";
export type { ChannelPlugin } from "./types.plugin.js";

/** Stable message action name union derived from the registered action list. */
export type ChannelMessageActionName = ChannelMessageActionNameFromList;
