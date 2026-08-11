import { describe, expect, it, vi } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { handleMessageEnd } from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { handleMessageUpdate as handleMessageUpdateImpl } from "./embedded-agent-subscribe.handlers.messages.update.js";
import {
  createMessageUpdateContext,
  firstMockArg,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

function handleMessageUpdate(...args: Parameters<typeof handleMessageUpdateImpl>): void {
  void handleMessageUpdateImpl(...args);
}

describe("handleMessageUpdate text signatures", () => {
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
