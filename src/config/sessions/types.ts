import crypto from "node:crypto";

import type { Skill } from "@mariozechner/pi-coding-agent";
import type { NormalizedChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { TtsAutoMode } from "../types.tts.js";

export type SessionScope = "per-sender" | "global";

export type SessionChannelId = ChannelId | "webchat";

export type SessionChatType = NormalizedChatType;

export type SessionOrigin = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionEntry = {
  /**
   * Last delivered heartbeat payload (used to suppress duplicate heartbeat notifications).
   * Stored on the main session entry.
   */
  lastHeartbeatText?: string;
  /** Timestamp (ms) when lastHeartbeatText was delivered. */
  lastHeartbeatSentAt?: number;
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  /** Parent session key that spawned this session (used for sandbox session-tool scoping). */
  spawnedBy?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  chatType?: SessionChatType;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  ttsAuto?: TtsAutoMode;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  responseUsage?: "on" | "off" | "tokens" | "full";
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
  groupActivation?: "mention" | "always";
  groupActivationNeedsSystemIntro?: boolean;
  sendPolicy?: "allow" | "deny";
  queueMode?:
    | "steer"
    | "followup"
    | "collect"
    | "steer-backlog"
    | "steer+backlog"
    | "queue"
    | "interrupt";
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: "old" | "new" | "summarize";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  compactionCount?: number;
  memoryFlushAt?: number;
  memoryFlushCompactionCount?: number;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  label?: string;
  displayName?: string;
  channel?: string;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  origin?: SessionOrigin;
  deliveryContext?: DeliveryContext;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  skillsSnapshot?: SessionSkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
};

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now());
  if (!existing) return { ...patch, sessionId, updatedAt };
  return { ...existing, ...patch, sessionId, updatedAt };
}

export type GroupKeyResolution = {
  key: string;
  channel?: string;
  id?: string;
  chatType?: SessionChatType;
};

export type SessionSkillSnapshot = {
  prompt: string;
  skills: Array<{ name: string; primaryEnv?: string }>;
  resolvedSkills?: Skill[];
  version?: number;
};

export type SessionSystemPromptReport = {
  source: "run" | "estimate";
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  sandbox?: {
    mode?: string;
    sandboxed?: boolean;
  };
  systemPrompt: {
    chars: number;
    projectContextChars: number;
    nonProjectContextChars: number;
  };
  injectedWorkspaceFiles: Array<{
    name: string;
    path: string;
    missing: boolean;
    rawChars: number;
    injectedChars: number;
    truncated: boolean;
  }>;
  skills: {
    promptChars: number;
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{
      name: string;
      summaryChars: number;
      schemaChars: number;
      propertiesCount?: number | null;
    }>;
  };
};

export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;
