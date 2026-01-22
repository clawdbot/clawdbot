import type { MessagingToolSend } from "../pi-embedded-messaging.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  error?: {
    kind: "context_overflow" | "compaction_failure" | "role_ordering";
    message: string;
  };
  /** Stop reason for the agent run (e.g., "completed", "tool_calls"). */
  stopReason?: string;
  /** Pending tool calls when stopReason is "tool_calls". */
  pendingToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
};

export type EmbeddedPiRunResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
  }>;
  meta: EmbeddedPiRunMeta;
  // True if a messaging tool (telegram, whatsapp, discord, slack, sessions_send)
  // successfully sent a message. Used to suppress agent's confirmation text.
  didSendViaMessagingTool?: boolean;
  // Texts successfully sent via messaging tools during the run.
  messagingToolSentTexts?: string[];
  // Messaging tool targets that successfully sent a message during the run.
  messagingToolSentTargets?: MessagingToolSend[];
};

export type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  };
};

export type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  agentWorkspaceMount?: string;
  browserControlUrl?: string;
  browserNoVncUrl?: string;
  hostBrowserAllowed?: boolean;
  allowedControlUrls?: string[];
  allowedControlHosts?: string[];
  allowedControlPorts?: number[];
  elevated?: {
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
  };
};
