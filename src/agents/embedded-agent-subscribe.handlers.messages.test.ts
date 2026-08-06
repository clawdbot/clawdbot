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
  handleMessageUpdate as handleMessageUpdateImpl,
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.js";
import {
  buildAssistantStreamData,
  recordPendingAssistantReplyDirectives,
  resolveCurrentSourceMessagingToolPartial,
} from "./embedded-agent-subscribe.handlers.messages.test-support.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { createThinkingTagStreamState } from "./embedded-agent-utils.js";

function handleMessageUpdate(...args: Parameters<typeof handleMessageUpdateImpl>): void {
  void handleMessageUpdateImpl(...args);
}

function updateMessage(
  context: EmbeddedAgentSubscribeContext,
  event: { message: unknown; assistantMessageEvent?: unknown },
) {
  // Stream fixtures intentionally include incomplete and malformed provider payloads.
  return handleMessageUpdate(context, {
    type: "message_update",
    ...event,
  } as Parameters<typeof handleMessageUpdate>[1]);
}

function endMessage(context: EmbeddedAgentSubscribeContext, event: { message: unknown }) {
  // Message-end coverage includes malformed content and partial provider usage.
  return handleMessageEnd(context, {
    type: "message_end",
    ...event,
  } as Parameters<typeof handleMessageEnd>[1]);
}

function createMessageUpdateContext(
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

describe("handleMessageUpdate current-source message-tool previews", () => {
  it("holds delta-only continuation fragments and releases one full divergent snapshot", () => {
    const state = {
      currentSourceMessagingToolHeldPartial: undefined as string | undefined,
      currentSourceMessagingToolSentTextsNormalized: ["qa-msteams-dm-ok"],
    };

    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: "QA-MSTEAMS",
        visibleDelta: "QA-MSTEAMS",
      }),
    ).toEqual({ hold: true, text: "QA-MSTEAMS" });
    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: "-DM-OK",
        visibleDelta: "-DM-OK",
      }),
    ).toEqual({ hold: true, text: "QA-MSTEAMS-DM-OK" });
    expect(
      resolveCurrentSourceMessagingToolPartial(state, {
        evtType: "text_delta",
        text: " with more detail",
        visibleDelta: " with more detail",
      }),
    ).toEqual({ hold: false, text: "QA-MSTEAMS-DM-OK with more detail" });
    expect(state.currentSourceMessagingToolHeldPartial).toBeUndefined();
  });

  it("holds automatic partial prefixes and exact duplicates after source delivery", () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const sentText = "QA-MSTEAMS-DM-OK";
    const context = createMessageUpdateContext({
      onAgentEvent,
      onPartialReply,
      sourceReplyDeliveryMode: "automatic",
      state: {
        currentSourceMessagingToolSentTextsNormalized: [sentText.toLowerCase()],
      },
    });

    updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "QA-MSTEAMS",
        id: "msg_source_duplicate",
      }),
    );
    updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_end",
        text: sentText,
        id: "msg_source_duplicate",
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("releases the full cumulative snapshot when automatic text diverges", () => {
    const onPartialReply = vi.fn();
    const sentText = "QA-MSTEAMS-DM-OK";
    const context = createMessageUpdateContext({
      onPartialReply,
      sourceReplyDeliveryMode: "automatic",
      state: {
        currentSourceMessagingToolSentTextsNormalized: [sentText.toLowerCase()],
      },
    });

    updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "QA-MSTEAMS",
        id: "msg_source_diverges",
      }),
    );
    updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_end",
        text: `${sentText} with more detail`,
        id: "msg_source_diverges",
      }),
    );

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: `${sentText} with more detail` }),
    );
  });

  it("keeps unrelated automatic partial text visible", () => {
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      onPartialReply,
      sourceReplyDeliveryMode: "automatic",
      state: {
        currentSourceMessagingToolSentTextsNormalized: ["qa-msteams-dm-ok"],
      },
    });

    updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_end",
        text: "A genuinely different answer",
        id: "msg_source_different",
      }),
    );

    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "A genuinely different answer" }),
    );
  });
});

describe("handleMessageUpdate text signatures", () => {
  it("emits the full incrementally extracted reasoning value on every delta", () => {
    const emitReasoningStream = vi.fn();
    const context = createMessageUpdateContext({ emitReasoningStream });

    for (const chunk of ["<thi", "nk>reason", "ing</think>"]) {
      updateMessage(
        context,
        createTextUpdateEvent({ type: "text_delta", text: chunk, delta: chunk }),
      );
    }

    expect(emitReasoningStream.mock.calls.map(([text]) => text)).toEqual([
      "",
      "reason",
      "reasoning",
    ]);
  });

  it("uses incremental text deltas for unphased OpenAI Responses streams", () => {
    const onAgentEvent = vi.fn();
    const stripBlockTags = vi.fn((text: string) => text);
    const context = createMessageUpdateContext({ onAgentEvent, stripBlockTags });

    const createNonPhaseEvent = (text: string, delta: string) =>
      ({
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

    updateMessage(context, createNonPhaseEvent("Hello ", "Hello "));
    updateMessage(context, createNonPhaseEvent("Hello world", "world"));

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

    updateMessage(context, {
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
    });

    expect(flushBlockReplyBuffer).toHaveBeenCalledTimes(2);
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
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
        },
      }) as never;

    updateMessage(context, createNonPhaseEvent("Hello\n"));
    updateMessage(context, createNonPhaseEvent("M"));

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: { text: "Hello", delta: "Hello" },
    });
    expect(context.state.lastStreamedAssistantCleaned).toBe("Hello");
  });

  it.each([
    {
      name: "the directive accumulator has no parsed result",
      text: "answer part A msg [[E1008]timeout] answer part B",
      hasParsedDirectives: false,
    },
    {
      name: "the directive accumulator flushes a buffered tail",
      text: "answer part A msg [[E1008]timeout] answer part B",
      hasParsedDirectives: true,
    },
    {
      name: "the final text ends with one bracket",
      text: "answer part A [",
      hasParsedDirectives: true,
    },
  ])("keeps literal final text when $name", ({ text, hasParsedDirectives }) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({
      onAgentEvent,
      ...(hasParsedDirectives ? {} : { consumePartialReplyDirectives: vi.fn(() => null) }),
    });

    updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_end", content: text },
    });

    expect(context.state.lastStreamedAssistantCleaned).toBe(text);
    expect(firstMockArg(onAgentEvent, "final assistant event")).toMatchObject({
      stream: "assistant",
      data: { text },
    });
  });

  it("keeps stripped reply directives out of later plain deltas", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    const createNonPhaseEvent = (delta: string) =>
      ({
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
        },
      }) as never;

    updateMessage(context, createNonPhaseEvent("[[reply_to_current]]\nHello"));
    updateMessage(context, createNonPhaseEvent(" world"));

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

    updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Here it is.\nMEDIA:/tmp/final.png\n",
      },
    });

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: { text: "Here it is.", delta: "Here it is." },
    });
  });

  it("uses full partial text for suffix deltas after a suppressed commentary item", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    updateMessage(
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
    updateMessage(
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

    updateMessage(context, {
      message: startPartial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 0,
        partial: startPartial,
      },
    });
    updateMessage(context, {
      message: startPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Work",
        partial: startPartial,
      },
    });
    updateMessage(context, {
      message: finalPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "ing...",
        partial: finalPartial,
      },
    });
    updateMessage(context, {
      message: finalPartial,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Working...",
        partial: finalPartial,
      },
    });
    await endMessage(context, {
      message: finalPartial,
    });

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

  it("streams Anthropic text bytes once when text_start is replayed by the first delta", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const partial = {
      role: "assistant",
      api: "anthropic-messages",
      content: [{ type: "text", text: "Work" }],
    };

    handleMessageUpdate(context, {
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 0,
        partial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Work",
        partial,
      },
    } as never);

    const deltas = onAgentEvent.mock.calls
      .map(([event]) => (event as { data?: { delta?: string } }).data?.delta ?? "")
      .join("");
    expect(deltas).toBe("Work");
    expect(context.state.deltaBuffer).toBe("Work");
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

    updateMessage(context, {
      message: firstPartial,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: firstPartial },
    });
    updateMessage(context, {
      message: firstPartial,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Working",
        partial: firstPartial,
      },
    });
    updateMessage(context, {
      message: extendedPartial,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Working now",
        partial: extendedPartial,
      },
    });
    await endMessage(context, { message: extendedPartial });

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

    updateMessage(context, {
      message: {
        role: "assistant",
        api: "anthropic-messages",
        content: [{ type: "text", text: narration }],
      },
      assistantMessageEvent: { type: "text_delta", delta: narration },
    });
    updateMessage(context, {
      message: commentaryPartial,
      assistantMessageEvent: {
        type: "text_end",
        content: narration,
        partial: commentaryPartial,
      },
    });

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

  it("strips continuation signals from commentary update snapshots", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const message = {
      role: "assistant",
      api: "openai-completions",
      phase: "commentary",
      content: [{ type: "text", text: "Working before tool.\nCONTINUE_WORK" }],
    };

    handleMessageUpdate(context, {
      type: "message_update",
      message,
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: {
        text: "Working before tool.",
        replace: true,
        phase: "commentary",
      },
    });
    expect(context.noteLastAssistant).toHaveBeenCalledWith(message);
  });

  it("buffers continuation signal prefixes in Responses commentary streams", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const createPartial = (text: string) =>
      createOpenAiResponsesPartial({
        text,
        id: "item-commentary",
        signaturePhase: "commentary",
        partialPhase: "commentary",
      });
    const prefixPartial = createPartial("Working before tool.\nCONTINUE_WOR");
    const finalPartial = createPartial("Working before tool.\nCONTINUE_WORK");

    handleMessageUpdate(context, {
      type: "message_update",
      message: prefixPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Working before tool.\nCONTINUE_WOR",
        partial: prefixPartial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: finalPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "K",
        partial: finalPartial,
      },
    } as never);

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: {
          delta: "Working before tool.\n",
          phase: "commentary",
          itemId: "item-commentary",
        },
      },
      {
        stream: "assistant",
        data: {
          text: "Working before tool.",
          replace: true,
          phase: "commentary",
          itemId: "item-commentary",
        },
      },
    ]);
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WOR");
    expect(context.state.deltaBuffer).toBe("Working before tool.\nCONTINUE_WORK");
  });

  it("releases a buffered commentary prefix after it stops matching a continuation signal", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const createPartial = (text: string) =>
      createOpenAiResponsesPartial({
        text,
        id: "item-commentary",
        signaturePhase: "commentary",
        partialPhase: "commentary",
      });

    for (const [text, delta] of [
      ["C", "C"],
      ["Carry on.", "arry on."],
    ] as const) {
      const partial = createPartial(text);
      handleMessageUpdate(context, {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial,
        },
      } as never);
    }

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: {
          delta: "Carry on.",
          phase: "commentary",
          itemId: "item-commentary",
        },
      },
    ]);
  });

  it("buffers split continuation signals in Anthropic commentary streams", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const createEvent = (text: string, delta: string) =>
      ({
        type: "message_update",
        message: { role: "assistant", api: "anthropic-messages", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial: {
            role: "assistant",
            api: "anthropic-messages",
            phase: "commentary",
            content: [{ type: "text", text }],
          },
        },
      }) as never;

    handleMessageUpdate(context, createEvent("CONTINUE_WOR", "CONTINUE_WOR"));
    handleMessageUpdate(context, createEvent("CONTINUE_WORK", "K"));

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(context.state.deltaBuffer).toBe("CONTINUE_WORK");
  });

  it.each(["anthropic-messages", "openai-completions"])(
    "keeps phase-pending %s continuation markers off the assistant event bus",
    async (api) => {
      const onAgentEvent = vi.fn();
      const context = createMessageUpdateContext({ onAgentEvent });

      for (const [text, delta] of [
        ["C", "C"],
        ["CONTINUE_WORK", "ONTINUE_WORK"],
      ]) {
        handleMessageUpdate(context, {
          type: "message_update",
          message: {
            role: "assistant",
            api,
            content: [{ type: "text", text }],
          },
          assistantMessageEvent: { type: "text_delta", delta },
        } as never);
      }

      expect(onAgentEvent).not.toHaveBeenCalled();
      await handleMessageEnd(context, {
        type: "message_end",
        message: {
          role: "assistant",
          api,
          phase: "commentary",
          content: [
            {
              type: "text",
              text: "CONTINUE_WORK",
              textSignature: JSON.stringify({
                v: 1,
                id: "commentary-0",
                phase: "commentary",
              }),
            },
          ],
        },
      } as never);

      expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
        stream: "assistant",
        data: {
          text: "",
          replace: true,
          phase: "commentary",
        },
      });
      expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WORK");
    },
  );

  it.each(["anthropic-messages", "openai-completions"])(
    "preserves the released %s false-positive suffix for append-only consumers",
    async (api) => {
      const onAgentEvent = vi.fn();
      const context = createMessageUpdateContext({ onAgentEvent });

      handleMessageUpdate(context, {
        type: "message_update",
        message: {
          role: "assistant",
          api,
          content: [{ type: "text", text: "Ordinary C" }],
        },
        assistantMessageEvent: { type: "text_delta", delta: "Ordinary C" },
      } as never);
      await handleMessageEnd(context, {
        type: "message_end",
        message: {
          role: "assistant",
          api,
          phase: "commentary",
          content: [{ type: "text", text: "Ordinary C" }],
        },
      } as never);

      expect(onAgentEvent.mock.calls.map((call) => call[0]?.data)).toMatchObject([
        { delta: "Ordinary " },
        {
          delta: "C",
          phase: "commentary",
        },
        {
          text: "Ordinary C",
          delta: "",
          replace: true,
          phase: "commentary",
        },
      ]);
      expect(
        onAgentEvent.mock.calls.some(
          (call) => call[0]?.data?.replace && Boolean(call[0]?.data?.delta),
        ),
      ).toBe(false);
    },
  );

  it("releases an ordinary phase-pending Completions prefix at text_end", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const message = {
      role: "assistant",
      api: "openai-completions",
      content: [{ type: "text", text: "Ordinary C" }],
    };

    handleMessageUpdate(context, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: "Ordinary C" },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_end" },
    } as never);

    expect(onAgentEvent.mock.calls.map((call) => call[0]?.data?.delta)).toEqual(["Ordinary ", "C"]);
    expect(context.state.lastStreamedAssistantCleaned).toBe("Ordinary C");
  });

  it("keeps independently classified Anthropic commentary blocks partitioned", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    context.resetAssistantMessageState = vi.fn(() => {
      context.state.deltaBuffer = "";
      context.state.lastStreamedCommentary = undefined;
      context.state.commentaryStreamedWithDelta = false;
      context.state.assistantDisplayPhasePending = false;
      context.state.lastAssistantStreamContentIndex = undefined;
      context.state.lastAssistantStreamItemId = undefined;
    });
    const block = (text: string, id?: string) => ({
      type: "text",
      text,
      ...(id ? { textSignature: JSON.stringify({ v: 1, id, phase: "commentary" }) } : {}),
    });
    const partial = (first: ReturnType<typeof block>, second: ReturnType<typeof block>) => ({
      role: "assistant",
      api: "anthropic-messages",
      content: [first, second],
    });
    const emit = (
      type: "text_delta" | "text_end",
      contentIndex: number,
      text: string,
      delta: string,
      eventPartial: ReturnType<typeof partial>,
    ) => {
      handleMessageUpdate(context, {
        type: "message_update",
        message: eventPartial,
        assistantMessageEvent: {
          type,
          contentIndex,
          ...(delta ? { delta } : { content: text }),
          partial: eventPartial,
        },
      } as never);
    };

    emit("text_delta", 0, "AB", "AB", partial(block("AB"), block("")));
    emit("text_delta", 1, "A", "A", partial(block("AB"), block("A")));
    emit("text_end", 0, "AB", "", partial(block("AB", "commentary-0"), block("A")));
    const finalMessage = partial(block("AB", "commentary-0"), block("A", "commentary-1"));
    emit("text_end", 1, "A", "", finalMessage);
    await handleMessageEnd(context, {
      type: "message_end",
      message: finalMessage,
    } as never);

    const commentaryEvents = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => (event as { data?: { phase?: string } }).data?.phase === "commentary");
    expect(commentaryEvents).toMatchObject([
      {
        stream: "assistant",
        data: {
          delta: "AB",
          phase: "commentary",
          itemId: "commentary-0",
        },
      },
      {
        stream: "assistant",
        data: {
          delta: "A",
          phase: "commentary",
          itemId: "commentary-1",
        },
      },
    ]);
  });

  it("does not replay deferred unclassified Anthropic blocks at text_end", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    context.resetAssistantMessageState = vi.fn(() => {
      context.state.deltaBuffer = "";
      context.state.lastStreamedAssistant = undefined;
      context.state.lastStreamedAssistantCleaned = undefined;
      context.state.lastStreamedCommentary = undefined;
      context.state.commentaryStreamedWithDelta = false;
      context.state.assistantDisplayPhasePending = false;
      context.state.lastAssistantStreamContentIndex = undefined;
      context.state.lastAssistantStreamItemId = undefined;
    });
    const partial = (first: string, second: string) => ({
      role: "assistant",
      api: "anthropic-messages",
      content: [
        { type: "text", text: first },
        { type: "text", text: second },
      ],
    });
    const emit = (
      type: "text_delta" | "text_end",
      contentIndex: number,
      text: string,
      delta: string,
      eventPartial: ReturnType<typeof partial>,
    ) => {
      handleMessageUpdate(context, {
        type: "message_update",
        message: eventPartial,
        assistantMessageEvent: {
          type,
          contentIndex,
          ...(delta ? { delta } : { content: text }),
          partial: eventPartial,
        },
      } as never);
    };

    emit("text_delta", 0, "AB", "AB", partial("AB", ""));
    emit("text_delta", 1, "A", "A", partial("AB", "A"));
    onAgentEvent.mockClear();
    emit("text_end", 0, "AB", "", partial("AB", "A"));
    emit("text_end", 1, "A", "", partial("AB", "A"));

    expect(onAgentEvent).not.toHaveBeenCalled();
  });

  it("keeps nested bracket delegate prefixes off the commentary event bus", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const createPartial = (text: string) =>
      createOpenAiResponsesPartial({
        text,
        id: "item-commentary",
        signaturePhase: "commentary",
        partialPhase: "commentary",
      });
    const prefix = "[[CONTINUE_DELEGATE: inspect [[foo]";

    for (const [text, delta] of [
      [prefix, prefix],
      [`${prefix}]`, "]"],
    ] as const) {
      const partial = createPartial(text);
      handleMessageUpdate(context, {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta,
          partial,
        },
      } as never);
    }

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(context.state.deltaBuffer).toBe("[[CONTINUE_DELEGATE: inspect [[foo]]");
  });

  it("prefers an enclosing delegate marker over a nested work-marker prefix", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const text = "[[CONTINUE_DELEGATE: inspect [[CONTINUE_WORK";
    const partial = createOpenAiResponsesPartial({
      text,
      id: "item-commentary",
      signaturePhase: "commentary",
      partialPhase: "commentary",
    });

    handleMessageUpdate(context, {
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial,
      },
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(context.state.deltaBuffer).toBe(text);
  });

  it.each(["[[CONTINUE_WORK", "[[CONTINUE_WORK:15"])(
    "keeps split bracketed work marker %s off the commentary event bus",
    (prefix) => {
      const onAgentEvent = vi.fn();
      const context = createMessageUpdateContext({ onAgentEvent });
      const createPartial = (text: string) =>
        createOpenAiResponsesPartial({
          text,
          id: "item-commentary",
          signaturePhase: "commentary",
          partialPhase: "commentary",
        });

      for (const [text, delta] of [
        [prefix, prefix],
        [`${prefix}]]`, "]]"],
      ] as const) {
        const partial = createPartial(text);
        handleMessageUpdate(context, {
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial,
          },
        } as never);
      }

      expect(onAgentEvent).not.toHaveBeenCalled();
      expect(context.state.deltaBuffer).toBe(`${prefix}]]`);
    },
  );

  it("flushes short false-positive commentary prefixes at item boundaries", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    context.resetAssistantMessageState = vi.fn(() => {
      context.state.deltaBuffer = "";
      context.state.lastStreamedCommentary = undefined;
      context.state.commentaryStreamedWithDelta = false;
      context.state.assistantDisplayPhasePending = false;
      context.state.lastAssistantStreamContentIndex = undefined;
      context.state.lastAssistantStreamItemId = undefined;
    });
    const firstPartial = createOpenAiResponsesPartial({
      text: "Ordinary C",
      id: "item-1",
      signaturePhase: "commentary",
      partialPhase: "commentary",
    });
    const secondPartial = createOpenAiResponsesPartial({
      text: "",
      id: "item-2",
      signaturePhase: "commentary",
      partialPhase: "commentary",
    });

    handleMessageUpdate(context, {
      type: "message_update",
      message: firstPartial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Ordinary C",
        partial: firstPartial,
      },
    } as never);
    handleMessageUpdate(context, {
      type: "message_update",
      message: secondPartial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 1,
        partial: secondPartial,
      },
    } as never);

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { delta: "Ordinary ", phase: "commentary", itemId: "item-1" },
      },
      {
        stream: "assistant",
        data: { delta: "C", phase: "commentary", itemId: "item-1" },
      },
    ]);
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
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial,
        },
      }) as never;

    updateMessage(context, createPhasedDelta("Hello"));
    updateMessage(context, createPhasedDelta(" world"));

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
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial,
        },
      }) as never;

    updateMessage(context, createPhasedDelta("Visible\n<tool_call>{"));
    updateMessage(
      context,
      createPhasedDelta('"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>'),
    );
    updateMessage(context, createPhasedDelta("\nDone."));

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
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial,
        },
      }) as never;

    updateMessage(context, createPhasedDelta("<tool_call>{"));
    updateMessage(
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

    updateMessage(context, {
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
    });

    expect(flushBlockReplyBuffer).toHaveBeenCalledWith({ assistantMessageIndex: 7 });
    expect(resetAssistantMessageState).toHaveBeenCalledWith(0, {
      preserveReplyDirectiveState: true,
    });
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

    updateMessage(context, {
      message: partial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 1,
        partial,
      },
    });
    updateMessage(context, {
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second block",
      },
    });

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

    updateMessage(context, {
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
    });

    expect(flushBlockReplyBuffer).toHaveBeenCalledTimes(1);
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

    updateMessage(context, {
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
    });

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

    updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: replyText,
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );
    updateMessage(
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
      pendingToolMediaUrls: ["/tmp/a.png", "/tmp/a.png", "/tmp/b.png"],
      pendingToolMediaAttachments: [
        { type: "image" as const, path: "/tmp/a.png", width: 640, height: 480 },
        { type: "image" as const, path: "/tmp/a.png", width: 1, height: 1 },
        { type: "image" as const, path: "/tmp/b.png", width: 800, height: 600 },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/a.png", true],
        ["/tmp/b.png", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      attachments: [
        {
          type: "image",
          path: "/tmp/a.png",
          width: 640,
          height: 480,
          trustedLocalMedia: true,
        },
        { type: "image", path: "/tmp/b.png", width: 800, height: 600 },
      ],
      audioAsVoice: undefined,
    });
    expect(state.pendingToolMediaUrls).toStrictEqual([]);
    expect(state.pendingToolMediaAttachments).toStrictEqual([]);
  });

  it("does not append queued image tool media when the reply already names media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.png"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/generated.png", true]]),
      pendingToolAudioAsVoice: false,
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
    expect(state.pendingToolMediaTrustByUrl.size).toBe(0);
  });

  it("retains queued metadata for explicitly selected media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.mp3", "/tmp/generated.mp3", "/tmp/unselected.mp3"],
      pendingToolMediaAttachments: [
        { type: "audio" as const, path: "/tmp/generated.mp3", durationMs: 2_000 },
        { type: "audio" as const, path: "/tmp/generated.mp3", durationMs: 9_999 },
        { type: "audio" as const, path: "/tmp/unselected.mp3", durationMs: 3_000 },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/generated.mp3", true],
        ["/tmp/unselected.mp3", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: [" /tmp/generated.mp3 "],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: [" /tmp/generated.mp3 "],
      attachments: [
        {
          type: "audio",
          path: "/tmp/generated.mp3",
          durationMs: 2_000,
          trustedLocalMedia: true,
        },
      ],
      trustedLocalMedia: true,
    });
    expect(state.pendingToolMediaAttachments).toStrictEqual([]);
  });

  it("does not trust an explicitly selected untrusted pending URL", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/generated.mp3", "/tmp/untrusted.mp3"],
      pendingToolMediaAttachments: [
        { type: "audio" as const, path: "/tmp/generated.mp3" },
        {
          type: "audio" as const,
          path: "/tmp/untrusted.mp3",
          trustedLocalMedia: true,
        },
      ],
      pendingToolMediaTrustByUrl: new Map([
        ["/tmp/generated.mp3", true],
        ["/tmp/untrusted.mp3", false],
      ]),
      pendingToolAudioAsVoice: false,
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
        mediaUrls: ["/tmp/untrusted.mp3"],
      }),
    ).toEqual({
      text: "done",
      mediaUrls: ["/tmp/untrusted.mp3"],
      attachments: [{ type: "audio", path: "/tmp/untrusted.mp3" }],
    });
  });

  it("does not append queued voice media when the reply already names media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/reply.opus"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", true]]),
      pendingToolAudioAsVoice: true,
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
    expect(state.pendingToolMediaTrustByUrl.size).toBe(0);
  });

  it("preserves reasoning replies without consuming queued media", () => {
    const state = {
      pendingToolMediaUrls: ["/tmp/a.png"],
      pendingToolMediaTrustByUrl: new Map([["/tmp/a.png", false]]),
      pendingToolAudioAsVoice: true,
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
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", false]]),
      pendingToolAudioAsVoice: true,
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
      pendingToolMediaTrustByUrl: new Map([["/tmp/reply.opus", false]]),
      pendingToolAudioAsVoice: true,
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

    updateMessage(
      ctx,
      createTextUpdateEvent({ type: "text_delta", text: "Need send.", messagePhase: "commentary" }),
    );
    updateMessage(
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

    updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Need send.",
        content: [commentaryBlock],
      }),
    );
    updateMessage(
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

    updateMessage(
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

    updateMessage(
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

    updateMessage(ctx, createTextUpdateEvent({ type: "text_end", text: "" }));

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    });
  });

  it("suppresses repeated validation-loop assistant stream text once a safe summary exists", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      state: {
        lastToolError: {
          toolName: "edit",
          validationErrorSummary: "edit tool validation failed: invalid arguments",
        },
      },
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: "Stopped after 2 identical failed edit tool calls.",
        delta: "Stopped after 2 identical failed edit tool calls.",
      }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: 'Validation failed for tool "edit": Received arguments: {}',
        delta: 'Validation failed for tool "edit": Received arguments: {}',
      }),
    );

    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.state)).not.toContain("Received arguments");
  });
});

describe("handleMessageEnd", () => {
  it("emits audio-only directives as message-end block replies", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => null),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[[audio_as_voice]]" }],
      },
    } as never);

    expect(emitBlockReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(emitBlockReply, "block reply")).toMatchObject({
      text: "",
      audioAsVoice: true,
    });
  });

  it.each(["answer part A msg [[E1008]timeout] answer part B", "answer ending ["])(
    "keeps malformed directive-looking final text identical across delivery paths: %s",
    (text) => {
      const onAgentEvent = vi.fn();
      const emitBlockReply = vi.fn();
      const flushBlockReplyBuffer = vi.fn();
      const accumulator = createStreamingDirectiveAccumulator();
      const streamed = accumulator.consume(text)?.text ?? "";
      const ctx = createMessageEndContext({
        onAgentEvent,
        emitBlockReply,
        flushBlockReplyBuffer,
        consumeReplyDirectives: vi.fn((chunk: string, options?: { final?: boolean }) =>
          accumulator.consume(chunk, options),
        ),
        blockChunker: {
          hasBuffered: () => true,
          reset: vi.fn(),
        },
        state: {
          blockBuffer: streamed,
          deltaBuffer: streamed,
        },
      });

      void endMessage(ctx, {
        message: { role: "assistant", content: [{ type: "text", text }] },
      });

      expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
        stream: "assistant",
        data: { text, delta: text },
      });
      const finalBlockText = (firstMockArg(emitBlockReply, "block reply") as { text?: string })
        .text;
      expect(`${streamed}${finalBlockText ?? ""}`).toBe(text);
      expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(expect.objectContaining({ text }));
    },
  );

  it("keeps exact NO_REPLY silent after a user-facing message send followed by sessions_send (#119383)", () => {
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      finalizeAssistantTexts,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
        messagingToolSentTexts: ["<user-facing reply>", "<internal escalation note>"],
        messagingToolSentTextsNormalized: ["<user-facing reply>", "<internal escalation note>"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "whatsapp",
            to: "user:123",
            text: "<user-facing reply>",
          },
        ],
      },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    });

    // The exact silent token must never be rewritten to the sessions_send body:
    // the final assistant text keeps NO_REPLY and no block reply carries the note.
    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    for (const call of emitBlockReply.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("<internal escalation note>");
    }
  });

  it("keeps exact NO_REPLY silent when only sessions_send delivered (#119383)", () => {
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      finalizeAssistantTexts,
      consumeReplyDirectives: vi.fn((text: string) => ({ text })),
      state: {
        blockBuffer: "",
        deltaBuffer: "",
        messagingToolSentTexts: ["<internal escalation note>"],
        messagingToolSentTextsNormalized: ["<internal escalation note>"],
        messagingToolSentTargets: [],
      },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    });

    expect(finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "NO_REPLY" }),
    );
    for (const call of emitBlockReply.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("<internal escalation note>");
    }
  });

  it.each([
    {
      name: "counts a completed provider assistant message",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      expected: 1,
    },
    {
      name: "ignores transcript-only mirrored assistant messages",
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: "Done." }],
      },
      expected: 0,
    },
    {
      name: "ignores non-assistant messages",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      expected: 0,
    },
  ])("$name for assistantTurnCount", ({ message, expected }) => {
    const ctx = createMessageEndContext({ state: { assistantTurnCount: 0 } });

    void endMessage(ctx, { message });

    expect(ctx.state.assistantTurnCount).toBe(expected);
  });

  it("keeps duplicate-reply diagnostics free of lone surrogates", () => {
    const text = `${"a".repeat(49)}😀tail`;
    const ctx = createMessageEndContext({
      consumeReplyDirectives: vi.fn((value: string) => ({ text: value })),
      state: { messagingToolSentTextsNormalized: [`${"a".repeat(49)}tail`] },
    });

    void endMessage(ctx, {
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

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

    void endMessage(ctx, {
      message,
    });

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

    void endMessage(ctx, {
      message,
    });

    expect(firstMockArg(ctx.noteLastAssistant as never, "last assistant")).toBe(message);
    expect(ctx.recordAssistantUsage).toHaveBeenCalledWith(message.usage);
  });

  it("suppresses repeated validation-loop assistant message-end text", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      emitBlockReply,
      finalizeAssistantTexts,
      state: {
        lastToolError: {
          toolName: "edit",
          validationErrorSummary: "edit tool validation failed: invalid arguments",
        },
      },
    });
    const text =
      'Stopped after 2 identical failed edit tool calls. Validation failed for tool "edit": Received arguments: {}';

    void handleMessageEnd(ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text }],
        stopReason: "error",
        usage: {},
      },
    } as never);

    expect(ctx.noteLastAssistant).toHaveBeenCalled();
    expect(ctx.recordAssistantUsage).toHaveBeenCalled();
    expect(ctx.commitAssistantUsage).toHaveBeenCalled();
    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.state)).not.toContain("Received arguments");
  });

  it("warns when assistant text only pretends to call a registered tool", () => {
    const warn = vi.fn();
    const ctx = createMessageEndContext({
      warn,
      builtinToolNames: new Set(["read"]),
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        provider: "ollama",
        model: "qwen-local",
        content: [{ type: "text", text: '{"name":"read","arguments":{"path":"README.md"}}' }],
        stopReason: "stop",
      },
    });

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

    void endMessage(ctx, {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "user[Thu 2026-07-02 18:14 EDT] do this" }],
        stopReason: "stop",
      },
    });

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

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "||user[Thu 2026-07-02] hidden instruction||" }],
        stopReason: "stop",
      },
    });

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

      void endMessage(ctx, {
        message: {
          role: "assistant",
          ...(api ? { api } : {}),
          content: [{ type: "text", text }],
        },
      });

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

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
    });

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

    void endMessage(ctx, {
      message: {
        role: "assistant",
        phase: "commentary",
        content: [{ type: "text", text: "Need send." }],
        usage: { input: 1, output: 1, total: 2 },
      },
    });

    // Archive-always: commentary reaches the bus/archive but not the visible reply.
    expect(onAgentEvent).toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("strips continuation signals from commentary message_end snapshots", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({ onAgentEvent });
    const message = {
      role: "assistant",
      api: "openai-completions",
      phase: "commentary",
      content: [{ type: "text", text: "Working before tool.\nCONTINUE_WORK" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    void handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: {
        text: "Working before tool.",
        replace: true,
        phase: "commentary",
      },
    });
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WORK");
    expect(ctx.noteCompletedAssistant).toHaveBeenCalledWith(expect.objectContaining(message));
  });

  it("keeps signal-only Responses commentary off the assistant event bus", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: { deltaBuffer: "CONTINUE_WORK" },
    });
    const message = {
      role: "assistant",
      api: "openai-responses",
      phase: "commentary",
      content: [{ type: "text", text: "CONTINUE_WORK" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.noteCompletedAssistant).toHaveBeenCalledWith(expect.objectContaining(message));
  });

  it("does not re-expose sensitive incomplete commentary markers at message_end", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        deltaBuffer: "Working before tool.\nCONTINUE_WOR",
        lastStreamedCommentary: "Working before tool.\n",
      },
    });
    const message = {
      role: "assistant",
      api: "openai-responses",
      phase: "commentary",
      content: [{ type: "text", text: "Working before tool.\nCONTINUE_WOR" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.noteCompletedAssistant).toHaveBeenCalledWith(expect.objectContaining(message));
  });

  it("releases short false-positive commentary prefixes as deltas at message_end", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        deltaBuffer: "Ordinary C",
        lastStreamedCommentary: "Ordinary ",
        commentaryStreamedWithDelta: true,
      },
    });
    const message = {
      role: "assistant",
      api: "openai-responses",
      phase: "commentary",
      content: [{ type: "text", text: "Ordinary C" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: {
        delta: "C",
        phase: "commentary",
      },
    });
  });

  it("retains Anthropic commentary item IDs when message_end releases a suffix", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        deltaBuffer: "Ordinary C",
        lastStreamedCommentary: "Ordinary ",
        commentaryStreamedWithDelta: true,
        lastAssistantStreamItemId: "anthropic-item",
      },
    });
    const message = {
      role: "assistant",
      api: "anthropic-messages",
      phase: "commentary",
      content: [{ type: "text", text: "Ordinary C" }],
      usage: { input: 1, output: 1, total: 2 },
    };

    await handleMessageEnd(ctx, {
      type: "message_end",
      message,
    } as never);

    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: {
        delta: "C",
        phase: "commentary",
        itemId: "anthropic-item",
      },
    });
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

    void endMessage(ctx, {
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
    });

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
        deliveredBlockReplyTexts: ["Hello world"],
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

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

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(emitBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Final answer" }),
      expect.objectContaining({ assistantMessageIndex: 7 }),
    );
  });

  it("corrects text_end block replies when canonical message_end text differs", () => {
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
        deliveredBlockReplyTexts: ["Hello world."],
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        // The raw text differs slightly from lastBlockReplyText due to stripping
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(emitBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello world" }),
      expect.objectContaining({ assistantMessageIndex: undefined }),
    );
  });

  it("emits final media and malformed pending text after an async buffered flush", async () => {
    const emitBlockReply = vi.fn();
    let resolveFlush: (() => void) | undefined;
    const flushBlockReplyBuffer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = () => {
            emitBlockReply({ mediaUrls: ["/tmp/final.png"] });
            ctx.state.lastDeliveredAssistantReplyDirectives = {
              mediaUrls: ["/tmp/final.png"],
            };
            resolve();
          };
        }),
    );
    const accumulator = createStreamingDirectiveAccumulator();
    const text = "[[reply_to_current]]\nCaption [[oops\nMEDIA:/tmp/final.png";
    const streamed = accumulator.consume("[[reply_to_current]]\nCaption")?.text ?? "";
    accumulator.consume(" [[oops\nMEDIA:/tmp/final.png");
    const consumeReplyDirectives = vi.fn((chunk: string, options?: { final?: boolean }) =>
      accumulator.consume(chunk, options),
    );
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
        lastStreamedAssistantCleaned: "Caption [[oops",
        blockReplyBreak: "message_end",
        deltaBuffer: streamed,
        blockBuffer: streamed,
      },
    });

    const pending = endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(flushBlockReplyBuffer).toHaveBeenCalledWith({
      assistantMessageIndex: undefined,
      final: true,
    });
    expect(emitBlockReply).not.toHaveBeenCalled();
    resolveFlush?.();
    await pending;
    expect(consumeReplyDirectives).toHaveBeenCalledWith("", { final: true });
    const replies = emitBlockReply.mock.calls.map(
      ([reply]) =>
        reply as {
          text?: string;
          mediaUrls?: string[];
          replyToCurrent?: boolean;
        },
    );
    const finalReply = replies.at(-1);
    if (!finalReply) {
      throw new Error("Expected final block reply");
    }
    expect(finalReply).toMatchObject({
      text: "Caption [[oops",
      mediaUrls: undefined,
      replyToCurrent: true,
    });
    expect(replies.flatMap((reply) => reply.mediaUrls ?? [])).toEqual(["/tmp/final.png"]);
    expect(replies.map((reply) => reply.text ?? "").join("")).not.toContain("MEDIA:");
  });

  it("does not re-emit final media already delivered at text_end", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => null),
      state: {
        blockReplyBreak: "text_end",
        blockBuffer: "",
        deltaBuffer: "",
        lastBlockReplyText: "Caption",
        lastDeliveredAssistantReplyDirectives: {
          mediaUrls: ["/tmp/final.png"],
        },
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

    expect(emitBlockReply).not.toHaveBeenCalled();
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

    void endMessage(ctx, {
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
    });

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
        assistantTexts: ["Hello world"],
        assistantTextBaseline: 0,
        blockReplyBreak: "text_end",
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: "Hello world",
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(stripBlockTags).toHaveBeenCalledWith(
      "Hello world",
      { thinking: false, final: false },
      { final: true },
    );
    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({ text: "", reconcileCurrentMessage: true }),
    );
  });

  it("preserves reply-target-only streamed text as terminal evidence without delivering it", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => null),
      state: {
        assistantTexts: ["[[reply_to_current]]"],
        assistantTextBaseline: 0,
        blockReplyBreak: "text_end",
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[[reply_to_current]]" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "[[reply_to_current]]",
        addedDuringMessage: true,
        reconcileCurrentMessage: false,
      }),
    );
  });

  it("does not retain reaction-only text as reply-target terminal evidence", () => {
    const emitBlockReply = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      consumeReplyDirectives: vi.fn(() => null),
      state: {
        assistantTexts: ["[[react_to_current:✅]]"],
        assistantTextBaseline: 0,
        blockReplyBreak: "text_end",
        blockBuffer: "",
        deltaBuffer: "",
      },
    });

    void endMessage(ctx, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[[react_to_current:✅]]" }],
        usage: { input: 10, output: 5, total: 15 },
      },
    });

    expect(ctx.emitAssistantStreamData).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.finalizeAssistantTexts).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        addedDuringMessage: true,
        reconcileCurrentMessage: true,
      }),
    );
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

    void endMessage(ctx, {
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
    });

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
