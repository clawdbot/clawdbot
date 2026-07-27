/**
 * Effective tool inventory contract types.
 * Shared by agent/session tool inventory resolvers and UI/API callers that
 * present enabled tools grouped by source.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";

/** Source bucket for an effective agent tool inventory entry. */
export type EffectiveToolSource = "core" | "plugin" | "channel" | "mcp";

/** One tool listed in the effective inventory for an agent/session context. */
export type EffectiveToolInventoryEntry = {
  id: string;
  label: string;
  description: string;
  rawDescription: string;
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
  risk?: "low" | "medium" | "high";
  tags?: string[];
};

/** Grouped effective tools for one source bucket. */
export type EffectiveToolInventoryGroup = {
  id: EffectiveToolSource;
  label: string;
  source: EffectiveToolSource;
  tools: EffectiveToolInventoryEntry[];
};

/** Operator-facing notice emitted while building effective tool inventory. */
export type EffectiveToolInventoryNotice = {
  id: string;
  severity: "info" | "warning";
  message: string;
};

/** Effective tool inventory result for one agent/profile. */
export type EffectiveToolInventoryResult = {
  agentId: string;
  profile: string;
  groups: EffectiveToolInventoryGroup[];
  notices?: EffectiveToolInventoryNotice[];
};

/** Inputs for resolving the effective tool inventory in a session/runtime context. */
export type ResolveEffectiveToolInventoryParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  agentDir?: string;
  messageProvider?: string;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  accountId?: string | null;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string | null;
  runtimeModel?: ProviderRuntimeModel;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
  modelHasVision?: boolean;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
};
