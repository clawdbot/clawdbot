import type {
  PartialReplyPayload,
  SourceReplyDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import type { EmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import type {
  BlockReplyChunking,
  ToolProgressDetailMode,
  ToolResultFormat,
} from "./embedded-agent-subscribe.shared-types.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type { AgentSession } from "./sessions/index.js";
export type {
  BlockReplyChunking,
  ToolProgressDetailMode,
  ToolResultFormat,
} from "./embedded-agent-subscribe.shared-types.js";

export type SubscribeEmbeddedAgentSessionParams = {
  session: AgentSession;
  runId: string;
  /** Originating message channel used for subsystem log attribution. */
  messageChannel?: string;
  initialReplayState?: EmbeddedRunReplayState;
  hookRunner?: HookRunner;
  verboseLevel?: VerboseLevel;
  reasoningMode?: ReasoningLevel;
  thinkingLevel?: ThinkLevel;
  toolResultFormat?: ToolResultFormat;
  toolProgressDetail?: ToolProgressDetailMode;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
    isReasoningSnapshot?: boolean;
  }) => void | Promise<void>;
  /** Called when a thinking/reasoning block ends (</think> tag processed). */
  onReasoningEnd?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  /** Flush pending block replies (e.g., before tool execution to preserve message boundaries). */
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onPartialReply?: (payload: PartialReplyPayload) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onExecutionPhase?: (info: {
    phase: "tool_execution_started";
    tool?: string;
    toolCallId?: string;
    source?: string;
  }) => void;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }) => void | Promise<void>;
  onHeartbeatToolResponse?: (response: HeartbeatToolResponse) => void | Promise<void>;
  terminalLifecyclePhase?: "end" | "finishing";
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
   * Exact raw names of OpenClaw tools registered for this run.
   */
  builtinToolNames?: ReadonlySet<string>;
  /**
   * Exact raw names allowed to emit local MEDIA: paths for this run.
   * Includes core trusted tools plus bundled plugin tools proven from the
   * startup metadata snapshot.
   */
  trustedLocalMediaToolNames?: ReadonlySet<string>;
  internalEvents?: AgentInternalEvent[];
};
