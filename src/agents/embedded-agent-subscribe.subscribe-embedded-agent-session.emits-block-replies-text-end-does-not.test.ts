// Text-end block reply tests cover streamed block delivery, message_end
// de-duplication, and OpenAI Responses phase handling.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
  type OpenAiResponsesTextEventPhase,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

type TextEndBlockReplyHarness = ReturnType<typeof createTextEndBlockReplyHarness>;
type OnBlockReplyMock = ReturnType<typeof vi.fn>;
type BlockReplyPayload = {
  text?: string;
  audioAsVoice?: boolean;
  replyToCurrent?: boolean;
};

function emitOpenAiResponsesTextEvent(params: {
  emit: TextEndBlockReplyHarness["emit"];
  type: "text_delta" | "text_end";
  text: string;
  delta?: string;
  id: string;
  signaturePhase?: OpenAiResponsesTextEventPhase;
  partialPhase?: OpenAiResponsesTextEventPhase;
}) {
  // Responses events carry item ids and phase signatures; tests preserve those
  // fields so commentary/final routing matches provider payloads.
  const { emit, ...eventParams } = params;
  emit(createOpenAiResponsesTextEvent(eventParams));
}

function emitOpenAiResponsesTextDeltaAndEnd(params: {
  emit: TextEndBlockReplyHarness["emit"];
  text: string;
  delta?: string;
  id: string;
  phase?: OpenAiResponsesTextEventPhase;
}) {
  const { phase, ...eventParams } = params;
  emitOpenAiResponsesTextEvent({
    ...eventParams,
    type: "text_delta",
    signaturePhase: phase,
    partialPhase: phase,
  });
  emitOpenAiResponsesTextEvent({
    ...eventParams,
    type: "text_end",
    delta: undefined,
    signaturePhase: phase,
    partialPhase: phase,
  });
}

function emitOpenAiResponsesFinalMessageEnd(params: {
  emit: TextEndBlockReplyHarness["emit"];
  commentaryText: string;
  finalText: string;
}) {
  params.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        createOpenAiResponsesTextBlock({
          text: params.commentaryText,
          id: "item_commentary",
          phase: "commentary",
        }),
        createOpenAiResponsesTextBlock({
          text: params.finalText,
          id: "item_final",
          phase: "final_answer",
        }),
      ],
    } as AssistantMessage,
  });
}

async function emitSuppressedCommentary(params: {
  emit: TextEndBlockReplyHarness["emit"];
  text: string;
}) {
  // Commentary can stream before final_answer; this helper proves suppressed
  // commentary does not count as a delivered block.
  params.emit({ type: "message_start", message: { role: "assistant" } });
  emitOpenAiResponsesTextDeltaAndEnd({
    emit: params.emit,
    text: params.text,
    id: "item_commentary",
    phase: "commentary",
  });
  await Promise.resolve();
}

function expectSingleBlockReplyText(params: {
  onBlockReply: OnBlockReplyMock;
  subscription: TextEndBlockReplyHarness["subscription"];
  text: string;
}) {
  expect(params.onBlockReply).toHaveBeenCalledTimes(1);
  expect(requireBlockReplyPayload(params.onBlockReply).text).toBe(params.text);
  expect(params.subscription.assistantTexts).toEqual([params.text]);
}

function requireBlockReplyPayload(onBlockReply: OnBlockReplyMock): BlockReplyPayload {
  // Most cases expect exactly one user-visible block reply.
  const call = onBlockReply.mock.calls[0];
  if (!call) {
    throw new Error("expected first block reply call");
  }
  const payload = call[0];
  if (!payload || typeof payload !== "object") {
    throw new Error("expected first block reply payload");
  }
  return payload as BlockReplyPayload;
}

describe("subscribeEmbeddedAgentSession", () => {
  it("emits block replies on text_end and does not duplicate on message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    const payload = requireBlockReplyPayload(onBlockReply);
    expect(payload?.text).toBe("Hello block");
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("reconciles canonical message_end text and audio metadata after text_end", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Hello");

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world [[audio_as_voice]]" }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    const correction = onBlockReply.mock.calls[1]?.[0] as BlockReplyPayload | undefined;
    expect(correction).toEqual(expect.objectContaining({ text: " world", audioAsVoice: true }));
    expect(JSON.stringify(onAgentEvent.mock.calls)).toContain("Hello world");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("audio_as_voice");
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it.each([
    {
      name: "audio",
      directive: "[[audio_as_voice]]",
      expected: { text: "", audioAsVoice: true },
    },
    {
      name: "reply target",
      directive: "[[reply_to_current]]",
      expected: { text: "Hello", replyToCurrent: true },
    },
  ])("delivers final-only $name metadata after text_end", async ({ directive, expected }) => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello" });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Hello ${directive}` }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]?.[0]).toEqual(expect.objectContaining(expected));
    expect(subscription.assistantTexts).toEqual(["Hello"]);
  });

  it("does not re-emit audio metadata already delivered at text_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });
    const answer = "Hello [[audio_as_voice]]";

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: answer });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        text: "Hello",
        audioAsVoice: true,
      }),
    );

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello"]);
  });

  it("retains delivered metadata across Responses final-answer item boundaries", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Hello [[audio_as_voice]]",
      id: "item-final-1",
      phase: "final_answer",
    });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Second",
      id: "item-final-2",
      phase: "final_answer",
    });
    await subscription.waitForPendingEvents();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Hello [[audio_as_voice]]",
            id: "item-final-1",
            phase: "final_answer",
          }),
          createOpenAiResponsesTextBlock({
            text: "Second",
            id: "item-final-2",
            phase: "final_answer",
          }),
        ],
      } as AssistantMessage,
    });
    await subscription.waitForPendingEvents();

    const audioReplies = onBlockReply.mock.calls.filter(
      ([payload]) => (payload as BlockReplyPayload | undefined)?.audioAsVoice === true,
    );
    expect(audioReplies).toHaveLength(1);
    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as BlockReplyPayload | undefined)?.text),
    ).toEqual(["Hello", "Second"]);
    expect(subscription.assistantTexts).toEqual(["Hello", "Second"]);
  });

  it("waits for an in-flight Responses item before canonical finalization", async () => {
    let resolveFirstReply: (() => void) | undefined;
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstReply = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "First [[audio_as_voice]]",
      id: "item-final-1",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "Second",
      id: "item-final-2",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "First [[audio_as_voice]]",
            id: "item-final-1",
            phase: "final_answer",
          }),
          createOpenAiResponsesTextBlock({
            text: "Second",
            id: "item-final-2",
            phase: "final_answer",
          }),
        ],
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    resolveFirstReply?.();
    await subscription.waitForPendingEvents();

    const audioReplies = onBlockReply.mock.calls.filter(
      ([payload]) => (payload as BlockReplyPayload | undefined)?.audioAsVoice === true,
    );
    expect(audioReplies).toHaveLength(1);
    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as BlockReplyPayload | undefined)?.text),
    ).toEqual(["First", "Second"]);
    expect(onBlockReply.mock.calls.map((call) => call[1]?.assistantMessageIndex)).toEqual([1, 2]);
    expect(subscription.assistantTexts).toEqual(["First", "Second"]);
  });

  it("does not replay an in-flight Responses boundary after compaction invalidation", async () => {
    let resolveFirstReply: (() => void) | undefined;
    const onBlockReply = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstReply = resolve;
          }),
      )
      .mockImplementation(() => undefined);
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "First",
      id: "item-final-1",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "Second",
      id: "item-final-2",
      signaturePhase: "final_answer",
      partialPhase: "final_answer",
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "First",
            id: "item-final-1",
            phase: "final_answer",
          }),
          createOpenAiResponsesTextBlock({
            text: "Second",
            id: "item-final-2",
            phase: "final_answer",
          }),
        ],
      } as AssistantMessage,
    });
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "compaction_start" });
    emit({
      type: "compaction_end",
      willRetry: true,
      result: { summary: "retry", tokensAfter: 100 },
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "New" });
    emitAssistantTextEnd({ emit });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as BlockReplyPayload | undefined)?.text),
    ).toEqual(["First", "New"]);
    resolveFirstReply?.();
  });

  it("does not collapse identical Responses final-answer items", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Yes",
      id: "item-final-1",
      phase: "final_answer",
    });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Yes",
      id: "item-final-2",
      phase: "final_answer",
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Yes",
            id: "item-final-1",
            phase: "final_answer",
          }),
          createOpenAiResponsesTextBlock({
            text: "Yes",
            id: "item-final-2",
            phase: "final_answer",
          }),
        ],
      } as AssistantMessage,
    });
    await subscription.waitForPendingEvents();

    expect(
      onBlockReply.mock.calls.map(([payload]) => (payload as BlockReplyPayload | undefined)?.text),
    ).toEqual(["Yes", "Yes"]);
    expect(subscription.assistantTexts).toEqual(["Yes", "Yes"]);
  });

  it("hides complete continuation markers during Responses final-answer streaming", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      onAgentEvent,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Done.\nCONTINUE_WORK",
      id: "item-final",
      phase: "final_answer",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Done.");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WORK");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });

  it.each([
    {
      name: "audio",
      directive: "[[audio_as_voice]]",
      expected: { text: "", audioAsVoice: true },
    },
    {
      name: "media",
      directive: "MEDIA:/tmp/final.png",
      expected: { text: "", mediaUrls: ["/tmp/final.png"] },
    },
  ])(
    "removes stale assistant text for canonical $name-only output",
    async ({ directive, expected }) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta({ emit, delta: "Hello" });
      emitAssistantTextEnd({ emit });
      await Promise.resolve();

      expect(subscription.assistantTexts).toEqual(["Hello"]);

      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: directive }],
        } as AssistantMessage,
      });
      await Promise.resolve();

      expect(onBlockReply).toHaveBeenCalledTimes(2);
      expect(onBlockReply.mock.calls[1]?.[0]).toEqual(expect.objectContaining(expected));
      expect(subscription.assistantTexts).toEqual([]);
    },
  );

  it("hides continuation markers that terminate earlier final-answer items", async () => {
    const onBlockReply = vi.fn();
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      onAgentEvent,
    });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          createOpenAiResponsesTextBlock({
            text: "Done.\nCONTINUE_WORK",
            id: "item_final_1",
            phase: "final_answer",
          }),
          createOpenAiResponsesTextBlock({
            text: "Warning: cleanup remains.",
            id: "item_final_2",
            phase: "final_answer",
          }),
        ],
      } as AssistantMessage,
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Done.\nWarning: cleanup remains.");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WORK");
    expect(subscription.assistantTexts).toEqual(["Done.\nWarning: cleanup remains."]);
  });

  it("message_end block-replies visible text when text_end streamed only silent NO_REPLY chunks", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit, content: "NO_REPLY" });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final visible reply." }],
      } as AssistantMessage,
    });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Final visible reply.");
    expect(subscription.assistantTexts).toEqual(["Final visible reply."]);
  });

  it("does not duplicate when message_end flushes and a late text_end arrives", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });

    emitAssistantTextDelta({ emit, delta: "Hello block" });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello block" }],
    } as AssistantMessage;

    // Simulate a provider that ends the message without emitting text_end.
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);

    // Some providers can still emit a late text_end; this must not re-emit.
    emitAssistantTextEnd({ emit, content: "Hello block" });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });

  it("emits legacy structured partials on text_end without waiting for message_end", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "Legacy answer",
      id: "item_legacy",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_end",
      text: "Legacy answer",
      id: "item_legacy",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Legacy answer");
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Legacy answer" }],
      } as AssistantMessage,
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Legacy answer"]);
  });

  it("suppresses commentary block replies until a final answer is available", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    await emitSuppressedCommentary({ emit, text: "Working..." });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toStrictEqual([]);

    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Done.",
      id: "item_final",
      phase: "final_answer",
    });
    await Promise.resolve();

    emitOpenAiResponsesFinalMessageEnd({ emit, commentaryText: "Working...", finalText: "Done." });

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Done." });
  });

  it("emits the full final answer on text_end when it extends suppressed commentary", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Hello",
      id: "item_commentary",
      phase: "commentary",
    });
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();

    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Hello world",
      delta: " world",
      id: "item_final",
      phase: "final_answer",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Hello world");
    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });

  it("does not defer final_answer text_end when phase exists only in textSignature", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_delta",
      text: "Done.",
      id: "item_final",
      signaturePhase: "final_answer",
    });
    emitOpenAiResponsesTextEvent({
      emit,
      type: "text_end",
      text: "Done.",
      id: "item_final",
      signaturePhase: "final_answer",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(requireBlockReplyPayload(onBlockReply).text).toBe("Done.");
    expect(subscription.assistantTexts).toEqual(["Done."]);
  });

  it("emits the final answer at message_end when commentary was streamed first", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    await emitSuppressedCommentary({ emit, text: "Working..." });

    emitOpenAiResponsesFinalMessageEnd({ emit, commentaryText: "Working...", finalText: "Done." });

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Done." });
  });
});
