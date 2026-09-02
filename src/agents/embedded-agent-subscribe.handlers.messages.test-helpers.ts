import { vi, type Mock } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import { handleMessageEnd } from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { handleMessageUpdate } from "./embedded-agent-subscribe.handlers.messages.update.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";
import { createEmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import { createStreamRendering } from "./embedded-agent-subscribe.stream-rendering.js";

export function updateMessage(
  context: EmbeddedAgentSubscribeContext,
  event: { message: unknown; assistantMessageEvent?: unknown },
) {
  // Stream fixtures intentionally include incomplete and malformed provider payloads.
  return handleMessageUpdate(context, {
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
  const ctx = {
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: params.sourceReplyDeliveryMode }
        : {}),
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
    },
    log: { debug: params.debug ?? vi.fn() },
    noteLastAssistant: vi.fn(),
    stripBlockTags: params.stripBlockTags ?? vi.fn((text: string) => text),
    consumePartialReplyDirectives:
      params.consumePartialReplyDirectives ??
      vi.fn((text: string, options?: { final?: boolean }) =>
        partialReplyDirectiveAccumulator.consume(text, options),
      ),
    emitReasoningStream: params.emitReasoningStream ?? vi.fn(),
    flushBlockReplyBuffer: params.flushBlockReplyBuffer ?? vi.fn(),
    flushAssistantStream: vi.fn(),
    blockChunker: new EmbeddedBlockChunker(),
    resetAssistantMessageState: params.resetAssistantMessageState ?? vi.fn(),
    captureModelEvent: vi.fn(),
    resetBlockReplyDirectives: vi.fn(),
    resetPartialReplyDirectives: () => {
      partialReplyDirectiveAccumulator.reset();
      ctx.state.pendingAssistantReplyDirectives = undefined;
    },
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
  ctx.state = {
    ...createEmbeddedAgentSubscribeState(ctx.params),
    shouldEmitPartialReplies: params.shouldEmitPartialReplies ?? true,
    ...params.state,
  };
  return ctx;
}

export function createMessageEndContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onBlockReply?: ReturnType<typeof vi.fn>;
    finalizeAssistantTexts?: Mock<EmbeddedAgentSubscribeContext["finalizeAssistantTexts"]>;
    flushBlockReplyBuffer?: Mock<EmbeddedAgentSubscribeContext["flushBlockReplyBuffer"]>;
    stripBlockTags?: Mock<EmbeddedAgentSubscribeContext["stripBlockTags"]>;
    warn?: ReturnType<typeof vi.fn>;
    builtinToolNames?: ReadonlySet<string>;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    enforceFinalTag?: boolean;
    bufferedText?: string;
    state?: Record<string, unknown>;
  } = {},
) {
  // Buffered cases seed the real source buffer; other cases exercise terminal-only delivery.
  const ctx = {
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
    noteLastAssistant: vi.fn(),
    captureModelEvent: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: params.warn ?? vi.fn() },
    builtinToolNames: params.builtinToolNames,
    blockChunker: new EmbeddedBlockChunker(),
  } as unknown as EmbeddedAgentSubscribeContext;
  ctx.state = {
    ...createEmbeddedAgentSubscribeState(ctx.params),
    blockReplyBreak: "message_end",
    deltaBuffer: "Need send.",
    ...params.state,
  };
  ctx.blockChunker.append(params.bufferedText ?? "");
  const delivery = createReplyDelivery(ctx);
  ctx.emitAssistantStreamData = delivery.emitAssistantStreamData;
  ctx.flushAssistantStream = delivery.flushAssistantStream;
  ctx.emitBlockReply = vi.fn(delivery.emitBlockReply);
  ctx.finalizeAssistantTexts =
    params.finalizeAssistantTexts ?? vi.fn(delivery.finalizeAssistantTexts);
  const rendering = createStreamRendering({
    ...ctx,
    pendingBlockReplyTasks: delivery.pendingBlockReplyTasks,
    pushAssistantText: delivery.pushAssistantText,
    shouldSkipAssistantText: delivery.shouldSkipAssistantText,
  });
  Object.assign(ctx, rendering);
  ctx.stripBlockTags = params.stripBlockTags ?? vi.fn(rendering.stripBlockTags);
  ctx.flushBlockReplyBuffer =
    params.flushBlockReplyBuffer ?? vi.fn(rendering.flushBlockReplyBuffer);
  return ctx;
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
