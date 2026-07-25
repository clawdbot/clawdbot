// Message handler tests cover assistant stream payloads, partial replies,
// block replies, directives, media, and message-tool reply suppression.
import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  consumePendingToolMediaIntoReply,
  consumePendingToolMediaReply,
  handleMessageEnd,
  handleMessageUpdate,
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.js";
import {
  buildAssistantStreamData,
  recordPendingAssistantReplyDirectives,
  resolveSilentReplyFallbackText,
} from "./embedded-agent-subscribe.handlers.messages.test-support.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

function createMessageUpdateContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onPartialReply?: ReturnType<typeof vi.fn>;
    flushBlockReplyBuffer?: ReturnType<typeof vi.fn>;
    resetAssistantMessageState?: ReturnType<typeof vi.fn>;
    debug?: ReturnType<typeof vi.fn>;
    shouldEmitPartialReplies?: boolean;
    consumePartialReplyDirectives?: ReturnType<typeof vi.fn>;
    stripBlockTags?: ReturnType<typeof vi.fn>;
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
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
    },
    state: {
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      reasoningStreamOpen: false,
      streamReasoning: false,
      deltaBuffer: "",
      blockBuffer: "",
      partialBlockState: {
        thinking: false,
        final: false,
        inlineCode: createInlineCodeState(),
      },
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      emittedAssistantUpdate: false,
      shouldEmitPartialReplies: params.shouldEmitPartialReplies ?? true,
      blockReplyBreak: "text_end",
      assistantMessageIndex: 0,
      lastAssistantStreamItemId: undefined,
      assistantTexts: [],
      pendingAssistantReplyDirectives: undefined,
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
    emitReasoningStream: vi.fn(),
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

function createMessageEndContext(
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
      emittedAssistantUpdate: false,
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
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

function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  return firstMockCall(mock, label)[0];
}

function createMessageToolEnvelope(message: string, args: Record<string, unknown> = {}): string {
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

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: ["first", "final delivered text"],
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "normal assistant reply",
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [],
      }),
    ).toBe("NO_REPLY");
  });

  it("tolerates malformed text payloads without throwing", () => {
    expect(
      resolveSilentReplyFallbackText({
        text: undefined,
        messagingToolSentTexts: ["final delivered text"],
      }),
    ).toBe("");
    expect(
      resolveSilentReplyFallbackText({
        text: "NO_REPLY",
        messagingToolSentTexts: [42 as unknown as string],
      }),
    ).toBe("42");
  });
});

describe("hasAssistantVisibleReply", () => {
  it("treats audio-only payloads as visible", () => {
    expect(hasAssistantVisibleReply({ audioAsVoice: true })).toBe(true);
  });

  it("detects text or media visibility", () => {
    expect(hasAssistantVisibleReply({ text: "hello" })).toBe(true);
    expect(hasAssistantVisibleReply({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasAssistantVisibleReply({})).toBe(false);
  });
});

describe("buildAssistantStreamData", () => {
  it("normalizes media payloads for assistant stream events", () => {
    expect(
      buildAssistantStreamData({
        text: "hello",
        delta: "he",
        replace: true,
        mediaUrl: "https://example.com/a.png",
        phase: "final_answer",
      }),
    ).toEqual({
      text: "hello",
      delta: "he",
      replace: true,
      mediaUrls: ["https://example.com/a.png"],
      phase: "final_answer",
    });
  });
});

describe("pending assistant reply directives", () => {
  it("merges directive metadata into the next non-reasoning block reply", () => {
    const state = { pendingAssistantReplyDirectives: undefined };

    recordPendingAssistantReplyDirectives(state, {
      text: "",
      mediaUrls: ["/tmp/reply.ogg"],
      replyToCurrent: true,
      replyToTag: true,
      audioAsVoice: true,
      isSilent: false,
    });

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      mediaUrls: ["/tmp/reply.ogg"],
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
    expect(state.pendingAssistantReplyDirectives).toBeUndefined();
  });

  it("does not consume pending directive metadata on reasoning replies", () => {
    const state = {
      pendingAssistantReplyDirectives: {
        mediaUrls: ["/tmp/reply.png"],
      },
    };

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Thinking...",
        isReasoning: true,
      }),
    ).toEqual({
      text: "Thinking...",
      isReasoning: true,
    });
    expect(state.pendingAssistantReplyDirectives?.mediaUrls).toEqual(["/tmp/reply.png"]);
  });
});

describe("handleMessageUpdate text signatures", () => {
  it("uses incremental text deltas for unphased OpenAI Responses streams", () => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn((text: string) => text);
    const context = createMessageUpdateContext({ onAgentEvent, stripBlockTags });

    const createNonPhaseEvent = (text: string, delta: string) =>
      ({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial: {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.2",
            usage: {},
            timestamp: 0,
          },
        },
      }) as never;

    handleMessageUpdate(context, createNonPhaseEvent("Hello ", "Hello "));
    handleMessageUpdate(context, createNonPhaseEvent("Hello world", "world"));

    expect(stripBlockTags.mock.calls.map(([text]) => text)).toEqual(["Hello ", "world"]);
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Hello", delta: "Hello" },
      },
      {
        stream: "assistant",
        data: { text: "Hello world", delta: " world" },
      },
    ]);
  });

  it("treats unphased OpenAI Responses content-index changes as message boundaries", () => {
    const flushBlockReplyBuffer = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      onPartialReply,
      state: {
        deltaBuffer: "First block",
        lastStreamedAssistant: "First block",
        lastStreamedAssistantCleaned: "First block",
        lastAssistantStreamContentIndex: 0,
      },
    });
    const resetAssistantMessageState = vi.fn(() => {
      context.state.deltaBuffer = "";
      context.state.lastStreamedAssistant = undefined;
      context.state.lastStreamedAssistantCleaned = undefined;
    });
    context.resetAssistantMessageState = resetAssistantMessageState;
    context.params.onAssistantMessageStart = onAssistantMessageStart;

    handleMessageUpdate(context, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 1,
        content: "First block",
        partial: {
          role: "assistant",
          content: [
            { type: "text", text: "First block" },
            { type: "text", text: "First block" },
          ],
          api: "openai-responses",
        },
      },
    } as never);

    expect(flushBlockReplyBuffer).toHaveBeenCalledTimes(1);
    expect(resetAssistantMessageState).toHaveBeenCalledTimes(1);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "First block", delta: "First block" }),
    );
    expect(context.state.blockBuffer).toBe("First block");
    expect(context.state.lastAssistantStreamContentIndex).toBe(1);
  });

  it("holds incomplete streaming directive tails without emitting them as text", () => {
    const onAgentEvent = vi.fn();
    const accumulator = createStreamingDirectiveAccumulator();
    const context = createMessageUpdateContext({
      onAgentEvent,
      consumePartialReplyDirectives: vi.fn((text: string, options?: { final?: boolean }) =>
        accumulator.consume(text, options),
      ),
    });

    const createNonPhaseEvent = (delta: string) =>
      ({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
        },
      }) as never;

    handleMessageUpdate(context, createNonPhaseEvent("Hello\n"));
    handleMessageUpdate(context, createNonPhaseEvent("M"));

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: { text: "Hello", delta: "Hello" },
    });
    expect(context.state.lastStreamedAssistantCleaned).toBe("Hello");
  });

  it("keeps stripped reply directives out of later plain deltas", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    const createNonPhaseEvent = (delta: string) =>
      ({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
        },
      }) as never;

    handleMessageUpdate(context, createNonPhaseEvent("[[reply_to_current]]\nHello"));
    handleMessageUpdate(context, createNonPhaseEvent(" world"));

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Hello", delta: "Hello" },
      },
      {
        stream: "assistant",
        data: { text: "Hello world", delta: " world" },
      },
    ]);
  });

  it("does not expose complete legacy media directives on plain deltas", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    handleMessageUpdate(context, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Here it is.\nMEDIA:/tmp/final.png\n",
      },
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: { text: "Here it is.", delta: "Here it is." },
    });
  });

  it("uses full partial text for suffix deltas after a suppressed commentary item", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    handleMessageUpdate(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Hello",
        delta: "Hello",
        id: "item-commentary",
        signaturePhase: "commentary",
        partialPhase: "commentary",
      }),
    );
    handleMessageUpdate(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Hello world",
        delta: " world",
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      // Emit-always: the commentary delta reaches the bus tagged with its
      // phase; reply lanes still exclude it (covered below).
      {
        stream: "assistant",
        data: { delta: "Hello", phase: "commentary", itemId: "item-commentary" },
      },
      {
        stream: "assistant",
        data: { text: "Hello world", delta: "Hello world", phase: "final_answer" },
      },
    ]);
  });

  it.each([
    "openai-responses",
    "openai-chatgpt-responses",
    "openclaw-openai-responses-transport",
    "openclaw-openai-chatgpt-responses-transport",
    "openclaw-azure-openai-responses-transport",
  ])("streams %s commentary bytes exactly once across start, deltas, and end", async (api) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const createPartial = (text: string) => ({
      ...createOpenAiResponsesPartial({
        text,
        id: "item-commentary",
        signaturePhase: "commentary",
        partialPhase: "commentary",
      }),
      api,
    });
    const startPartial = createPartial("Work");
    const finalPartial = createPartial("Working...");

    handleMessageUpdate(context, {
      type: "message_update",
      message: startPartial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 0,
        partial: startPartial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: startPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Work",
        partial: startPartial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: finalPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "ing...",
        partial: finalPartial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: finalPartial,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Working...",
        partial: finalPartial,
      },
    } as never);
    await handleMessageEnd(context, {
      type: "message_end",
      message: finalPartial,
    } as never);

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { delta: "Work", phase: "commentary", itemId: "item-commentary" },
      },
      {
        stream: "assistant",
        data: { delta: "ing...", phase: "commentary", itemId: "item-commentary" },
      },
    ]);
    expect(context.state.deltaBuffer).toBe("Working...");
    expect(context.state.blockBuffer).toBe("");
  });

  it("keeps same-index commentary snapshot extensions on the original live item key", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const createPartial = (text: string, id: string) =>
      createOpenAiResponsesPartial({
        text,
        id,
        signaturePhase: "commentary",
        partialPhase: "commentary",
      });
    const firstPartial = createPartial("Working", "item-1");
    const extendedPartial = createPartial("Working now", "item-2");

    handleMessageUpdate(context, {
      type: "message_update",
      message: firstPartial,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: firstPartial },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: firstPartial,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Working",
        partial: firstPartial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: extendedPartial,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Working now",
        partial: extendedPartial,
      },
    } as never);
    await handleMessageEnd(context, { type: "message_end", message: extendedPartial } as never);

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { delta: "Working", phase: "commentary", itemId: "item-1" },
      },
      {
        stream: "assistant",
        data: { delta: " now", phase: "commentary", itemId: "item-1" },
      },
    ]);
    expect(context.state.lastAssistantStreamItemId).toBe("item-1");
    expect(context.state.deltaBuffer).toBe("Working now");
  });

  it("emits a commentary snapshot when Anthropic text is classified after deltas", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const narration = "I'll check the repo first.";
    const commentaryPartial = {
      role: "assistant",
      api: "anthropic-messages",
      content: [
        {
          type: "text",
          text: narration,
          textSignature: JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" }),
        },
      ],
    };

    handleMessageUpdate(context, {
      type: "message_update",
      message: {
        role: "assistant",
        api: "anthropic-messages",
        content: [{ type: "text", text: narration }],
      },
      assistantMessageEvent: { type: "text_delta", delta: narration },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: { role: "assistant", api: "anthropic-messages", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: narration,
        partial: commentaryPartial,
      },
    } as never);

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({
          text: narration,
          replace: true,
          phase: "commentary",
          itemId: "commentary-0",
        }),
      }),
    );
  });

  it("uses incremental deltas for same-item phased streams", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const signature = JSON.stringify({ v: 1, id: "item-final", phase: "final_answer" });
    const partial = {
      role: "assistant",
      phase: "final_answer",
      content: [
        {
          type: "text",
          textSignature: signature,
          get text() {
            throw new Error("full partial text should not be read");
          },
        },
      ],
    };

    const createPhasedDelta = (delta: string) =>
      ({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial,
        },
      }) as never;

    handleMessageUpdate(context, createPhasedDelta("Hello"));
    handleMessageUpdate(context, createPhasedDelta(" world"));

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Hello", delta: "Hello", phase: "final_answer" },
      },
      {
        stream: "assistant",
        data: { text: "Hello world", delta: " world", phase: "final_answer" },
      },
    ]);
  });

  it("keeps same-item phased stream deltas on the user-visible sanitizer path", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const signature = JSON.stringify({ v: 1, id: "item-final", phase: "final_answer" });
    const partial = {
      role: "assistant",
      phase: "final_answer",
      content: [
        {
          type: "text",
          textSignature: signature,
          get text() {
            throw new Error("full partial text should not be read");
          },
        },
      ],
    };

    const createPhasedDelta = (delta: string) =>
      ({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial,
        },
      }) as never;

    handleMessageUpdate(context, createPhasedDelta("Visible\n<tool_call>{"));
    handleMessageUpdate(
      context,
      createPhasedDelta('"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>'),
    );
    handleMessageUpdate(context, createPhasedDelta("\nDone."));

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Visible", delta: "Visible", phase: "final_answer" },
      },
      {
        stream: "assistant",
        data: { text: "Visible\n\nDone.", delta: "\n\nDone.", phase: "final_answer" },
      },
    ]);
  });

  it("keeps sanitizer context when a same-item phased stream starts hidden", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const signature = JSON.stringify({ v: 1, id: "item-final", phase: "final_answer" });
    const partial = {
      role: "assistant",
      phase: "final_answer",
      content: [
        {
          type: "text",
          textSignature: signature,
          get text() {
            throw new Error("full partial text should not be read");
          },
        },
      ],
    };

    const createPhasedDelta = (delta: string) =>
      ({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial,
        },
      }) as never;

    handleMessageUpdate(context, createPhasedDelta("<tool_call>{"));
    handleMessageUpdate(
      context,
      createPhasedDelta('"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>\nDone.'),
    );

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Done.", delta: "Done.", phase: "final_answer" },
      },
    ]);
  });

  it("treats phased textSignature item changes as assistant-message boundaries", () => {
    const flushBlockReplyBuffer = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      resetAssistantMessageState,
      onPartialReply,
    });
    context.params.onAssistantMessageStart = onAssistantMessageStart;
    context.state.lastAssistantStreamContentIndex = 0;
    context.state.lastAssistantStreamItemId = "item-1";
    context.state.assistantMessageIndex = 7;

    handleMessageUpdate(context, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second block",
        partial: {
          role: "assistant",
          phase: "final_answer",
          content: [
            createOpenAiResponsesTextBlock({
              text: "First block",
              id: "item-1",
              phase: "final_answer",
            }),
            createOpenAiResponsesTextBlock({
              text: "Second block",
              id: "item-2",
              phase: "final_answer",
            }),
          ],
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.2",
          usage: {},
          timestamp: 0,
        },
      },
    } as never);

    expect(flushBlockReplyBuffer).toHaveBeenCalledWith({ assistantMessageIndex: 7 });
    expect(resetAssistantMessageState).toHaveBeenCalledWith(0);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Second block",
        delta: "Second block",
        phase: "final_answer",
      }),
    );
    expect(onPartialReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "First block\nSecond block" }),
    );
    expect(context.state.lastAssistantStreamContentIndex).toBe(1);
    expect(context.state.lastAssistantStreamItemId).toBe("item-2");
  });

  it("does not replay a deferred item snapshot before its first delta", () => {
    const flushBlockReplyBuffer = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      resetAssistantMessageState,
      onPartialReply,
      state: {
        lastAssistantStreamContentIndex: 0,
        lastAssistantStreamItemId: "item-1",
      },
    });
    context.params.onAssistantMessageStart = onAssistantMessageStart;
    const partial = {
      role: "assistant",
      phase: "final_answer",
      content: [
        createOpenAiResponsesTextBlock({
          text: "First block",
          id: "item-1",
          phase: "final_answer",
        }),
        createOpenAiResponsesTextBlock({
          text: "Second block",
          id: "item-2",
          phase: "final_answer",
        }),
      ],
      api: "openai-responses",
    };

    handleMessageUpdate(context, {
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 1,
        partial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second block",
      },
    } as never);

    expect(flushBlockReplyBuffer).toHaveBeenCalledTimes(1);
    expect(resetAssistantMessageState).toHaveBeenCalledTimes(1);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Second block",
        delta: "Second block",
        phase: "final_answer",
      }),
    );
  });

  it("keeps same-block OpenAI Responses snapshot extensions in one assistant message", () => {
    const flushBlockReplyBuffer = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      resetAssistantMessageState,
      onPartialReply,
      state: {
        deltaBuffer: "First block",
        lastStreamedAssistant: "First block",
        lastStreamedAssistantCleaned: "First block",
        lastAssistantStreamContentIndex: 0,
        lastAssistantStreamItemId: "item-1",
      },
    });
    context.params.onAssistantMessageStart = onAssistantMessageStart;

    handleMessageUpdate(context, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "First block extended",
        partial: createOpenAiResponsesPartial({
          text: "First block extended",
          id: "item-2",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      },
    } as never);

    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(resetAssistantMessageState).not.toHaveBeenCalled();
    expect(onAssistantMessageStart).not.toHaveBeenCalled();
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "First block extended",
        delta: " extended",
        phase: "final_answer",
      }),
    );
    expect(context.state.lastAssistantStreamContentIndex).toBe(0);
    expect(context.state.lastAssistantStreamItemId).toBe("item-1");
  });

  it("scopes item-id fallback boundaries to the matching signed block", () => {
    const onPartialReply = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const context = createMessageUpdateContext({
      onPartialReply,
      resetAssistantMessageState,
      state: { lastAssistantStreamItemId: "item-1" },
    });

    handleMessageUpdate(context, {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Second block",
        partial: {
          role: "assistant",
          phase: "final_answer",
          content: [
            createOpenAiResponsesTextBlock({
              text: "First block",
              id: "item-1",
              phase: "final_answer",
            }),
            createOpenAiResponsesTextBlock({
              text: "Second block",
              id: "item-2",
              phase: "final_answer",
            }),
          ],
          api: "openai-responses",
        },
      },
    } as never);

    expect(resetAssistantMessageState).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Second block",
        delta: "Second block",
        phase: "final_answer",
      }),
    );
    expect(onPartialReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "First block\nSecond block" }),
    );
    expect(context.state.lastAssistantStreamContentIndex).toBeUndefined();
    expect(context.state.lastAssistantStreamItemId).toBe("item-2");
  });

  it("preserves phase-aware voice and reply directives while deferring final media delivery", () => {
    const accumulator = createStreamingDirectiveAccumulator();
    const ctx = createMessageUpdateContext({
      consumePartialReplyDirectives: vi.fn((text: string, options?: { final?: boolean }) =>
        accumulator.consume(text, options),
      ),
      state: {
        blockReplyBreak: "message_end",
      },
    });
    const replyText = "Done.\n\n[[reply_to_current]]\n[[audio_as_voice]]\nMEDIA:/tmp/reply.ogg";

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: replyText,
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_end",
        text: replyText,
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );

    expect(ctx.state.blockBuffer).toBe("Done.");
    expect(
      consumePendingAssistantReplyDirectivesIntoReply(ctx.state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
  });
});

describe("consumePendingToolMediaIntoReply", () => {
  it("attaches queued tool media to the next assistant reply", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      pendingToolAudioAsVoice: false,
      pendingToolTrustedLocalMedia: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      audioAsVoice: undefined,
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
  });

  it("does not append queued image tool media when the reply already names media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.png"],
      pendingToolAudioAsVoice: false,
      pendingToolTrustedLocalMedia: true,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["./selected.png"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["./selected.png"],
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
    expect(state.pendingToolTrustedLocalMedia).toBe(false);
  });

  it("does not append queued voice media when the reply already names media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolAudioAsVoice: true,
      pendingToolTrustedLocalMedia: true,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["/tmp/assistant-provided.opus"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/assistant-provided.opus"],
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
    expect(state.pendingToolTrustedLocalMedia).toBe(false);
  });

  it("preserves reasoning replies without consuming queued media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png"],
      pendingToolAudioAsVoice: true,
      pendingToolTrustedLocalMedia: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "thinking",
        isReasoning: true,
      }),
    ).toEqual({
      text: "thinking",
      isReasoning: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/a.png"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });
});

describe("consumePendingToolMediaReply", () => {
  it("reads a media-only reply without consuming queued tool media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolAudioAsVoice: true,
      pendingToolTrustedLocalMedia: false,
    };

    expect(readPendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });

  it("builds a media-only reply for orphaned tool media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolAudioAsVoice: true,
      pendingToolTrustedLocalMedia: false,
    };

    expect(consumePendingToolMediaReply(state)).toEqual({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
  });
});

describe("handleMessageUpdate commentary phase", () => {
  it("suppresses commentary-phase partial delivery and text_end flush", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      flushBlockReplyBuffer,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({ type: "text_delta", text: "Need send.", messagePhase: "commentary" }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({ type: "text_end", text: "Need send.", messagePhase: "commentary" }),
    );

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
  });

  it("suppresses commentary partials when phase exists only in textSignature metadata", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const commentaryBlock = createOpenAiResponsesTextBlock({
      text: "Need send.",
      id: "msg_sig",
      phase: "commentary",
    });
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      flushBlockReplyBuffer,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_end",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );

    await Promise.resolve();

    // Archive-always: commentary (textSignature-only phase — the F3 shape) is
    // emitted on the bus for archival + window, but kept out of the reply lanes.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.state.blockBuffer).toBe("");
  });

  it("keeps commentary partials out of reply lanes while emitting them on the bus", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      shouldEmitPartialReplies: false,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Working...",
        partial: createOpenAiResponsesPartial({
          text: "Working...",
          id: "item_commentary",
          signaturePhase: "commentary",
          partialPhase: "commentary",
        }),
      }),
    );

    // Emit-always: the bus sees the commentary delta with its phase tag. The raw
    // cumulative buffer retains it for end-event dedupe, but reply blocks stay untouched.
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    const commentaryEvent = firstMockArg(onAgentEvent, "agent event") as
      | { stream?: string; data?: { delta?: string; phase?: string } }
      | undefined;
    expect(commentaryEvent?.stream).toBe("assistant");
    expect(commentaryEvent?.data?.phase).toBe("commentary");
    expect(commentaryEvent?.data?.delta).toBe("Working...");
    expect(ctx.state.deltaBuffer).toBe("Working...");
    expect(ctx.state.blockBuffer).toBe("");

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Done.",
        partial: createOpenAiResponsesPartial({
          text: "Done.",
          id: "item_final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledTimes(2);
    const event = onAgentEvent.mock.calls[1]?.[0] as
      | { stream?: string; data?: { text?: string; delta?: string } }
      | undefined;
    expect(event?.stream).toBe("assistant");
    expect(event?.data?.text).toBe("Done.");
    expect(event?.data?.delta).toBe("Done.");
  });

  it("contains synchronous text_end flush failures", async () => {
    const debug = vi.fn();
    const ctx = createMessageUpdateContext({
      debug,
      shouldEmitPartialReplies: false,
      flushBlockReplyBuffer: vi.fn(() => {
        throw new Error("boom");
      }),
    });

    handleMessageUpdate(ctx, createTextUpdateEvent({ type: "text_end", text: "" }));

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    });
  });
});

describe("handleMessageEnd", () => {
  it("keeps duplicate-reply diagnostics free of lone surrogates", () => {
    const text = `${"a".repeat(49)}😀tail`;
    const ctx = createMessageEndContext({
      consumeReplyDirectives: vi.fn((value: string) => ({ text: value })),
      state: { messagingToolSentTextsNormalized: [`${"a".repeat(49)}tail`] },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    } as never);

    const diagnostic = (ctx.log.debug as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .find((value) => String(value).startsWith("Skipping message_end block reply"));
    expect(diagnostic).toEqual(expect.any(String));
    expect(Buffer.from(String(diagnostic)).toString()).toBe(diagnostic);
  });

  it("persists streamed usage when the final assistant snapshot is zeroed", () => {
    const ctx = createMessageEndContext({
      state: {
        pendingAssistantUsage: { input: 7, output: 5, reasoningTokens: 2, total: 12 },
      },
    });
    const message = {
      role: "assistant",
      api: "openai-completions",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
    };

    void handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(ctx.noteLastAssistant as never, "last assistant")).toMatchObject({
      usage: {
        input: 7,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 2,
        totalTokens: 12,
      },
    });
    expect(ctx.recordAssistantUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 7,
        output: 5,
        reasoningTokens: 2,
        totalTokens: 12,
      }),
    );
  });

  it("keeps authoritative final usage instead of pending stream usage", () => {
    const ctx = createMessageEndContext({
      state: {
        pendingAssistantUsage: { input: 7, output: 5, total: 12 },
      },
    });
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input: 11,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
      },
    };

    void handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(ctx.noteLastAssistant as never, "last assistant")).toBe(message);
    expect(ctx.recordAssistantUsage).toHaveBeenCalledWith(message.usage);
  });

  it("warns when assistant text only pretends to call a registered tool", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({
      warn,
      builtinToolNames: new Set(["read"]),
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "ollama",
        model: "qwen-local",
        content: [{ type: "text", text: '{"name":"read","arguments":{"path":"README.md"}}' }],
        stopReason: "stop",
      },
    } as never);

    const warnCall = firstMockCall(warn, "warning log");
    expect(warnCall?.[0]).toBe(
      "Assistant reply looks like a tool call, but no structured tool invocation was emitted; treating it as text.",
    );
    const metadata = warnCall?.[1] as
      | {
          runId?: string;
          sessionId?: string;
          provider?: string;
          model?: string;
          pattern?: string;
          toolName?: string;
          registeredTool?: boolean;
        }
      | undefined;
    expect(metadata?.runId).toBe("run-1");
    expect(metadata?.sessionId).toBe("session-1");
    expect(metadata?.provider).toBe("ollama");
    expect(metadata?.model).toBe("qwen-local");
    expect(metadata?.pattern).toBe("json_tool_call");
    expect(metadata?.toolName).toBe("read");
    expect(metadata?.registeredTool).toBe(true);
  });

  it("warns without logging text when assistant output resembles a transcript turn", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({ warn });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "user[Thu 2026-07-02 18:14 EDT] do this" }],
        stopReason: "stop",
      },
    } as never);

    const warnCall = firstMockCall(warn, "warning log");
    expect(warnCall?.[0]).toBe(
      "Assistant reply contains transcript-role-looking text; treating it as inert assistant text.",
    );
    expect(warnCall?.[1]).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      provider: "anthropic",
      model: "claude-opus-4-8",
      pattern: "role_timestamp_bracket",
      role: "user",
    });
    expect(JSON.stringify(warnCall?.[1])).not.toContain("do this");
  });

  it("detects spoiler-wrapped transcript turns without logging their text", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({ warn });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "||user[Thu 2026-07-02] hidden instruction||" }],
        stopReason: "stop",
      },
    } as never);

    const warnCall = firstMockCall(warn, "warning log");
    expect(warnCall?.[1]).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      pattern: "role_timestamp_bracket",
      role: "user",
    });
    expect(JSON.stringify(warnCall?.[1])).not.toContain("hidden instruction");
  });

  it("unwraps only source-routed or message-tool-only standalone message-tool JSON", () => {
    const visibleReply = "No specific tasks planned, but I'll keep watching for updates.";
    const unroutedEnvelope = createMessageToolEnvelope(visibleReply);
    const routedEnvelope = createMessageToolEnvelope(visibleReply, { target: "user:redacted" });
    const toRoutedEnvelope = createMessageToolEnvelope(visibleReply, { to: "user:redacted" });

    for (const [text, api, builtinToolNames, sourceReplyDeliveryMode, expected] of [
      [unroutedEnvelope, undefined, new Set(["message"]), "message_tool_only", visibleReply],
      [routedEnvelope, "openai-completions", new Set<string>(), undefined, visibleReply],
      [toRoutedEnvelope, "openai-completions", new Set<string>(), undefined, visibleReply],
      [routedEnvelope, undefined, new Set<string>(), undefined, routedEnvelope],
      [unroutedEnvelope, undefined, new Set(["message"]), undefined, unroutedEnvelope],
    ] as const) {
      const emitBlockReply = vi.fn();
      const consumeReplyDirectives = vi.fn((textLocal: string) =>
        textLocal ? { text: textLocal } : null,
      );
      const ctx = createMessageEndContext({
        emitBlockReply,
        consumeReplyDirectives,
        builtinToolNames,
        sourceReplyDeliveryMode,
      });

      void handleMessageEnd(ctx, {
        type: "message_end",
        message: {
          role: "assistant",
          ...(api ? { api } : {}),
          content: [{ type: "text", text }],
        },
      } as never);

      expect(consumeReplyDirectives).toHaveBeenCalledWith(expected, { final: true });
      expect(firstMockArg(emitBlockReply, "block reply")).toMatchObject({ text: expected });
    }
  });

  it("does not warn when the assistant emitted a structured tool call", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({
      warn,
      builtinToolNames: new Set(["read"]),
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
    } as never);

    expect(warn).not.toHaveBeenCalled();
  });

  it("suppresses commentary-phase replies from user-visible output", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      finalizeAssistantTexts,
      emitBlockReply,
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "Need send." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    // Archive-always: commentary reaches the bus/archive but not the visible reply.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("suppresses commentary message_end when phase exists only in textSignature metadata", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      finalizeAssistantTexts,
      emitBlockReply,
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Need send.",
            id: "msg_sig",
            phase: "commentary",
          }),
        ],
        usage: { input: 1, output: 1, total: 2 },
      },
    } as never);

    // Archive-always: commentary (textSignature-only phase) reaches the
    // bus/archive but not the visible reply.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("does not duplicate block reply for text_end channels when text was already delivered", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // In real usage, the directive accumulator returns null for empty/consumed
    // input. The non-empty call shouldn't happen for text_end channels (that's
    // the safety send we're guarding against).
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      onBlockReply,
      emitBlockReply,
      consumeReplyDirectives,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // Simulate text_end already delivered this text through emitBlockChunk
        lastBlockReplyText: "Hello world",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    // The block reply should NOT fire again since text_end already delivered it.
    // consumeReplyDirectives is called once with "" (the final flush for
    // text_end channels) but returns null, so emitBlockReply is never called.
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("tags message-end safety replies with the current assistant message", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      onBlockReply: vi.fn(),
      emitBlockReply,
      consumeReplyDirectives: vi.fn((text: string) => (text ? { text } : null)),
      state: {
        assistantMessageIndex: 7,
        blockReplyBreak: "text_end",
        lastBlockReplyText: null,
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    expect(emitBlockReply).toHaveBeenCalledWith(
      { text: "Final answer" },
      { assistantMessageIndex: 7 },
    );
  });

  it("does not duplicate block reply for text_end channels even when stripping differs", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // Same pattern: directive accumulator returns null for empty final flush
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      onBlockReply,
      emitBlockReply,
      consumeReplyDirectives,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // text_end delivered via emitBlockChunk which uses different stripping
        lastBlockReplyText: "Hello world.",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        // The raw text differs slightly from lastBlockReplyText due to stripping
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    // Even though text !== lastBlockReplyText (different stripping), the safety
    // send should NOT fire for text_end channels. The only consumeReplyDirectives
    // call is the final empty flush which returns null.
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("emits final media after flushing buffered message_end text", () => {
    const emitBlockReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      emitBlockReply,
      flushBlockReplyBuffer,
      consumeReplyDirectives,
      blockChunker: {
        hasBuffered: () => true,
        reset: vi.fn(),
      },
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Caption",
        blockReplyBreak: "message_end",
        deltaBuffer: "Caption",
        blockBuffer: "Caption",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Caption\nMEDIA:/tmp/final.png" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    expect(flushBlockReplyBuffer).toHaveBeenCalledWith({
      assistantMessageIndex: undefined,
      final: true,
    });
    expect(consumeReplyDirectives).not.toHaveBeenCalled();
    expect(firstMockArg(emitBlockReply, "block reply")).toMatchObject({
      text: "",
      mediaUrls: ["/tmp/final.png"],
    });
  });

  it("preserves literal reasoning-looking tags in unphased final visible text", () => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn(() => "Before");
    const ctx = createMessageEndContext({
      onAgentEvent,
      stripBlockTags,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Before <think>literal tag text after",
            textSignature: JSON.stringify({ v: 1, id: "item_unphased" }),
          },
        ],
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    expect(stripBlockTags).not.toHaveBeenCalled();
    expect(firstMockArg(ctx.emitAssistantStreamData as never, "assistant stream")).toMatchObject({
      text: "Before <think>literal tag text after",
      delta: "Before <think>literal tag text after",
    });
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Before <think>literal tag text after" }),
    );
  });

  it("keeps final-tag enforcement in message_end fallback", () => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn(() => "");
    const ctx = createMessageEndContext({
      enforceFinalTag: true,
      onAgentEvent,
      stripBlockTags,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello world",
        usage: { input: 10, output: 5, total: 15 },
      },
    } as never);

    expect(stripBlockTags).toHaveBeenCalledWith(
      "Hello world",
      { thinking: false, final: false },
      { final: true },
    );
    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
  });

  it("emits a replacement final assistant event when final_answer appears only at message_end", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Working...",
        blockReplyBreak: "text_end",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Working...",
            id: "item_commentary",
            phase: "commentary",
          }),
          createOpenAiResponsesTextBlock({
            text: "Done.",
            id: "item_final",
            phase: "final_answer",
          }),
        ],
        stopReason: "stop",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.2",
        usage: {},
        timestamp: 0,
      },
    } as never);

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    const event = firstMockArg(onAgentEvent, "agent event") as
      | { stream?: string; data?: { text?: string; delta?: string; replace?: boolean } }
      | undefined;
    expect(event?.stream).toBe("assistant");
    expect(event?.data?.text).toBe("Done.");
    expect(event?.data?.delta).toBe("");
    expect(event?.data?.replace).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
