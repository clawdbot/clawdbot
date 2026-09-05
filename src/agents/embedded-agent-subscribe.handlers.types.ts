/**
 * Shared state and context contracts for embedded-agent subscription handlers.
 * Message, tool, compaction, and liveness handlers all mutate this single
 * state shape while keeping their implementation files decoupled.
 */
import type { InlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
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
import type {
  createAssistantVisibleStreamText,
  ThinkingTagStreamState,
} from "./embedded-agent-utils.js";
import type { McpConnectAction } from "./mcp-connect-action.js";
import type { McpAppChannelView } from "./mcp-ui-resource.js";
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
  commandBearing: boolean;
  instanceReplaySafe: boolean;
  replaySafe: boolean;
  mutatingAction: boolean;
  ownerKey?: string;
};

/** User-visible assistant stream payload emitted to subscribers. */
export type AssistantStreamData = {
  text: string;
  delta: string;
  replace?: true;
  mediaUrls?: string[];
  managedMediaUrls?: string[];
  phase?: AssistantPhase;
  itemId?: string;
};

/** Incremental tag and Markdown parsing state, owned by one stream lane. */
export type StreamBlockState = {
  thinking: boolean;
  final: boolean;
  /** The reply buffer already contains the phase-aware visible projection. */
  textIsVisible?: true;
  inlineCode?: InlineCodeState;
  fence?: FenceScanState;
  reasoningInlineCode?: InlineCodeState;
  reasoningFence?: FenceScanState;
  reasoningPendingFenceFragment?: string;
  finalInlineCode?: InlineCodeState;
  finalFence?: FenceScanState;
  pendingFenceFragment?: string;
  pendingTagFragment?: string;
};

/** Mutable subscription state shared by embedded-agent event handlers. */
export type EmbeddedAgentSubscribeState = {
  assistantTexts: string[];
  toolMetas: Array<{
    toolName?: string;
    toolCallId?: string;
    meta?: string;
    replaySafe?: boolean;
    isError?: boolean;
    terminate?: boolean;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
    codeModeSuspended?: boolean;
  }>;
  acceptedSessionSpawns: AcceptedSessionSpawn[];
  toolMetaById: Map<string, ToolCallSummary>;
  toolSummaryById: Set<string>;
  execLiveUpdateStateById?: Map<string, { lastEmittedAtMs: number }>;
  liveEditDiffStateById: Map<
    string,
    {
      added: number;
      removed: number;
      emittedAdded: number;
      emittedRemoved: number;
      lastCheckedAtMs: number;
    }
  >;
  itemActiveIds: Set<string>;
  itemStartedCount: number;
  itemCompletedCount: number;
  /**
   * Completed assistant round trips in this attempt. Survives compaction-retry
   * presentation resets, matching how usage totals keep counting model calls.
   */
  assistantTurnCount: number;
  lastToolError?: ToolErrorSummary;
  latestMcpAppChannelView?: McpAppChannelView;
  latestMcpConnectAction?: McpConnectAction;

  blockReplyBreak: "text_end" | "message_end";
  reasoningMode: ReasoningLevel;
  includeReasoning: boolean;
  shouldEmitPartialReplies: boolean;
  streamReasoning: boolean;

  deltaBuffer: string;
  /** Raw text received for the current native block, independent of snapshot separators. */
  streamBlockText: string;
  /** Start of this native block in the reply chunker's source, before Markdown rewriting. */
  streamBlockOffset: number;
  /** Scanner state shares deltaBuffer's lifecycle so each provider byte is parsed once. */
  thinkingTagStream: ThinkingTagStreamState;
  /**
   * True while the buffered stream text belongs to an explicit commentary
   * item (e.g. the Responses API "commentary" phase). Commentary is routed to
   * a separate lane by the normal stream path, so the run-budget timeout
   * flush must skip it too: flushing the raw deltaBuffer without this marker
   * would publish reasoning/commentary bytes as assistant text.
   */
  deltaBufferIsCommentary: boolean;
  /** Whether timeout settlement committed visible text for this message. */
  hasFlushedPartialText: boolean;
  blockState: StreamBlockState & { inlineCode: InlineCodeState };
  partialBlockState: StreamBlockState & { inlineCode: InlineCodeState };
  assistantStream?: {
    raw: string;
    text: string;
    projection?: {
      kind: "raw" | "delivery" | "final";
      projector: ReturnType<typeof createAssistantVisibleStreamText>;
    };
  };
  lastStreamedReasoning?: string;
  lastBlockReplyText?: string;
  lastDeliveredBlockReplyText?: string;
  deferBlockReplyDelivery: boolean;
  deferredBlockReplies: BlockReplyPayload[];
  toolExecutionSinceLastBlockReply: boolean;
  reasoningStreamOpen: boolean;
  assistantMessageIndex: number;
  /** Physical message boundary; assistantMessageIndex also advances between content blocks. */
  assistantMessageStartIndex: number;
  lastAssistantStreamContentIndex?: number;
  lastAssistantStreamItemId?: string;
  lastAssistantTextMessageIndex: number;
  lastAssistantTextContentIndex?: number;
  lastAssistantTextItemId?: string;
  lastAssistantTextNormalized?: string;
  lastAssistantTextTrimmed?: string;
  assistantTextBaseline: number;
  suppressBlockChunks: boolean;
  lastReasoningSent?: string;

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
  currentSourceMessagingToolSentTextsNormalized: string[];
  currentSourceMessagingToolHeldPartial?: string;
  messagingToolSentTargets: MessagingToolSend[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  messagingToolSentMediaUrls: string[];
  messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
  messageToolOnlySourceReplyDelivered: boolean;
  sourceReplyDelivered?: true;
  pendingMessagingTexts: Map<string, string>;
  pendingMessagingTargets: Map<string, MessagingToolSend>;
  successfulCronAdds: number;
  pendingMessagingMediaUrls: Map<string, string[]>;
  pendingToolMediaUrls: string[];
  pendingToolMediaAttachments?: ReplyMediaAttachment[];
  /** Per-URL local-media trust; keys are normalized pending media URLs. */
  pendingToolMediaTrustByUrl: Map<string, boolean>;
  /** Exact media URLs whose owning built-in tool contract requires source delivery. */
  toolAutoDeliveryMediaUrls: Set<string>;
  pendingToolAudioAsVoice: boolean;
  pendingToolMediaDeliveryFailed: boolean;
  hasToolMediaBlockReply: boolean;
  visibleBlockReplyCount: number;
  /** Media selection belongs to message_end; only voice/reply intent waits for a block. */
  pendingAssistantReplyDirectives?: Pick<
    BlockReplyPayload,
    "audioAsVoice" | "replyToId" | "replyToTag" | "replyToCurrent"
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
  blockChunker: EmbeddedBlockChunker;
  hookRunner?: HookRunner;
  builtinToolNames?: ReadonlySet<string>;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
  noteLastAssistant: (msg: AgentMessage) => void;

  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (
    toolName: string | undefined,
    meta: string | undefined,
    commandBearing: boolean,
  ) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  stripBlockTags: (text: string, state: StreamBlockState, options?: { final?: boolean }) => string;
  emitBlockChunk: (
    text: string,
    options?: {
      assistantMessageIndex?: number;
      final?: boolean;
      finalReply?: ReplyDirectiveParseResult;
    },
  ) => void;
  flushBlockReplyBuffer: (options?: {
    assistantMessageIndex?: number;
    final?: boolean;
    finalReply?: ReplyDirectiveParseResult;
  }) => void | Promise<void>;
  emitReasoningStream: (text: string) => void;
  consumePartialReplyDirectives: (
    text: string,
    options?: { final?: boolean },
  ) => ReplyDirectiveParseResult | null;
  resetBlockReplyDirectives: () => void;
  resetPartialReplyDirectives: () => void;
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
  captureModelEvent: (evt: AgentSessionEvent) => void;
  incrementCompactionCount: () => void;
  noteCompactionTokensAfter: (value: unknown) => void;
  getUsageTotals: () => NormalizedUsage | undefined;
  getLastAssistantUsage: () => NormalizedUsage | undefined;
  getCompactionCount: () => number;
  getLastCompactionTokensAfter: () => number | undefined;
  emitAssistantStreamData: (
    data: AssistantStreamData,
    options?: { emitPartialReply?: boolean; finalMessage?: boolean },
  ) => void;
  emitBlockReply: (
    payload: BlockReplyPayload,
    options?: { assistantMessageIndex?: number; consumePendingToolMedia?: boolean },
  ) => void;
  flushAssistantStream: () => void;
  flushDeferredBlockReplies: () => void;
  clearAssistantStream: () => void;
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
  | "observeToolTerminal"
  | "onToolResult"
  | "config"
  | "messageChannel"
  | "sessionKey"
  | "currentChannelId"
  | "currentMessagingTarget"
  | "currentAccountId"
  | "currentThreadId"
  | "currentMessageId"
  | "replyToMode"
  | "hasRepliedRef"
  | "sessionId"
  | "agentId"
  | "coreBuiltinToolNames"
  | "replaySafeToolNames"
  | "codeModeExecToolNames"
  | "sideEffectToolOwners"
  | "toolResultFormat"
  | "toolProgressDetail"
  | "sourceReplyDeliveryMode"
  | "onDeliveredMessageToolOnlySourceReply"
>;

type ToolHandlerState = Pick<
  EmbeddedAgentSubscribeState,
  | "toolMetaById"
  | "toolMetas"
  | "acceptedSessionSpawns"
  | "toolSummaryById"
  | "execLiveUpdateStateById"
  | "liveEditDiffStateById"
  | "itemActiveIds"
  | "itemStartedCount"
  | "itemCompletedCount"
  | "lastToolError"
  | "latestMcpAppChannelView"
  | "latestMcpConnectAction"
  | "pendingMessagingTargets"
  | "pendingMessagingTexts"
  | "pendingMessagingMediaUrls"
  | "pendingToolMediaUrls"
  | "pendingToolMediaAttachments"
  | "pendingToolMediaTrustByUrl"
  | "toolAutoDeliveryMediaUrls"
  | "pendingToolAudioAsVoice"
  | "deterministicApprovalPromptPending"
  | "hadDeterministicSideEffect"
  | "replayState"
  | "messagingToolSentTexts"
  | "messagingToolSentTextsNormalized"
  | "currentSourceMessagingToolSentTextsNormalized"
  | "messagingToolSentMediaUrls"
  | "messagingToolSourceReplyPayloads"
  | "messageToolOnlySourceReplyDelivered"
  | "sourceReplyDelivered"
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
  emitToolSummary: (
    toolName: string | undefined,
    meta: string | undefined,
    commandBearing: boolean,
  ) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  trimMessagingToolSent: () => void;
  consumeToolSendReceipt?: (toolCallId: string) => unknown;
};
