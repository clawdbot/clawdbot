import type { NormalizedChatType } from "../channels/chat-type.js";
import type { SessionEntry } from "../config/sessions.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
};

export type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: NormalizedChatType;
  origin?: SessionEntry["origin"];
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionEntry["lastChannel"];
  lastTo?: string;
  lastAccountId?: string;
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: SessionEntry;
};
