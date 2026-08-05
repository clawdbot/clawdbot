// Text-end delivery, snapshot reconciliation, and replay de-duplication.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import {
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
  type OpenAiResponsesTextEventPhase,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("text_end snapshot reconciliation", () => {
  function setupTextEndSubscription() {
    // text_end block replies expose snapshot/delta merge behavior without the
    // extra message-end terminal path.
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitDelta = (delta: string) => {
      emitAssistantTextDelta({ emit, delta });
    };

    const emitTextEnd = (content: string) => {
      emitAssistantTextEnd({ emit, content });
    };

    return { onBlockReply, subscription, emitDelta, emitTextEnd };
  }

  it.each([
    {
      name: "does not append when text_end content is a prefix of deltas",
      delta: "Hello world",
      content: "Hello",
      expected: "Hello world",
    },
    {
      name: "does not append when text_end content is already contained",
      delta: "Hello world",
      content: "world",
      expected: "Hello world",
    },
    {
      name: "appends suffix when text_end content extends deltas",
      delta: "Hello",
      content: "Hello world",
      expected: "Hello world",
    },
  ])("$name", async ({ delta, content, expected }) => {
    const { onBlockReply, subscription, emitDelta, emitTextEnd } = setupTextEndSubscription();

    emitDelta(delta);
    emitTextEnd(content);
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(subscription.assistantTexts).toEqual([expected]);
  });

  it("sends only the suffix when text_end block replies grow across assistant messages", async () => {
    // After a tool call, providers can resend the full accumulated text; only
    // the newly grown suffix should be emitted as a block reply.
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitAssistantSnapshot = (content: string) => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextEnd({ emit, content });
    };
    const emitToolStart = (toolCallId: string) => {
      emit({
        type: "tool_execution_start",
        toolName: "browser",
        toolCallId,
        args: {},
      });
    };

    emitAssistantSnapshot("Let me grab actual eBay prices:");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });

    emitToolStart("tool-1");
    await Promise.resolve();
    emitAssistantSnapshot("Let me grab actual eBay prices:Let me grab actual prices from eBay:");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(2);
    });

    emitToolStart("tool-2");
    await Promise.resolve();
    emitAssistantSnapshot(
      "Let me grab actual eBay prices:Let me grab actual prices from eBay:eBay blocks live pricing:",
    );
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(3);
    });

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
      "Let me grab actual eBay prices:",
      "Let me grab actual prices from eBay:",
      "eBay blocks live pricing:",
    ]);
    expect(subscription.assistantTexts).toEqual([
      "Let me grab actual eBay prices:",
      "Let me grab actual prices from eBay:",
      "eBay blocks live pricing:",
    ]);
  });

  it.each([
    {
      name: "keeps a full later reply that shares a prefix without an intervening tool call",
      replies: ["OK", "OK, here's the detail"],
    },
    {
      name: "keeps a full post-tool reply when the prior block is not a preamble",
      replies: ["Checking...", "Checking... found X"],
      toolCallId: "tool-post-check",
    },
    {
      name: "keeps a full post-tool reply when the shared prefix is whitespace-separated",
      replies: ["Checking:", "Checking: found X"],
      toolCallId: "tool-post-check-colon",
    },
  ] satisfies Array<{ name: string; replies: [string, string]; toolCallId?: string }>)(
    "$name",
    async ({ replies, toolCallId }) => {
      const onBlockReply = vi.fn();
      const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });
      const emitAssistantSnapshot = (content: string) => {
        emit({ type: "message_start", message: { role: "assistant" } });
        emitAssistantTextEnd({ emit, content });
      };

      emitAssistantSnapshot(replies[0]);
      await vi.waitFor(() => {
        expect(onBlockReply).toHaveBeenCalledTimes(1);
      });
      if (toolCallId) {
        emit({ type: "tool_execution_start", toolName: "browser", toolCallId, args: {} });
        await Promise.resolve();
      }
      emitAssistantSnapshot(replies[1]);
      await vi.waitFor(() => {
        expect(onBlockReply).toHaveBeenCalledTimes(2);
      });

      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(replies);
      expect(subscription.assistantTexts).toEqual(replies);
    },
  );

  it("does not safety-send a cumulative text_end reply when the suffix was sent by a messaging tool", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit, content: "Checking:" });
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });

    emit({
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "message-tool-1",
      args: { action: "send", to: "+1555", message: "Fetched prices" },
    });
    await Promise.resolve();
    emit({
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "message-tool-1",
      isError: false,
      result: { details: { deliveryStatus: "sent" } },
    });
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit, content: "Checking: Fetched prices" });
    await Promise.resolve();
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Checking: Fetched prices" }],
      },
    });
    await Promise.resolve();

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Checking:"]);
  });
});

describe("text_end replay de-duplication", () => {
  it("does not duplicate when text_end repeats full content", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Good morning!" });
    emitAssistantTextEnd({ emit, content: "Good morning!" });
    await Promise.resolve();

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
    expect(subscription.assistantTexts).toEqual(["Good morning!"]);
  });
  it("does not duplicate block chunks when text_end repeats full content", async () => {
    // Chunked deltas may already flush all visible text before text_end repeats
    // the same content; the snapshot must be ignored.
    const onBlockReply = vi.fn();
    const { emit } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: {
        minChars: 5,
        maxChars: 40,
        breakPreference: "newline",
      },
    });

    const fullText = "First line\nSecond line\nThird line\n";

    emitAssistantTextDelta({ emit, delta: fullText });
    await Promise.resolve();

    const callsAfterDelta = onBlockReply.mock.calls.length;
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
      "First line\nSecond line\nThird line",
    ]);

    emitAssistantTextEnd({ emit, content: fullText });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(callsAfterDelta);
  });
});

describe("assistant snapshot replay", () => {
  it("does not emit duplicate block replies when text_end repeats", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emitAssistantTextDelta({ emit, delta: "Hello block" });
    emitAssistantTextEnd({ emit });
    emitAssistantTextEnd({ emit });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(subscription.assistantTexts).toEqual(["Hello block"]);
  });
  it("does not duplicate assistantTexts when message_end repeats", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("keeps the completed assistant independent from transcript mutation", () => {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedAgentSession({ session, runId: "run" });
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Current run reply" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    assistantMessage.content = [{ type: "text", text: "Rewritten transcript reply" }];

    expect(subscription.getCurrentAttemptAssistant()?.content).toEqual([
      { type: "text", text: "Current run reply" },
    ]);
  });
  it("does not duplicate assistantTexts when message_end repeats with trailing whitespace changes", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
    });

    const assistantMessageWithNewline = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world\n" }],
    } as AssistantMessage;

    const assistantMessageTrimmed = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessageWithNewline });
    emit({ type: "message_end", message: assistantMessageTrimmed });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("does not duplicate assistantTexts when message_end repeats with reasoning blocks", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Because" },
        { type: "text", text: "Hello world" },
      ],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });
    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Hello world"]);
  });
  it("populates assistantTexts for non-streaming models with chunking enabled", () => {
    // Non-streaming providers may only send message_end; assistantTexts still
    // needs the final visible reply even when block chunking is enabled.
    // Non-streaming models (e.g. zai/glm-4.7): no text_delta events; message_end
    // must still populate assistantTexts so providers can deliver a final reply.
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      blockReplyChunking: { minChars: 50, maxChars: 200 }, // Chunking enabled
    });

    // Simulate non-streaming model: only message_start and message_end, no text_delta
    emit({ type: "message_start", message: { role: "assistant" } });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Response from non-streaming model" }],
    } as AssistantMessage;

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Response from non-streaming model"]);
  });
});

type TextEndBlockReplyHarness = ReturnType<typeof createTextEndBlockReplyHarness>;
type OnBlockReplyMock = ReturnType<typeof vi.fn>;
type BlockReplyPayload = { text?: string };

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
