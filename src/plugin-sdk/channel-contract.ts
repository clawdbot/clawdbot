// Pure channel contract types used by plugin implementations and tests.
export type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAgentTool,
  ChannelAccountSnapshot,
  ChannelApprovalAdapter,
  ChannelApprovalCapability,
  ChannelCommandConversationContext,
  ChannelDirectoryEntry,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
  ChannelStructuredComponents,
  ChannelStatusIssue,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelToolSend,
} from "../channels/plugins/types.public.js";
export type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";

export type {
  ChannelDirectoryAdapter,
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorEmptyAllowlistAccountContext,
  ChannelDoctorLegacyConfigRule,
  ChannelDoctorSequenceResult,
  ChannelGatewayContext,
  ChannelOutboundAdapter,
} from "../channels/plugins/types.adapters.js";
export type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
