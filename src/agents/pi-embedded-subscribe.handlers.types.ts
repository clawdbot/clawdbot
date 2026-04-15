import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
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

export type EmbeddedSubscribeLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type ToolCallSummary = {
  meta?: string;
  mutatingAction: boolean;
  actionFingerprint?: string;
};

export type EmbeddedPiSubscribeState = {
  assistantTexts: string[];
  toolMetas: Array<{ toolName?: string; meta?: string }>;
  toolMetaById: Map<string, ToolCallSummary>;
  toolSummaryById: Set<string>;
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
  blockState: { thinking: boolean; final: boolean; inlineCode: InlineCodeState };
  partialBlockState: { thinking: boolean; final: boolean; inlineCode: InlineCodeState };
  lastStreamedAssistant?: string;
  lastStreamedAssistantCleaned?: string;
  emittedAssistantUpdate: boolean;
  lastStreamedReasoning?: string;
  lastBlockReplyText?: string;
  reasoningStreamOpen: boolean;
  assistantMessageIndex: number;
  lastAssistantStreamItemId?: string;
  lastAssistantTextMessageIndex: number;
  lastAssistantTextNormalized?: string;
  lastAssistantTextTrimmed?: string;
  assistantTextBaseline: number;
  suppressBlockChunks: boolean;
  lastReasoningSent?: string;

  compactionInFlight: boolean;
  pendingCompactionRetry: number;
  compactionRetryResolve?: () => void;
  compactionRetryReject?: (reason?: unknown) => void;
  compactionRetryPromise: Promise<void> | null;
  unsubscribed: boolean;
  replayState: EmbeddedRunReplayState;
  livenessState?: EmbeddedRunLivenessState;
  hadDeterministicSideEffect?: boolean;

  messagingToolSentTexts: string[];
  messagingToolSentTextsNormalized: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSentMediaUrls: string[];
  pendingMessagingTexts: Map<string, string>;
  pendingMessagingTargets: Map<string, MessagingToolSend>;
  successfulCronAdds: number;
  pendingMessagingMediaUrls: Map<string, string[]>;
  pendingToolMediaUrls: string[];
  pendingToolAudioAsVoice: boolean;
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
  noteLastAssistant: (msg: AgentMessage) => void;

  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (toolName?: string, meta?: string) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  stripBlockTags: (
    text: string,
    state: { thinking: boolean; final: boolean; inlineCode?: InlineCodeState },
  ) => string;
  emitBlockChunk: (text: string, options?: { assistantMessageIndex?: number }) => void;
  flushBlockReplyBuffer: (options?: { assistantMessageIndex?: number }) => void | Promise<void>;
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
  incrementCompactionCount: () => void;
  getUsageTotals: () => NormalizedUsage | undefined;
  getCompactionCount: () => number;
  emitBlockReply: (payload: BlockReplyPayload) => void;
};

/**
 * Minimal context type for tool execution handlers. Allows
 * tests provide only the fields they exercise
 * without needing the full `EmbeddedPiSubscribeContext`.
 */
export type ToolHandlerParams = Pick<
  SubscribeEmbeddedPiSessionParams,
  | "runId"
  | "onBlockReplyFlush"
  | "onAgentEvent"
  | "onToolResult"
  | "sessionKey"
  | "sessionId"
  | "agentId"
  | "toolResultFormat"
>;

export type ToolHandlerState = Pick<
  EmbeddedPiSubscribeState,
  | "toolMetaById"
  | "toolMetas"
  | "toolSummaryById"
  | "itemActiveIds"
  | "itemStartedCount"
  | "itemCompletedCount"
  | "lastToolError"
  | "pendingMessagingTargets"
  | "pendingMessagingTexts"
  | "pendingMessagingMediaUrls"
  | "pendingToolMediaUrls"
  | "pendingToolAudioAsVoice"
  | "deterministicApprovalPromptPending"
  | "replayState"
  | "messagingToolSentTexts"
  | "messagingToolSentTextsNormalized"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "successfulCronAdds"
  | "deterministicApprovalPromptSent"
>;

export type ToolHandlerContext = {
  params: ToolHandlerParams;
  state: ToolHandlerState;
  log: EmbeddedSubscribeLogger;
  hookRunner?: HookRunner;
  flushBlockReplyBuffer: () => void | Promise<void>;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (toolName?: string, meta?: string) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string, result?: unknown) => void;
  trimMessagingToolSent: () => void;
};

export type EmbeddedPiSubscribeEvent =
  | AgentEvent
  | { type: string; [k: string]: unknown }
  | { type: "message_start"; message: AgentMessage };
