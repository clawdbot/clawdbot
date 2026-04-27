import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import type { EmbeddedRunReplayState } from "./pi-embedded-runner/replay-state.js";
import type { BlockReplyChunking, ToolResultFormat } from "./pi-embedded-subscribe.shared-types.js";
export type { BlockReplyChunking, ToolResultFormat } from "./pi-embedded-subscribe.shared-types.js";

export type SubscribeEmbeddedPiSessionParams = {
  session: AgentSession;
  runId: string;
  initialReplayState?: EmbeddedRunReplayState;
  hookRunner?: HookRunner;
  verboseLevel?: VerboseLevel;
  reasoningMode?: ReasoningLevel;
  thinkingLevel?: ThinkLevel;
  toolResultFormat?: ToolResultFormat;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  /** Called when a thinking/reasoning block ends (</think> tag processed). */
  onReasoningEnd?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  /** Flush pending block replies (e.g., before tool execution to preserve message boundaries). */
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
  /** Best-effort hook invoked immediately before the terminal lifecycle event is emitted. */
  onBeforeLifecycleTerminal?: () => void | Promise<void>;
  enforceFinalTag?: boolean;
  silentExpected?: boolean;
  config?: OpenClawConfig;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /** Agent identity for hook context — resolved from session config in attempt.ts. */
  agentId?: string;
  /**
   * Exact raw names of non-plugin OpenClaw tools registered for this run.
   * When provided, MEDIA: passthrough requires an exact match instead of only
   * a normalized-name collision with a trusted built-in.
   */
  builtinToolNames?: ReadonlySet<string>;
  internalEvents?: AgentInternalEvent[];
};
