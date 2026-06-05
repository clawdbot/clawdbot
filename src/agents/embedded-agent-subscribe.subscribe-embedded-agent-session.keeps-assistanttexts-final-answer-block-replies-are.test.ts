// AssistantTexts final-answer tests ensure reasoning-mode subscriptions keep
// stored assistant text aligned to the final answer when block replies are off.
import { describe, expect, it, vi } from "vitest";
import {
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("subscribeEmbeddedAgentSession", () => {
  it("keeps assistantTexts to the final answer when block replies are disabled", () => {
    const { session, emit } = createStubSessionHarness();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      reasoningMode: "on",
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Final " });
    emitAssistantTextDelta({ emit, delta: "answer" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });

    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
  it("suppresses partial replies when reasoning is enabled and block replies are disabled", () => {
    // With reasoning enabled, streamed draft text stays private until the final
    // message_end answer is available.
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      reasoningMode: "on",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Draft " });
    emitAssistantTextDelta({ emit, delta: "reply" });

    expect(onPartialReply).not.toHaveBeenCalled();

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });
    emitAssistantTextEnd({ emit, content: "Draft reply" });

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
});
