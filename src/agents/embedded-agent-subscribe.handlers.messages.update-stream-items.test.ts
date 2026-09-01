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
// #122476: a streamed lone `N` may still grow into `NO_REPLY`, so it is held
// silent mid-stream and only released as ordinary text at terminal completion.
// An exact `NO_REPLY` stays silent through both delta and text_end. Drives the
// real handleMessageUpdate -> streaming accumulator path (agent->gateway event
// boundary), not just the pure classifier.
describe("lone N silent-reply lead fragment", () => {
  const createDelta = (delta: string) =>
    ({
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta },
    }) as never;

  const createContext = () => {
    const onAgentEvent = vi.fn();
    const accumulator = createStreamingDirectiveAccumulator();
    const context = createMessageUpdateContext({
      onAgentEvent,
      consumePartialReplyDirectives: vi.fn((text: string, options?: { final?: boolean }) =>
        accumulator.consume(text, options),
      ),
    });
    return { onAgentEvent, context };
  };

  it("holds a streamed N without emitting it, then releases it at text_end", () => {
    const { onAgentEvent, context } = createContext();

    // `N` is not a directive tail (unlike `M`), so it reaches the silent-prefix
    // check: held pending, no assistant visible-text event carries it mid-stream.
    updateMessage(context, createDelta("N"));
    expect(onAgentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({ text: "N" }),
      }),
    );

    // Terminal completion with a lone non-exact N: released as ordinary text,
    // not dropped as a silent token.
    updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_end", content: "N" },
    });
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({ text: "N" }),
      }),
    );
  });

  it("keeps an exact NO_REPLY silent across delta and text_end", () => {
    const { onAgentEvent, context } = createContext();

    updateMessage(context, createDelta("NO_REPLY"));
    updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_end", content: "NO_REPLY" },
    });
    // An exact silent token is suppressed at every stage, so no assistant
    // visible-text event carries it.
    expect(onAgentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({ text: "NO_REPLY" }),
      }),
    );
  });
});
