/**
 * Public parameter types for subscribing to embedded-agent sessions.
 */
import type {
  BlockReplyContext,
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
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import type { BlockReplyFlushContext } from "./embedded-agent-runner/types.js";
import type {
  BlockReplyChunking,
  ToolProgressDetailMode,
  ToolResultFormat,
} from "./embedded-agent-subscribe.shared-types.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type { AgentMessage } from "./runtime/index.js";
import type { AgentSession } from "./sessions/index.js";
export type { BlockReplyChunking } from "./embedded-agent-subscribe.shared-types.js";

type ReasoningStreamPayload = Pick<
  ReplyPayload,
  "text" | "mediaUrls" | "isReasoning" | "isReasoningSnapshot"
> & {
  requiresReasoningProgressOptIn?: boolean;
};

export type SubscribeEmbeddedAgentSessionParams = {
  session: AgentSession;
  runId: string;
  /** Immutable gateway lifecycle ownership for this execution. */
  lifecycleGeneration?: string;
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
  /** Attempt-owned delivery proof for message-tool-only source replies. */
  hasDeliveredMessageToolOnlySourceReply?: () => boolean;
  /** Reports source delivery observed through bridged tool lifecycle events. */
  onDeliveredMessageToolOnlySourceReply?: () => void;
  onToolResult?: (payload: ReplyPayload) => void | Promise<void>;
  onAgentToolResult?: (event: { toolName: string; result: unknown; isError: boolean }) => void;
  observeToolTerminal?: EmbeddedRunAttemptParams["observeToolTerminal"];
  onReasoningStream?: (payload: ReasoningStreamPayload) => void | Promise<void>;
  /** Expands window reasoning beyond "stream" mode for callers with their own display gate. */
  streamReasoningInNonStreamModes?: boolean;
  /** Called when a thinking/reasoning block ends (</think> tag processed). */
  onReasoningEnd?: () => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload, context?: BlockReplyContext) => void | Promise<void>;
  /** Flush pending block replies and identify the boundary that requested it. */
  onBlockReplyFlush?: (context: BlockReplyFlushContext) => void | Promise<void>;
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
  onToolStreamBoundary?: () => void | Promise<void>;
  onHeartbeatToolResponse?: (response: HeartbeatToolResponse) => void | Promise<void>;
  /** "finishing" defers both success and error terminal ownership to the caller. */
  terminalLifecyclePhase?: "end" | "finishing";
  /** Read immediately before terminal lifecycle emission. */
  isTerminalAborted?: () => boolean | undefined;
  /** Override the terminal stop reason from the current abort owner. */
  resolveTerminalStopReason?: () => string | undefined;
  /** Gate final block delivery/lifecycle after the natural answer is known. */
  onBeforeTerminalDelivery?: (event: {
    messages: AgentMessage[];
    willRetry: boolean;
    lastAssistant?: AgentMessage;
    assistantTexts: readonly string[];
    hasAssistantVisibleText: boolean;
    isError: boolean;
    incompleteTerminalAssistant: boolean;
    hadDeterministicSideEffect: boolean;
  }) => void | Promise<void | { suppressTerminalDelivery?: boolean }>;
  /** Best-effort hook invoked immediately before the terminal lifecycle event is emitted. */
  onBeforeLifecycleTerminal?: () => void | Promise<void>;
  enforceFinalTag?: boolean;
  silentExpected?: boolean;
  /**
   * Skip per-chunk live visible-text parsing in handleMessageUpdate. Set for runs
   * with no live stream consumer — notably subagents, whose result is read back
   * from the final message_end path. Suppressing intermediate passes does not
   * change final output.
   */
  suppressLiveStreamOutput?: boolean;
  config?: OpenClawConfig;
  sessionKey?: string;
  /** Current transport channel resolved for this run. */
  currentChannelId?: string;
  /** Routable target for the current conversation when it differs from the native channel ID. */
  currentMessagingTarget?: string;
  /** Current transport thread resolved for this run. */
  currentThreadId?: string;
  /** Current inbound message id used to distinguish child replies from explicit roots. */
  currentMessageId?: string | number;
  /** Reply mode used by transport auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Shared one-shot reply state used by first/batched modes. */
  hasRepliedRef?: { value: boolean };
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  /** Agent identity for hook context — resolved from session config in attempt.ts. */
  agentId?: string;
  /**
   * Exact raw names of OpenClaw tools registered for this run.
   */
  builtinToolNames?: ReadonlySet<string>;
  /** Exact registered tool names whose concrete instances are safe to replay. */
  replaySafeToolNames?: ReadonlySet<string>;
  /**
   * Exact raw names allowed to emit local media paths for this run.
   * Includes core trusted tools plus bundled plugin tools proven from the
   * startup metadata snapshot.
   */
  trustedLocalMediaToolNames?: ReadonlySet<string>;
  internalEvents?: AgentInternalEvent[];
};
