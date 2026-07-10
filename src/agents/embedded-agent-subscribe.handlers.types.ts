/**
 * Shared state and context contracts for embedded-agent subscription handlers.
 * Message, tool, compaction, and liveness handlers all mutate this single
 * state shape while keeping their implementation files decoupled.
 */
import type { InlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel } from "../auto-reply/thinking.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { AssistantPhase } from "../shared/chat-message-content.js";
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import type { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import type { EmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import type { EmbeddedRunLivenessState } from "./embedded-agent-runner/types.js";
import type {
  BlockReplyChunking,
  SubscribeEmbeddedAgentSessionParams,
} from "./embedded-agent-subscribe.types.js";
import type { AgentRunTimeoutPhase } from "./run-timeout-attribution.js";
import type { AgentMessage } from "./runtime/index.js";
import type { AgentSessionEvent } from "./sessions/index.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";
import type { NormalizedUsage } from "./usage.js";

type EmbeddedSubscribeLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  trace?: (message: string, meta?: Record<string, unknown>) => void;
  isEnabled?: (
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    target?: "any" | "console" | "file",
  ) => boolean;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

/** Per-tool metadata tracked between tool start/update/end events. */
export type ToolCallSummary = {
  meta?: string;
  instanceReplaySafe: boolean;
  replaySafe: boolean;
  mutatingAction: boolean;
  actionFingerprint?: string;
  fileTarget?: import("./tool-mutation.js").FileTarget;
};

/** User-visible assistant stream payload emitted to subscribers. */
type AssistantStreamData = {
  text: string;
  delta: string;
  replace?: true;
  mediaUrls?: string[];
  phase?: AssistantPhase;
};

/** Deferred assistant stream event plus whether it should emit partial replies. */
type AssistantStreamDelivery = {
  data: AssistantStreamData;
  emitPartialReply: boolean;
};

/** Mutable subscription state shared by embedded-agent event handlers. */
export type EmbeddedAgentSubscribeState = {
  assistantTexts: string[];
  toolMetas: Array<{
    toolName?: string;
    meta?: string;
    replaySafe?: boolean;
    isError?: true;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
  acceptedSessionSpawns: AcceptedSessionSpawn[];
  toolMetaById: Map<string, ToolCallSummary>;
  toolSummaryById: Set<string>;
  execLiveUpdateStateById?: Map<string, { lastEmittedAtMs: number }>;
  itemActiveIds: Set<string>;
  itemStartedCount: number;
  itemCompletedCount: number;
  lastToolError?: ToolErrorSummary;

  blockReplyBreak: "text_end" | "message_end";
  reasoningMode: ReasoningLevel;
  includeReasoning: boolean;
  shouldEmitPartialReplies: boolean;
  streamReasoning: boolean;

  deltaBuffer: string;
  blockBuffer: string;
  blockState: {
    thinking: boolean;
    final: boolean;
    inlineCode: InlineCodeState;
    fence?: FenceScanState;
    reasoningInlineCode?: InlineCodeState;
    reasoningFence?: FenceScanState;
    reasoningPendingFenceFragment?: string;
    finalInlineCode?: InlineCodeState;
    finalFence?: FenceScanState;
    pendingFenceFragment?: string;
    pendingTagFragment?: string;
  };
  partialBlockState: {
    thinking: boolean;
    final: boolean;
    inlineCode: InlineCodeState;
    fence?: FenceScanState;
    reasoningInlineCode?: InlineCodeState;
    reasoningFence?: FenceScanState;
    reasoningPendingFenceFragment?: string;
    finalInlineCode?: InlineCodeState;
    finalFence?: FenceScanState;
    pendingFenceFragment?: string;
    pendingTagFragment?: string;
  };
  lastStreamedAssistant?: string;
  lastStreamedAssistantCleaned?: string;
  emittedAssistantUpdate: boolean;
  lastStreamedReasoning?: string;
  lastBlockReplyText?: string;
  lastDeliveredBlockReplyText?: string;
  deferBlockReplyDelivery: boolean;
  deferredBlockReplies: BlockReplyPayload[];
  deferredAssistantEvents: AssistantStreamDelivery[];
  toolExecutionSinceLastBlockReply: boolean;
  reasoningStreamOpen: boolean;
  assistantMessageIndex: number;
  lastAssistantStreamContentIndex?: number;
  lastAssistantStreamItemId?: string;
  lastAssistantTextMessageIndex: number;
  lastAssistantTextNormalized?: string;
  lastAssistantTextTrimmed?: string;
  assistantTextBaseline: number;
  suppressBlockChunks: boolean;
  lastReasoningSent?: string;
  pendingAssistantUsage?: NormalizedUsage;
  assistantUsageCommitted: boolean;

  compactionInFlight: boolean;
  lastCompactionTokensAfter?: number;
  pendingCompactionRetry: number;
  compactionRetryResolve?: () => void;
  compactionRetryReject?: (reason?: unknown) => void;
  compactionRetryPromise: Promise<void> | null;
  unsubscribed: boolean;
  replayState: EmbeddedRunReplayState;
  livenessState?: EmbeddedRunLivenessState;
  terminalStopReason?: string;
  yielded?: boolean;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  terminalAborted?: boolean;
  hadDeterministicSideEffect?: boolean;
  pendingEventChain: Promise<void> | null;

  messagingToolSentTexts: string[];
  messagingToolSentTextsNormalized: string[];
  messagingToolSentTargets: MessagingToolSend[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  messagingToolSentMediaUrls: string[];
  messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
  messageToolOnlySourceReplyDelivered: boolean;
  pendingMessagingTexts: Map<string, string>;
  pendingMessagingTargets: Map<string, MessagingToolSend>;
  successfulCronAdds: number;
  pendingMessagingMediaUrls: Map<string, string[]>;
  pendingToolMediaUrls: string[];
  pendingToolAudioAsVoice: boolean;
  pendingToolTrustedLocalMedia: boolean;
  hasToolMediaBlockReply: boolean;
  visibleBlockReplyCount: number;
  pendingAssistantReplyDirectives?: Pick<
    BlockReplyPayload,
    "mediaUrls" | "audioAsVoice" | "replyToId" | "replyToTag" | "replyToCurrent"
  >;
  deterministicApprovalPromptPending: boolean;
  deterministicApprovalPromptSent: boolean;
  lastAssistant?: AgentMessage;
};

/** Handler context bundling params, mutable state, emitters, and helper hooks. */
export type EmbeddedAgentSubscribeContext = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeState;
  log: EmbeddedSubscribeLogger;
  blockChunking?: BlockReplyChunking;
  blockChunker: EmbeddedBlockChunker | null;
  hookRunner?: HookRunner;
  builtinToolNames?: ReadonlySet<string>;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
  noteLastAssistant: (msg: AgentMessage) => void;

  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (toolName?: string, meta?: string) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  stripBlockTags: (
    text: string,
    state: {
      thinking: boolean;
      final: boolean;
      inlineCode?: InlineCodeState;
      fence?: FenceScanState;
      reasoningInlineCode?: InlineCodeState;
      reasoningFence?: FenceScanState;
      reasoningPendingFenceFragment?: string;
      finalInlineCode?: InlineCodeState;
      finalFence?: FenceScanState;
      pendingFenceFragment?: string;
      pendingTagFragment?: string;
    },
    options?: { final?: boolean },
  ) => string;
  emitBlockChunk: (
    text: string,
    options?: { assistantMessageIndex?: number; final?: boolean },
  ) => void;
  flushBlockReplyBuffer: (options?: {
    assistantMessageIndex?: number;
    final?: boolean;
  }) => void | Promise<void>;
  emitReasoningStream: (text: string) => void;
  consumeReplyDirectives: (
    text: string,
    options?: { final?: boolean },
  ) => ReplyDirectiveParseResult | null;
  consumePartialReplyDirectives: (
    text: string,
    options?: { final?: boolean },
  ) => ReplyDirectiveParseResult | null;
  resetAssistantMessageState: (nextAssistantTextBaseline: number) => void;
  resetForCompactionRetry: () => void;
  finalizeAssistantTexts: (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
  }) => void;
  trimMessagingToolSent: () => void;
  consumeToolSendReceipt: (toolCallId: string) => unknown;
  ensureCompactionPromise: () => void;
  noteCompactionRetry: () => void;
  resolveCompactionRetry: () => void;
  maybeResolveCompactionWait: () => void;
  recordAssistantUsage: (usage: unknown) => void;
  commitAssistantUsage: () => void;
  incrementCompactionCount: () => void;
  noteCompactionTokensAfter: (value: unknown) => void;
  getUsageTotals: () => NormalizedUsage | undefined;
  getCompactionCount: () => number;
  getLastCompactionTokensAfter: () => number | undefined;
  emitAssistantStreamData: (
    data: AssistantStreamData,
    options?: { emitPartialReply?: boolean },
  ) => void;
  emitBlockReply: (
    payload: BlockReplyPayload,
    options?: { assistantMessageIndex?: number; consumePendingToolMedia?: boolean },
  ) => void;
  flushDeferredAssistantEvents: () => void;
  flushDeferredBlockReplies: () => void;
  clearDeferredAssistantEvents: () => void;
  clearDeferredBlockReplies: () => void;
};

/**
 * Minimal context type for tool execution handlers. Allows
 * tests provide only the fields they exercise
 * without needing the full `EmbeddedAgentSubscribeContext`.
 */
type ToolHandlerParams = Pick<
  SubscribeEmbeddedAgentSessionParams,
  | "runId"
  | "onBlockReplyFlush"
  | "onAgentEvent"
  | "onToolStreamBoundary"
  | "onExecutionPhase"
  | "onHeartbeatToolResponse"
  | "onAgentToolResult"
  | "onToolResult"
  | "config"
  | "messageChannel"
  | "sessionKey"
  | "currentChannelId"
  | "currentMessagingTarget"
  | "currentThreadId"
  | "currentMessageId"
  | "replyToMode"
  | "hasRepliedRef"
  | "sessionId"
  | "agentId"
  | "replaySafeToolNames"
  | "toolResultFormat"
  | "toolProgressDetail"
  | "sourceReplyDeliveryMode"
>;

type ToolHandlerState = Pick<
  EmbeddedAgentSubscribeState,
  | "toolMetaById"
  | "toolMetas"
  | "acceptedSessionSpawns"
  | "toolSummaryById"
  | "execLiveUpdateStateById"
  | "itemActiveIds"
  | "itemStartedCount"
  | "itemCompletedCount"
  | "lastToolError"
  | "pendingMessagingTargets"
  | "pendingMessagingTexts"
  | "pendingMessagingMediaUrls"
  | "pendingToolMediaUrls"
  | "pendingToolAudioAsVoice"
  | "pendingToolTrustedLocalMedia"
  | "deterministicApprovalPromptPending"
  | "hadDeterministicSideEffect"
  | "replayState"
  | "messagingToolSentTexts"
  | "messagingToolSentTextsNormalized"
  | "messagingToolSentMediaUrls"
  | "messagingToolSourceReplyPayloads"
  | "messageToolOnlySourceReplyDelivered"
  | "messagingToolSentTargets"
  | "heartbeatToolResponse"
  | "successfulCronAdds"
  | "deterministicApprovalPromptSent"
  | "toolExecutionSinceLastBlockReply"
  | "assistantMessageIndex"
>;

export type ToolHandlerContext = {
  params: ToolHandlerParams;
  state: ToolHandlerState;
  log: EmbeddedSubscribeLogger;
  hookRunner?: HookRunner;
  builtinToolNames?: ReadonlySet<string>;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
  flushBlockReplyBuffer: () => void | Promise<void>;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (toolName?: string, meta?: string) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  trimMessagingToolSent: () => void;
  consumeToolSendReceipt?: (toolCallId: string) => unknown;
};

export type EmbeddedAgentSubscribeEvent =
  | AgentSessionEvent
  | { type: string; [k: string]: unknown }
  | { type: "message_start"; message: AgentMessage };
