import { describe, expect, it, vi } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("handleMessageUpdate text signatures", () => {
  it("emits a commentary snapshot when Anthropic text is classified after deltas", async () => {
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

    await updateMessage(context, {
      message: {
        role: "assistant",
        api: "anthropic-messages",
        content: [{ type: "text", text: narration }],
      },
      assistantMessageEvent: { type: "text_delta", delta: narration },
    });
    await updateMessage(context, {
      message: { role: "assistant", api: "anthropic-messages", content: [] },
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

  it.each([
    {
      name: "ordinary text",
      chunks: ["Hello", " world"],
      updates: [
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ],
    },
    {
      name: "held whitespace",
      chunks: ["  Hello ", "world", "\n\n", "Next"],
      updates: [
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
        { text: "Hello world\n\nNext", delta: "\n\nNext" },
      ],
    },
    {
      name: "user-visible sanitizer",
      chunks: [
        "Visible\n<tool_call>{",
        '"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>',
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },
    {
      name: "initially hidden tool call",
      chunks: [
        "<tool_call>{",
        '"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>\nDone.',
      ],
      updates: [{ text: "Done.", delta: "Done." }],
    },
  ])("uses append events for same-item phased streams ($name)", async ({ chunks, updates }) => {
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

    for (const chunk of chunks) {
      await updateMessage(context, createPhasedDelta(chunk));
    }

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
      updates.map((data) => ({
        stream: "assistant",
        data: { ...data, replace: undefined, phase: "final_answer" },
      })),
    );
  });

  it.each(["Hello", ""])(
    "replaces a phased reply with the final snapshot %j",
    async (finalText) => {
      const onAgentEvent = vi.fn();
      const context = createMessageUpdateContext({ onAgentEvent });
      for (const event of [
        { type: "text_delta" as const, text: "Hello world", delta: "Hello world" },
        { type: "text_delta" as const, text: "", delta: "" },
        { type: "text_end" as const, text: finalText },
      ]) {
        const pending = updateMessage(
          context,
          createTextUpdateEvent({
            ...event,
            id: "item-final",
            signaturePhase: "final_answer",
            partialPhase: "final_answer",
          }),
        );
        if (event.type === "text_delta") {
          expect(onAgentEvent).toHaveBeenCalledTimes(1);
        }
        await pending;
      }

      expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
        {
          stream: "assistant",
          data: { text: "Hello world", delta: "Hello world", replace: undefined },
        },
        { stream: "assistant", data: { text: finalText, delta: "", replace: true } },
      ]);
      expect(context.blockChunker.bufferedText).toBe(finalText);
    },
  );

  it("treats phased textSignature item changes as assistant-message boundaries", async () => {
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

    const pending = updateMessage(context, {
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
    await pending;
  });

  it("does not replay a deferred item snapshot before its first delta", async () => {
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

    const startPending = updateMessage(context, {
      message: partial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 1,
        partial,
      },
    });
    const deltaPending = updateMessage(context, {
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
    await Promise.all([startPending, deltaPending]);
  });

  it("keeps same-block OpenAI Responses snapshot extensions in one assistant message", async () => {
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

    const pending = updateMessage(context, {
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

    expect(flushBlockReplyBuffer.mock.calls).toEqual([[{ assistantMessageIndex: 0, final: true }]]);
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
    await pending;
  });

  it("scopes item-id fallback boundaries to the matching signed block", async () => {
    const onPartialReply = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const context = createMessageUpdateContext({
      onPartialReply,
      resetAssistantMessageState,
      state: { lastAssistantStreamItemId: "item-1" },
    });

    await updateMessage(context, {
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

  it("preserves phase-aware voice and reply directives while deferring final media delivery", async () => {
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

    await updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_delta",
        text: replyText,
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );
    await updateMessage(
      ctx,
      createTextUpdateEvent({
        type: "text_end",
        text: replyText,
        id: "item-final",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
      }),
    );

    expect(ctx.blockChunker.bufferedText).toBe("Done.");
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
