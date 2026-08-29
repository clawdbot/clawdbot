import { vi } from "vitest";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { handleMessageEnd } from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { handleMessageUpdate } from "./embedded-agent-subscribe.handlers.messages.update.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { createThinkingTagStreamState } from "./embedded-agent-utils.js";

export function updateMessage(
  context: EmbeddedAgentSubscribeContext,
  event: { message: unknown; assistantMessageEvent?: unknown },
): void {
  // Stream fixtures intentionally include incomplete and malformed provider payloads.
  void handleMessageUpdate(context, {
    type: "message_update",
    ...event,
  } as Parameters<typeof handleMessageUpdate>[1]);
}

export function endMessage(context: EmbeddedAgentSubscribeContext, event: { message: unknown }) {
  // Message-end coverage includes malformed content and partial provider usage.
  return handleMessageEnd(context, {
    type: "message_end",
    ...event,
  } as Parameters<typeof handleMessageEnd>[1]);
}

export function createMessageUpdateContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onPartialReply?: ReturnType<typeof vi.fn>;
    flushBlockReplyBuffer?: ReturnType<typeof vi.fn>;
    resetAssistantMessageState?: ReturnType<typeof vi.fn>;
    debug?: ReturnType<typeof vi.fn>;
    shouldEmitPartialReplies?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    consumePartialReplyDirectives?: ReturnType<typeof vi.fn>;
    stripBlockTags?: ReturnType<typeof vi.fn>;
    emitReasoningStream?: ReturnType<typeof vi.fn>;
    state?: Record<string, unknown>;
  } = {},
) {
  // Update context fixture wires the partial-reply path through the same
  // directive accumulator used by streaming runtime events.
  const partialReplyDirectiveAccumulator = createStreamingDirectiveAccumulator();
  const onAgentEvent = params.onAgentEvent as ((event: unknown) => void) | undefined;
  const onPartialReply = params.onPartialReply as ((event: unknown) => void) | undefined;
  return {
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: params.sourceReplyDeliveryMode }
        : {}),
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
    },
    state: {
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      currentSourceMessagingToolSentTextsNormalized: [],
      currentSourceMessagingToolHeldPartial: undefined,
      reasoningStreamOpen: false,
      streamReasoning: false,
      deltaBuffer: "",
      thinkingTagStream: createThinkingTagStreamState(),
      blockBuffer: "",
      partialBlockState: {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      lastStreamedCommentary: undefined,
      commentaryStreamedWithDelta: false,
      assistantDisplayPhasePending: false,
      emittedAssistantUpdate: false,
      shouldEmitPartialReplies: params.shouldEmitPartialReplies ?? true,
      blockReplyBreak: "text_end",
      assistantMessageIndex: 0,
      lastAssistantStreamItemId: undefined,
      assistantTexts: [],
      pendingAssistantReplyDirectives: undefined,
      pendingToolMediaTrustByUrl: new Map(),
      ...params.state,
    },
    log: { debug: params.debug ?? vi.fn() },
    noteLastAssistant: vi.fn(),
    noteCompletedAssistant: vi.fn(),
    stripBlockTags: params.stripBlockTags ?? vi.fn((text: string) => text),
    consumePartialReplyDirectives:
      params.consumePartialReplyDirectives ??
      vi.fn((text: string, options?: { final?: boolean }) =>
        partialReplyDirectiveAccumulator.consume(text, options),
      ),
    emitReasoningStream: params.emitReasoningStream ?? vi.fn(),
    flushBlockReplyBuffer: params.flushBlockReplyBuffer ?? vi.fn(),
    resetAssistantMessageState: params.resetAssistantMessageState ?? vi.fn(),
    recordAssistantUsage: vi.fn(),
    commitAssistantUsage: vi.fn(),
    emitAssistantStreamData: vi.fn(
      (
        data: Parameters<EmbeddedAgentSubscribeContext["emitAssistantStreamData"]>[0],
        options?: { emitPartialReply?: boolean },
      ) => {
        onAgentEvent?.({ stream: "assistant", data });
        if (options?.emitPartialReply === true && (params.shouldEmitPartialReplies ?? true)) {
          onPartialReply?.(data);
        }
      },
    ),
  } as unknown as EmbeddedAgentSubscribeContext;
}

export function createMessageEndContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onBlockReply?: ReturnType<typeof vi.fn>;
    emitBlockReply?: ReturnType<typeof vi.fn>;
    finalizeAssistantTexts?: ReturnType<typeof vi.fn>;
    flushBlockReplyBuffer?: ReturnType<typeof vi.fn>;
    consumeReplyDirectives?: ReturnType<typeof vi.fn>;
    stripBlockTags?: ReturnType<typeof vi.fn>;
    warn?: ReturnType<typeof vi.fn>;
    builtinToolNames?: ReadonlySet<string>;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    enforceFinalTag?: boolean;
    blockChunker?: { hasBuffered: () => boolean; reset: () => void };
    state?: Record<string, unknown>;
  } = {},
) {
  // Message-end context starts with buffered assistant text so tests can assert
  // final flushing, directive consumption, and source-reply behavior.
  const onAgentEvent = params.onAgentEvent as ((event: unknown) => void) | undefined;
  return {
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: params.sourceReplyDeliveryMode }
        : {}),
      ...(params.enforceFinalTag !== undefined ? { enforceFinalTag: params.enforceFinalTag } : {}),
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onBlockReply ? { onBlockReply: params.onBlockReply } : { onBlockReply: vi.fn() }),
    },
    state: {
      assistantTexts: [],
      assistantTextBaseline: 0,
      deliveredBlockReplyTexts: [],
      deferredBlockReplyTexts: [],
      emittedAssistantUpdate: false,
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      currentSourceMessagingToolSentTextsNormalized: [],
      currentSourceMessagingToolHeldPartial: undefined,
      includeReasoning: false,
      streamReasoning: false,
      blockReplyBreak: "message_end",
      deltaBuffer: "Need send.",
      blockBuffer: "Need send.",
      blockState: {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      },
      partialBlockState: {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      lastReasoningSent: undefined,
      reasoningStreamOpen: false,
      pendingToolMediaTrustByUrl: new Map(),
      ...params.state,
    },
    noteLastAssistant: vi.fn(),
    noteCompletedAssistant: vi.fn(),
    recordAssistantUsage: vi.fn(),
    commitAssistantUsage: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: params.warn ?? vi.fn() },
    builtinToolNames: params.builtinToolNames,
    stripBlockTags: params.stripBlockTags ?? vi.fn((text: string) => text),
    finalizeAssistantTexts: params.finalizeAssistantTexts ?? vi.fn(),
    emitAssistantStreamData: vi.fn(
      (data: Parameters<EmbeddedAgentSubscribeContext["emitAssistantStreamData"]>[0]) => {
        onAgentEvent?.({ stream: "assistant", data });
      },
    ),
    emitBlockReply: params.emitBlockReply ?? vi.fn(),
    consumeReplyDirectives: params.consumeReplyDirectives ?? vi.fn(() => ({ text: "Need send." })),
    emitReasoningStream: vi.fn(),
    flushBlockReplyBuffer: params.flushBlockReplyBuffer ?? vi.fn(),
    blockChunker: params.blockChunker ?? null,
  } as unknown as EmbeddedAgentSubscribeContext;
}

export function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

export function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  return firstMockCall(mock, label)[0];
}

export function createMessageToolEnvelope(
  message: string,
  args: Record<string, unknown> = {},
): string {
  // Messaging tool envelopes mimic provider tool-call JSON used by fallback
  // reply extraction when the assistant otherwise says NO_REPLY.
  return JSON.stringify({
    name: "message",
    arguments: {
      action: "send",
      message,
      ...args,
    },
  });
}
