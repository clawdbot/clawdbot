import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { ClientToolDefinition } from "../../agents/pi-embedded-runner/run/params.js";

/** Image content block for Claude API multimodal messages. */
export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type AgentStreamParams = {
  /** Provider stream params override (best-effort). */
  temperature?: number;
  maxTokens?: number;
};

export type AgentRunContext = {
  messageChannel?: string;
  accountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };
};

export type AgentCommandOpts = {
  message: string;
  /** Optional image attachments for multimodal messages. */
  images?: ImageContent[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Agent id override (must exist in config). */
  agentId?: string;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  /** Override delivery target (separate from session routing). */
  replyTo?: string;
  /** Override delivery channel (separate from session routing). */
  replyChannel?: string;
  /** Override delivery account id (separate from session routing). */
  replyAccountId?: string;
  /** Message channel context (webchat|voicewake|whatsapp|...). */
  messageChannel?: string;
  channel?: string; // delivery channel (whatsapp|telegram|...)
  /** Account ID for multi-account channel routing (e.g., WhatsApp account). */
  accountId?: string;
  /** Context for embedded run routing (channel/account/thread). */
  runContext?: AgentRunContext;
  deliveryTargetMode?: ChannelOutboundTargetMode;
  bestEffortDeliver?: boolean;
  abortSignal?: AbortSignal;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  /** Per-call stream param overrides (best-effort). */
  streamParams?: AgentStreamParams;
};
