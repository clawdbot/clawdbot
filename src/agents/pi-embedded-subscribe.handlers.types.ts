import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HeartbeatToolResponse } from "../auto-reply/heartbeat-tool-response.js";
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel } from "../auto-reply/thinking.js";
import type { InlineCodeState } from "../markdown/code-spans.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import type { MessagingToolSend } from "./pi-embedded-messaging.types.js";
import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import type { EmbeddedRunReplayState } from "./pi-embedded-runner/replay-state.js";
import type { EmbeddedRunLivenessState } from "./pi-embedded-runner/types.js";
import type {
  BlockReplyChunking,
  SubscribeEmbeddedPiSessionParams,
} from "./pi-embedded-subscribe.types.js";
import type { ToolErrorSummary } from "./tool-error-summary.js";
import type { NormalizedUsage } from "./usage.js";

type EmbeddedSubscribeLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type ToolCallSummary = {
  meta?: string;
  mutatingAction: boolean;
  actionFingerprint?: string;
  fileTarget?: import("./tool-mutation.js").FileTarget;
};

export type EmbeddedPiSubscribeState = {
  assistantTexts: string[];
  toolMetas: Array<{ toolName?: string; meta?: string }>;
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
    pendingTagFragment?: string;
  };
  partialBlockState: {
    thinking: boolean;
    final: boolean;
    inlineCode: InlineCodeState;
    pendingTagFragment?: string;
  };
  lastStreamedAssistant?: string;
  lastStreamedAssistantCleaned?: string;
  emittedAssistantUpdate: boolean;
  lastStreamedReasoning?: string;
  lastBlockReplyText?: string;
  lastDeliveredBlockReplyText?: string;
  toolExecutionSinceLastBlockReply: boolean;
  reasoningStreamOpen: boolean;
  assistantMessageIndex: number;
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
  hadDeterministicSideEffect?: boolean;

  messagingToolSentTexts: string[];
  messagingToolSentTextsNormalized: string[];
  messagingToolSentTargets: MessagingToolSend[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  messagingToolSentMediaUrls: string[];
  pendingMessagingTexts: Map<string, string>;
  pendingMessagingTargets: Map<string, MessagingToolSend>;
  successfulCronAdds: number;
  pendingMessagingMediaUrls: Map<string, string[]>;
  pendingToolMediaUrls: string[];
  pendingToolAudioAsVoice: boolean;
  pendingToolTrustedLocalMedia: boolean;
  visibleBlockReplyCount: number;
  pendingAssistantReplyDirectives?: Pick<
    BlockReplyPayload,
    "mediaUrls" | "audioAsVoice" | "replyToId" | "replyToTag" | "replyToCurrent"
  >;
  deterministicApprovalPromptPending: boolean;
  deterministicApprovalPromptSent: boolean;
  lastAssistant?: AgentMessage;
};

export type EmbeddedPiSubscribeContext = {
  params: SubscribeEmbeddedPiSessionParams;
  state: EmbeddedPiSubscribeState;
  log: EmbeddedSubscribeLogger;
  blockChunking?: BlockReplyChunking;
  blockChunker: EmbeddedBlockChunker | null;
  hookRunner?: HookRunner;
  builtinToolNames?: ReadonlySet<string>;
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
  emitBlockReply: (payload: BlockReplyPayload) => void;
};

/**
 * Minimal context type for tool execution handlers. Allows
 * tests provide only the fields they exercise
 * without needing the full `EmbeddedPiSubscribeContext`.
 */
type ToolHandlerParams = Pick<
  SubscribeEmbeddedPiSessionParams,
  | "runId"
  | "onBlockReplyFlush"
  | "onAgentEvent"
  | "onExecutionPhase"
  | "onToolResult"
  | "sessionKey"
  | "sessionId"
  | "agentId"
  | "toolResultFormat"
  | "toolProgressDetail"
>;

type ToolHandlerState = Pick<
  EmbeddedPiSubscribeState,
  | "toolMetaById"
  | "toolMetas"
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
  | "replayState"
  | "messagingToolSentTexts"
  | "messagingToolSentTextsNormalized"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "heartbeatToolResponse"
  | "successfulCronAdds"
  | "deterministicApprovalPromptSent"
  | "toolExecutionSinceLastBlockReply"
>;

export type ToolHandlerContext = {
  params: ToolHandlerParams;
  state: ToolHandlerState;
  log: EmbeddedSubscribeLogger;
  hookRunner?: HookRunner;
  builtinToolNames?: ReadonlySet<string>;
  flushBlockReplyBuffer: () => void | Promise<void>;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (toolName?: string, meta?: string) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  trimMessagingToolSent: () => void;
};

export type EmbeddedPiSubscribeEvent =
  | AgentSessionEvent
  | { type: string; [k: string]: unknown }
  | { type: "message_start"; message: AgentMessage };
