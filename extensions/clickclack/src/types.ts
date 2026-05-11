import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type ClickClackAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  token?: unknown;
  workspace?: string;
  botUserId?: string;
  agentId?: string;
  replyMode?: "agent" | "model";
  model?: string;
  systemPrompt?: string;
  timeoutSeconds?: number;
  toolsAllow?: string[];
  senderIsOwner?: boolean;
  defaultTo?: string;
  allowFrom?: string[];
  reconnectMs?: number;
};

export type ClickClackConfig = ClickClackAccountConfig & {
  accounts?: Record<string, Partial<ClickClackAccountConfig>>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    clickclack?: ClickClackConfig;
  };
};

export type ResolvedClickClackAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  token: string;
  workspace: string;
  botUserId?: string;
  agentId?: string;
  replyMode: "agent" | "model";
  model?: string;
  systemPrompt?: string;
  timeoutSeconds?: number;
  toolsAllow?: string[];
  senderIsOwner: boolean;
  defaultTo: string;
  allowFrom: string[];
  reconnectMs: number;
  config: ClickClackAccountConfig;
};

export type ClickClackUser = {
  id: string;
  kind?: "human" | "bot";
  owner_user_id?: string;
  display_name: string;
  handle: string;
  avatar_url: string;
  created_at: string;
};

export type ClickClackWorkspace = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

export type ClickClackChannel = {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  created_at: string;
};

export type ClickClackMessage = {
  id: string;
  workspace_id: string;
  channel_id?: string;
  direct_conversation_id?: string;
  author_id: string;
  parent_message_id?: string;
  thread_root_id: string;
  channel_seq?: number;
  thread_seq?: number;
  body: string;
  body_format: "markdown";
  created_at: string;
  author?: ClickClackUser;
};

export type ClickClackEvent = {
  id: string;
  cursor: string;
  type: string;
  workspace_id: string;
  channel_id?: string;
  seq?: number;
  created_at: string;
  payload: Record<string, unknown>;
};

export type ClickClackTarget =
  | { chatType: "group"; kind: "channel"; id: string }
  | { chatType: "group"; kind: "thread"; id: string }
  | { chatType: "direct"; kind: "dm"; id: string };
