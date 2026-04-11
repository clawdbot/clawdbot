import type { CliSessionBinding, SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { MessagingToolSend } from "../pi-embedded-messaging.js";

export type EmbeddedPiAgentMeta = {
  sessionId: string;
  provider: string;
  model: string;
  cliSessionBinding?: CliSessionBinding;
  compactionCount?: number;
  promptTokens?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  /**
   * Usage from the last individual API call (not accumulated across tool-use
   * loops or compaction retries). Used for context-window utilization display
   * (`totalTokens` in sessions.json) because the accumulated `usage.input`
   * sums input tokens from every API call in the run, which overstates the
   * actual context size.
   */
  lastCallUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type EmbeddedRunLivenessState = "working" | "paused" | "blocked" | "abandoned";

export type EmbeddedPiRunMeta = {
  durationMs: number;
  agentMeta?: EmbeddedPiAgentMeta;
  aborted?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  finalAssistantVisibleText?: string;
  replayInvalid?: boolean;
  livenessState?: EmbeddedRunLivenessState;
  error?: {
    kind:
      | "context_overflow"
      | "compaction_failure"
      | "role_ordering"
      | "image_size"
      | "retry_limit";
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
    isReasoning?: boolean;
    audioAsVoice?: boolean;
  }>;
  meta: EmbeddedPiRunMeta;
  // True if a messaging tool (telegram, whatsapp, discord, slack, sessions_send)
  // successfully sent a message. Used to suppress agent's confirmation text.
  didSendViaMessagingTool?: boolean;
  // Texts successfully sent via messaging tools during the run.
  messagingToolSentTexts?: string[];
  // Media URLs successfully sent via messaging tools during the run.
  messagingToolSentMediaUrls?: string[];
  // Messaging tool targets that successfully sent a message during the run.
  messagingToolSentTargets?: MessagingToolSend[];
  // Count of successful cron.add tool calls in this run.
  successfulCronAdds?: number;
};

export type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

export type EmbeddedFullAccessBlockedReason = "sandbox" | "host-policy" | "channel" | "runtime";

export type EmbeddedSandboxInfo = {
  enabled: boolean;
  workspaceDir?: string;
  containerWorkspaceDir?: string;
  workspaceAccess?: "none" | "ro" | "rw";
  agentWorkspaceMount?: string;
  browserBridgeUrl?: string;
  hostBrowserAllowed?: boolean;
  elevated?: {
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
    fullAccessAvailable: boolean;
    fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
  };
};
