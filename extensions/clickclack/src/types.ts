/**
 * Shared ClickClack config, runtime account, API object, and target types.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/** User-configurable settings for one ClickClack account. */
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
  defaultTo?: string;
  allowFrom?: string[];
  reconnectMs?: number;
};

/** Root ClickClack channel config with optional named accounts. */
export type ClickClackConfig = ClickClackAccountConfig & {
  accounts?: Record<string, Partial<ClickClackAccountConfig>>;
  defaultAccount?: string;
};

/** OpenClaw config narrowed to include ClickClack channel settings. */
export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    clickclack?: ClickClackConfig;
  };
};

/** Normalized account snapshot consumed by runtime paths. */
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
  defaultTo: string;
  allowFrom: string[];
  reconnectMs: number;
  config: ClickClackAccountConfig;
};

/** User object returned by the ClickClack API. */
export type ClickClackUser = {
  id: string;
  kind?: "human" | "bot";
  owner_user_id?: string;
  display_name: string;
  handle: string;
  avatar_url: string;
  created_at: string;
};

/** Workspace object returned by the ClickClack API. */
export type ClickClackWorkspace = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

/** Channel object returned by the ClickClack API. */
export type ClickClackChannel = {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  created_at: string;
};

/** Message object returned by ClickClack channel, DM, and thread endpoints. */
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

/** Realtime event envelope returned by ClickClack polling/websocket APIs. */
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

/** Parsed outbound destination for ClickClack delivery. */
export type ClickClackTarget =
  | { chatType: "group"; kind: "channel"; id: string }
  | { chatType: "group"; kind: "thread"; id: string }
  | { chatType: "direct"; kind: "dm"; id: string };
