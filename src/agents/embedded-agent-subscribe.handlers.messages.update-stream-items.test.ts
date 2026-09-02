import { describe, expect, it, vi } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import {
  createMessageUpdateContext,
  endMessage,
  firstMockArg,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("handleMessageUpdate text signatures", () => {
  it("emits the full incrementally extracted reasoning value on every delta", async () => {
    const emitReasoningStream = vi.fn();
    const context = createMessageUpdateContext({ emitReasoningStream });

    for (const chunk of ["<thi", "nk>reason", "ing</think>"]) {
      await updateMessage(
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

  it.each([
    {
      name: "a held word separator",
      chunks: ["Hello ", "world"],
      replies: [
        ["Hello", "Hello"],
        ["Hello world", " world"],
      ],
    },
    {
      name: "leading Unicode space and held paragraph breaks",
      chunks: ["\u2003Hello ", "world", "\n\n", "Next"],
      replies: [
        ["Hello", "Hello"],
        ["Hello world", " world"],
        ["Hello world\n\nNext", "\n\nNext"],
      ],
    },
    {
      name: "small append deltas followed by trailing whitespace",
      chunks: ["Hello", " world ", "next", "\u00a0"],
      replies: [
        ["Hello", "Hello"],
        ["Hello world", " world"],
        ["Hello world next", " next"],
      ],
    },
  ])("uses incremental unphased Responses deltas with $name", async ({ chunks, replies }) => {
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

    let text = "";
    for (const delta of chunks) {
      text += delta;
      await updateMessage(context, createNonPhaseEvent(text, delta));
    }

    expect(stripBlockTags.mock.calls.map(([value]) => value)).toEqual(chunks);
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
      replies.map(([value, delta]) => ({ stream: "assistant", data: { text: value, delta } })),
    );
  });

  it("treats unphased OpenAI Responses content-index changes as message boundaries", async () => {
    const flushBlockReplyBuffer = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      onPartialReply,
      state: {
        deltaBuffer: "First block",
        assistantStream: { raw: "First block", text: "First block" },
        lastAssistantStreamContentIndex: 0,
      },
    });
    const resetAssistantMessageState = vi.fn(() => {
      context.state.deltaBuffer = "";
      context.state.assistantStream = undefined;
    });
    context.resetAssistantMessageState = resetAssistantMessageState;
    context.params.onAssistantMessageStart = onAssistantMessageStart;

    const pending = updateMessage(context, {
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

    expect(flushBlockReplyBuffer.mock.calls).toEqual([
      [{ assistantMessageIndex: 0 }],
      [{ assistantMessageIndex: 0, final: true }],
    ]);
    expect(resetAssistantMessageState).toHaveBeenCalledTimes(1);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "First block", delta: "First block" }),
    );
    expect(context.blockChunker.bufferedText).toBe("First block");
    expect(context.state.lastAssistantStreamContentIndex).toBe(1);
    await pending;
  });

  it("holds incomplete streaming directive tails without emitting them as text", async () => {
    const onAgentEvent = vi.fn();
    const accumulator = createStreamingDirectiveAccumulator();
    const context = createMessageUpdateContext({
      onAgentEvent,
      consumePartialReplyDirectives: vi.fn((text: string, options?: { final?: boolean }) =>
        accumulator.consume(text, options),
      ),
    });

    for (const text of ["Hello\n", "M"]) {
      await updateMessage(context, createTextUpdateEvent({ type: "text_delta", text }));
    }

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(firstMockArg(onAgentEvent, "agent event")).toMatchObject({
      stream: "assistant",
      data: { text: "Hello", delta: "Hello" },
    });
    expect(context.state.assistantStream?.text).toBe("Hello");
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
  ])("keeps literal final text when $name", async ({ text, hasParsedDirectives }) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({
      onAgentEvent,
      ...(hasParsedDirectives ? {} : { consumePartialReplyDirectives: vi.fn(() => null) }),
    });

    await updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_end", content: text },
    });

    expect(context.state.assistantStream?.text).toBe(text);
    expect(firstMockArg(onAgentEvent, "final assistant event")).toMatchObject({
      stream: "assistant",
      data: { text },
    });
  });

  it("keeps stripped reply directives out of later plain deltas", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    for (const text of ["[[reply_to_current]]\nHello", " world"]) {
      await updateMessage(context, createTextUpdateEvent({ type: "text_delta", text }));
    }

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

  it("does not expose complete legacy media directives on plain deltas", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    await updateMessage(context, {
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

  it("uses full partial text for suffix deltas after a suppressed commentary item", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    await updateMessage(
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
    await updateMessage(
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
        data: {
          text: "Hello",
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: "item-commentary",
        },
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

    for (const event of [
      { type: "text_start", partial: startPartial },
      { type: "text_delta", delta: "Work", partial: startPartial },
      { type: "text_delta", delta: "ing...", partial: finalPartial },
      { type: "text_end", content: "Working...", partial: finalPartial },
    ] as const) {
      await updateMessage(context, {
        message: event.partial,
        assistantMessageEvent: { ...event, contentIndex: 0 },
      });
    }
    await endMessage(context, {
      message: finalPartial,
    });

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: {
          text: "Work",
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: "item-commentary",
        },
      },
      {
        stream: "assistant",
        data: {
          text: "Working...",
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: "item-commentary",
        },
      },
    ]);
    expect(context.state.deltaBuffer).toBe("Working...");
    expect(context.blockChunker.bufferedText).toBe("");
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

    for (const event of [
      { type: "text_start", partial: firstPartial },
      { type: "text_end", content: "Working", partial: firstPartial },
      { type: "text_end", content: "Working now", partial: extendedPartial },
    ] as const) {
      await updateMessage(context, {
        message: event.partial,
        assistantMessageEvent: { ...event, contentIndex: 0 },
      });
    }
    await endMessage(context, { message: extendedPartial });

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: {
          text: "Working",
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: "item-1",
        },
      },
      {
        stream: "assistant",
        data: {
          text: "Working now",
          delta: "",
          replace: true,
          phase: "commentary",
          itemId: "item-1",
        },
      },
    ]);
    expect(context.state.lastAssistantStreamItemId).toBe("item-1");
    expect(context.state.deltaBuffer).toBe("Working now");
  });
});

describe("handleMessageUpdate reasoning stream control for reasoning-capable models", () => {
  it("opens reasoning stream on text_start for reasoning-capable model with implicit thinkingLevel fallback", async () => {
    // Issue #134662: Reasoning-capable models fall back to medium thinking without explicit negotiation.
    // When thinkingLevel falls back implicitly (not via thinking_start event), ensure reasoning stream
    // is still opened to prevent reasoning leakage into visible message content.
    const openReasoningStream = vi.fn();
    const emitReasoningStream = vi.fn();
    const stripBlockTags = vi.fn((text: string) => text);
    const context = createMessageUpdateContext({
      emitReasoningStream,
      stripBlockTags,
      state: {
        reasoningStreamOpen: false,
      },
    });
    // Add openReasoningStream mock to context
    (context as unknown as Record<string, unknown>).openReasoningStream = openReasoningStream;

    // Simulate a reasoning-capable model (e.g., ollama/glm-5.3:cloud) with implicit thinkingLevel fallback
    // The session has thinkingLevel set to "medium" via fallback, but no thinking_start event was fired
    (context.params as unknown as Record<string, unknown>).catalog = [
      { provider: "ollama", id: "glm-5.3:cloud", reasoning: true },
    ];
    (context.params.session as unknown as Record<string, unknown>) = {
      provider: "ollama",
      model: "glm-5.3:cloud",
      thinkingLevel: "medium", // Implicitly set via fallback, not explicit configuration
      modelCatalogEntry: { provider: "ollama", id: "glm-5.3:cloud", reasoning: true },
    };

    // Simulate text_start event without prior thinking_start event
    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_start",
        text: "<thinking>Let me solve this step by step...</thinking>Hello!",
        delta: "",
      }),
    );

    // Reasoning stream should be opened on text_start for reasoning-capable models
    expect(openReasoningStream).toHaveBeenCalled();
  });

  it("opens reasoning stream when reasoning tags are detected in chunk for reasoning-capable model", async () => {
    // Issue #134662: Ensure reasoning stream is opened even when thinking_start event is missing
    // but reasoning tags are detected in the text chunk
    const openReasoningStream = vi.fn();
    const emitReasoningStream = vi.fn();
    const stripBlockTags = vi.fn((text: string, state: Record<string, unknown>) => {
      // Simulate stripBlockTags detecting and processing reasoning tags
      if (text.includes("<thinking>")) {
        state.thinking = true;
      }
      return text.replace(/<\/?thinking>/g, "");
    });
    const context = createMessageUpdateContext({
      emitReasoningStream,
      stripBlockTags,
      state: {
        reasoningStreamOpen: false,
        partialBlockState: { thinking: false, final: false, inlineCode: { open: false } },
      },
    });
    (context as unknown as Record<string, unknown>).openReasoningStream = openReasoningStream;

    (context.params as unknown as Record<string, unknown>).catalog = [
      { provider: "ollama", id: "glm-5.3:cloud", reasoning: true },
    ];
    (context.params.session as unknown as Record<string, unknown>) = {
      provider: "ollama",
      model: "glm-5.3:cloud",
      thinkingLevel: "medium",
      modelCatalogEntry: { provider: "ollama", id: "glm-5.3:cloud", reasoning: true },
    };

    // Simulate text_delta with reasoning tags
    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_delta",
        text: "<thinking>Solving...</thinking>Answer",
        delta: "<thinking>Solving...</thinking>Answer",
      }),
    );

    // Reasoning stream should be opened when tags are detected
    expect(openReasoningStream).toHaveBeenCalled();
  });

  it("does not open reasoning stream for non-reasoning model", async () => {
    // Verify that non-reasoning models are not affected by the fix
    const openReasoningStream = vi.fn();
    const emitReasoningStream = vi.fn();
    const stripBlockTags = vi.fn((text: string) => text);
    const context = createMessageUpdateContext({
      emitReasoningStream,
      stripBlockTags,
      state: {
        reasoningStreamOpen: false,
      },
    });
    (context as unknown as Record<string, unknown>).openReasoningStream = openReasoningStream;

    // Non-reasoning model
    (context.params.catalog as unknown) = [{ provider: "openai", id: "gpt-4o", reasoning: false }];
    (context.params.session as unknown as Record<string, unknown>) = {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "off",
      modelCatalogEntry: { provider: "openai", id: "gpt-4o", reasoning: false },
    };

    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_start",
        text: "Hello!",
        delta: "",
      }),
    );

    // Reasoning stream should not be opened for non-reasoning models
    expect(openReasoningStream).not.toHaveBeenCalled();
  });

  it("does not open reasoning stream when thinkingLevel is 'off'", async () => {
    // Verify that reasoning-capable models with thinkingLevel='off' don't trigger the fix
    const openReasoningStream = vi.fn();
    const emitReasoningStream = vi.fn();
    const stripBlockTags = vi.fn((text: string) => text);
    const context = createMessageUpdateContext({
      emitReasoningStream,
      stripBlockTags,
      state: {
        reasoningStreamOpen: false,
      },
    });
    (context as unknown as Record<string, unknown>).openReasoningStream = openReasoningStream;

    (context.params.catalog as unknown) = [
      { provider: "ollama", id: "glm-5.3:cloud", reasoning: true },
    ];
    (context.params.session as unknown as Record<string, unknown>) = {
      provider: "ollama",
      model: "glm-5.3:cloud",
      thinkingLevel: "off", // Explicitly disabled
      modelCatalogEntry: { provider: "ollama", id: "glm-5.3:cloud", reasoning: true },
    };

    await updateMessage(
      context,
      createTextUpdateEvent({
        type: "text_start",
        text: "Hello!",
        delta: "",
      }),
    );

    // Reasoning stream should not be opened when thinking is disabled
    expect(openReasoningStream).not.toHaveBeenCalled();
  });
});
