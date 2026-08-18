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
type BlockReplyPayload = {
  text?: string;
  audioAsVoice?: boolean;
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

function requireBlockReplyPayload(onBlockReply: ReturnType<typeof vi.fn>): BlockReplyPayload {
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

describe("continuation Responses reconciliation", () => {
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
      outcome: {
        status: "completed",
        willRetry: true,
        summary: "retry",
        tokensBefore: 200,
        tokensAfter: 100,
      },
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
});
