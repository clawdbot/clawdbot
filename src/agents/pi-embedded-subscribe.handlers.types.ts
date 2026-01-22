import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import type { ReasoningLevel } from "../auto-reply/thinking.js";
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { InlineCodeState } from "../markdown/code-spans.js";
import type { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import type { MessagingToolSend } from "./pi-embedded-messaging.js";
import type {
  BlockReplyChunking,
  SubscribeEmbeddedPiSessionParams,
} from "./pi-embedded-subscribe.types.js";

export type EmbeddedSubscribeLogger = {
  debug: (message: string) => void;
  warn: (message: string) => void;
};

export type ToolErrorSummary = {
  toolName: string;
  meta?: string;
  error?: string;
};

export type EmbeddedPiSubscribeState = {
  assistantTexts: string[];
  toolMetas: Array<{ toolName?: string; meta?: string }>;
  toolMetaById: Map<string, string | undefined>;
  toolSummaryById: Set<string>;
  lastToolError?: ToolErrorSummary;

  blockReplyBreak: "text_end" | "message_end";
  reasoningMode: ReasoningLevel;
  includeReasoning: boolean;
  shouldEmitPartialReplies: boolean;
  streamReasoning: boolean;

  deltaBuffer: string;
  blockBuffer: string;
  blockState: { thinking: boolean; final: boolean; inlineCode: InlineCodeState };
  lastStreamedAssistant?: string;
  lastStreamedReasoning?: string;
  lastBlockReplyText?: string;
  assistantMessageIndex: number;
  lastAssistantTextMessageIndex: number;
  lastAssistantTextNormalized?: string;
  lastAssistantTextTrimmed?: string;
  assistantTextBaseline: number;
  suppressBlockChunks: boolean;
  lastReasoningSent?: string;

  compactionInFlight: boolean;
  pendingCompactionRetry: number;
  compactionRetryResolve?: () => void;
  compactionRetryPromise: Promise<void> | null;

  messagingToolSentTexts: string[];
  messagingToolSentTextsNormalized: string[];
  messagingToolSentTargets: MessagingToolSend[];
  pendingMessagingTexts: Map<string, string>;
  pendingMessagingTargets: Map<string, MessagingToolSend>;
};

export type EmbeddedPiSubscribeContext = {
  params: SubscribeEmbeddedPiSessionParams;
  state: EmbeddedPiSubscribeState;
  log: EmbeddedSubscribeLogger;
  blockChunking?: BlockReplyChunking;
  blockChunker: EmbeddedBlockChunker | null;

  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  emitToolSummary: (toolName?: string, meta?: string) => void;
  emitToolOutput: (toolName?: string, meta?: string, output?: string) => void;
  stripBlockTags: (
    text: string,
    state: { thinking: boolean; final: boolean; inlineCode?: InlineCodeState },
  ) => string;
  emitBlockChunk: (text: string) => void;
  flushBlockReplyBuffer: () => void;
  emitReasoningStream: (text: string) => void;
  consumeReplyDirectives: (
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
};

export type EmbeddedPiSubscribeEvent =
  | AgentEvent
  | { type: string; [k: string]: unknown }
  | { type: "message_start"; message: AgentMessage };
