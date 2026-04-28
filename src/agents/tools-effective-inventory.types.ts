import type { OpenClawConfig } from "../config/types.openclaw.js";

export type EffectiveToolSource = "core" | "plugin" | "channel";

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

export type EffectiveToolInventoryGroup = {
  id: EffectiveToolSource;
  label: string;
  source: EffectiveToolSource;
  tools: EffectiveToolInventoryEntry[];
};

export type EffectiveToolInventoryNotice = {
  id: string;
  severity: "info" | "warning";
  message: string;
};

export type EffectiveToolInventoryResult = {
  agentId: string;
  profile: string;
  groups: EffectiveToolInventoryGroup[];
  notices?: EffectiveToolInventoryNotice[];
};

export type ResolveEffectiveToolInventoryParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  agentDir?: string;
  messageProvider?: string;
  senderIsOwner?: boolean;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  accountId?: string | null;
  modelProvider?: string;
  modelId?: string;
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
