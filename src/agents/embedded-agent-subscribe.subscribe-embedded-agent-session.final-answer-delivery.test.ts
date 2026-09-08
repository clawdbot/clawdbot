import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import {
  createSubscribedSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
  type OpenAiResponsesTextEventPhase,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

describe("text_end snapshot reconciliation", () => {
  it.each([
    { name: "hidden reasoning", prefix: "<think>private reasoning</think>", audioAsVoice: false },
    {
      name: "unfinished reasoning before a queued phase update",
      prefix: "<think>private",
      queuedDeltas: [" reasoning", " remains private"],
      recoveryPrefix: "</think>",
      audioAsVoice: false,
    },
    { name: "voice directives", prefix: "[[audio_as_voice]]", audioAsVoice: true },
    {
      name: "closed inline reasoning",
      prefix: "Example: <think>private</think>.",
      expectedPrefix: "Example: .",
      audioAsVoice: false,
    },
    {
      name: "unclosed inline tag examples",
      prefix: "Example: <think>literal",
      expectedPrefix: "Example: <think>literal",
      audioAsVoice: false,
    },
    {
      name: "split unclosed inline tag examples",
      prefix: "Example: <thi",
      recoveryPrefix: "nk>literal.",
      expectedPrefix: "Example: <think>literal.",
      audioAsVoice: false,
    },
    {
      name: "split voice directives",
      prefix: "[[audio_as_",
      recoveryPrefix: "voice]]",
      audioAsVoice: true,
    },
  ])(
    "preserves $name across late Responses phase updates",
    async ({
      prefix,
      audioAsVoice,
      expectedPrefix = "",
      recoveryPrefix = "",
      queuedDeltas = [],
    }) => {
      const model: Model<"openai-responses"> = {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      };
      const answer = "Answer".repeat(32);
      const expected = expectedPrefix + answer;
      const rawProcessed = createDeferred();
      const reanchorProcessed = createDeferred();
      const phaseProcessed = createDeferred();
      const onBlockReply = vi.fn();
      const onPartialReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-responses-phase-reanchor",
        onBlockReply,
        onPartialReply,
        blockReplyBreak: "text_end",
        blockReplyChunking: { minChars: 64, maxChars: 128, breakPreference: "paragraph" },
      });
      async function* wireEvents() {
        yield {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_answer", role: "assistant", content: [] },
        };
        yield { type: "response.output_text.delta", output_index: 0, delta: prefix };
        await rawProcessed.promise;
        yield {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "reasoning", id: "rs_reanchor", summary: [] },
        };
        await reanchorProcessed.promise;
        const finalItem = {
          type: "message",
          id: "msg_answer",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [
            {
              type: "output_text",
              text: prefix + queuedDeltas.join("") + recoveryPrefix + answer,
              annotations: [],
            },
          ],
        };
        if (queuedDeltas.length > 0) {
          for (const delta of queuedDeltas) {
            yield { type: "response.output_text.delta", output_index: 0, delta };
          }
          yield { type: "response.output_item.done", output_index: 0, item: finalItem };
          phaseProcessed.resolve();
        }
        yield {
          type: "response.completed",
          response: {
            id: "resp_phase_recovery",
            status: "completed",
            output: [finalItem, { type: "reasoning", id: "rs_reanchor", summary: [] }],
          },
        };
      }
      const output = createResponsesAssistantOutput(model);
      const response = new AssistantMessageEventStream();
      response.push({ type: "start", partial: output });
      const producing = processResponsesStream(wireEvents(), output, response, model).then(
        () => {
          response.push({ type: "done", reason: "stop", message: output });
          response.end();
        },
        (error: unknown) => {
          response.end({ ...output, stopReason: "error", errorMessage: String(error) });
          throw error;
        },
      );
      const running = runAgentLoop(
        [{ role: "user", content: "Give the answer.", timestamp: 1 }],
        { systemPrompt: "", messages: [] },
        {
          model,
          convertToLlm: (messages) =>
            messages.filter(
              (message): message is Message =>
                message.role === "user" ||
                message.role === "assistant" ||
                message.role === "toolResult",
            ),
        },
        async (event) => {
          emit(event);
          await subscription.waitForPendingEvents();
          if (event.type !== "message_update") {
            return;
          }
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta" && update.delta === prefix) {
            expect(onBlockReply).not.toHaveBeenCalled();
            rawProcessed.resolve();
          }
          if (update.type === "thinking_start") {
            reanchorProcessed.resolve();
            if (queuedDeltas.length > 0) {
              await phaseProcessed.promise;
            }
          }
          if (update.type === "text_delta" && queuedDeltas.includes(update.delta)) {
            expect(onPartialReply).not.toHaveBeenCalled();
          }
        },
        undefined,
        () => response,
      );
      try {
        await Promise.all([producing, running]);
        await subscription.waitForPendingEvents();
        expect(extractTextPayloads(onBlockReply.mock.calls).join("")).toBe(expected);
        expect(subscription.assistantTexts.join("")).toBe(expected);
        expect(onBlockReply.mock.calls[0]?.[0].audioAsVoice ?? false).toBe(audioAsVoice);
      } finally {
        rawProcessed.resolve();
        reanchorProcessed.resolve();
        phaseProcessed.resolve();
        await Promise.allSettled([producing, running]);
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { name: "terminal-only", streamed: false },
    { name: "streamed", streamed: true },
  ])(
    "preserves literal tags in explicit final answers with $name delivery",
    async ({ streamed }) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-final-answer-literal-tags",
        onAgentEvent,
        onBlockReply,
        blockReplyBreak: "text_end",
        enforceFinalTag: false,
      });
      const text = "Before <think>literal tag text after";
      const message = createOpenAiResponsesPartial({
        text,
        id: "literal-final",
        signaturePhase: "final_answer",
      });
      try {
        emit({ type: "message_start", message });
        if (streamed) {
          let partialText = "";
          for (const delta of ["Before ", "<think>literal tag text after"]) {
            partialText += delta;
            emitOpenAiResponsesTextEvent({
              emit,
              type: "text_delta",
              text: partialText,
              delta,
              id: "literal-final",
              signaturePhase: "final_answer",
            });
          }
          expect(onBlockReply).not.toHaveBeenCalled();
          emitOpenAiResponsesTextEvent({
            emit,
            type: "text_end",
            text,
            id: "literal-final",
            signaturePhase: "final_answer",
          });
          await subscription.waitForPendingEvents();
          expectSingleBlockReplyText({ onBlockReply, subscription, text });
        }
        emit({ type: "message_end", message });
        await subscription.waitForPendingEvents();

        expectSingleBlockReplyText({ onBlockReply, subscription, text });
        expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
          stream: "assistant",
          data: { text },
        });
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { name: "late completions phase", api: "openai-completions", suppressLiveStreamOutput: false },
    {
      name: "suppressed Responses stream",
      api: "openai-responses",
      suppressLiveStreamOutput: true,
    },
  ])(
    "delivers every undelivered final block after $name",
    async ({ api, suppressLiveStreamOutput }) => {
      const onAgentEvent = vi.fn();
      const onBlockReply = vi.fn();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: "run-undelivered-final-blocks",
        onAgentEvent,
        onBlockReply,
        blockReplyBreak: "text_end",
        suppressLiveStreamOutput,
      });
      const base = { ...createOpenAiResponsesPartial({ text: "", id: "answer-0" }), api };
      const texts = ["First", "Second"];
      try {
        emit({ type: "message_start", message: base });
        for (const [contentIndex, delta] of texts.entries()) {
          const partial = {
            ...base,
            content: texts.slice(0, contentIndex + 1).map((text, index) =>
              createOpenAiResponsesTextBlock({
                text,
                id: `answer-${index}`,
                phase: suppressLiveStreamOutput ? "final_answer" : undefined,
              }),
            ),
          };
          emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial },
          });
          await subscription.waitForPendingEvents();
          expect(onBlockReply).not.toHaveBeenCalled();
          expect(subscription.assistantTexts).toEqual([]);
        }
        if (suppressLiveStreamOutput) {
          expect(onAgentEvent).not.toHaveBeenCalled();
        }
        emit({
          type: "message_end",
          message: {
            ...base,
            content: texts.map((text, index) =>
              createOpenAiResponsesTextBlock({
                text,
                id: `answer-${index}`,
                phase: "final_answer",
              }),
            ),
          },
        });
        await subscription.waitForPendingEvents();

        const text = "First\nSecond";
        expectSingleBlockReplyText({ onBlockReply, subscription, text });
        expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
          stream: "assistant",
          data: { text },
        });
      } finally {
        subscription.unsubscribe();
      }
    },
  );
});

type TextEndBlockReplyHarness = ReturnType<typeof createTextEndBlockReplyHarness>;
type OnBlockReplyMock = ReturnType<typeof vi.fn>;

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
  for (const type of ["text_delta", "text_end"] as const) {
    emitOpenAiResponsesTextEvent({
      ...eventParams,
      type,
      signaturePhase: phase,
      partialPhase: phase,
    });
  }
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
  expect(extractTextPayloads(params.onBlockReply.mock.calls)).toEqual([params.text]);
  expect(params.subscription.assistantTexts).toEqual([params.text]);
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
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Hello block"]);
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
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Final visible reply."]);
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
    emitOpenAiResponsesTextDeltaAndEnd({
      emit,
      text: "Legacy answer",
      id: "item_legacy",
    });
    await Promise.resolve();

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Legacy answer" });

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

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Hello world" });
  });

  it("does not defer final_answer text_end when phase exists only in textSignature", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    emit({ type: "message_start", message: { role: "assistant" } });
    for (const type of ["text_delta", "text_end"] as const) {
      emitOpenAiResponsesTextEvent({
        emit,
        type,
        text: "Done.",
        id: "item_final",
        signaturePhase: "final_answer",
      });
    }
    await Promise.resolve();

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Done." });
  });

  it("emits the final answer at message_end when commentary was streamed first", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    await emitSuppressedCommentary({ emit, text: "Working..." });

    emitOpenAiResponsesFinalMessageEnd({ emit, commentaryText: "Working...", finalText: "Done." });

    expectSingleBlockReplyText({ onBlockReply, subscription, text: "Done." });
  });
});
