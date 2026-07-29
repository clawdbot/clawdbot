// Reasoning block reply tests cover message_end extraction of native reasoning
// and tag-promoted thinking when reasoning output is enabled.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  THINKING_TAG_CASES,
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("subscribeEmbeddedAgentSession", () => {
  function createReasoningBlockReplyHarness(params: { thinkingLevel?: "off" | "medium" } = {}) {
    // message_end block replies let reasoning and final answer be emitted as
    // separate payloads without depending on streaming deltas.
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      reasoningMode: "on",
      thinkingLevel: params.thinkingLevel,
    });

    return { emit, onBlockReply };
  }

  function blockReplyTextAt(onBlockReply: ReturnType<typeof vi.fn>, callIndex: number): string {
    const call = onBlockReply.mock.calls[callIndex];
    if (!call) {
      throw new Error(`expected block reply call ${callIndex + 1}`);
    }
    return (call[0] as { text?: string }).text ?? "";
  }

  function expectReasoningAndAnswerCalls(onBlockReply: ReturnType<typeof vi.fn>) {
    // The expected contract is two user-visible payloads: reasoning first,
    // final answer second.
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(blockReplyTextAt(onBlockReply, 0)).toBe("Because it helps");
    expect(blockReplyTextAt(onBlockReply, 1)).toBe("Final answer");
  }

  it("emits reasoning as a separate message when enabled", () => {
    const { emit, onBlockReply } = createReasoningBlockReplyHarness();

    const assistantMessage = createReasoningFinalAnswerMessage();

    emit({ type: "message_end", message: assistantMessage });

    expectReasoningAndAnswerCalls(onBlockReply);
  });

  it("does not emit native reasoning when thinking is disabled", () => {
    const { emit, onBlockReply } = createReasoningBlockReplyHarness({ thinkingLevel: "off" });

    emit({ type: "message_end", message: createReasoningFinalAnswerMessage() });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(blockReplyTextAt(onBlockReply, 0)).toBe("Final answer");
  });

  it.each(THINKING_TAG_CASES)(
    "promotes <%s> tags to thinking blocks at write-time",
    ({ open, close }) => {
      const { emit, onBlockReply } = createReasoningBlockReplyHarness();

      const assistantMessage = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${open}\nBecause it helps\n${close}\n\nFinal answer`,
          },
        ],
      } as AssistantMessage;

      emit({ type: "message_end", message: assistantMessage });

      expectReasoningAndAnswerCalls(onBlockReply);

      expect(assistantMessage.content).toEqual([
        { type: "thinking", thinking: "Because it helps" },
        { type: "text", text: "Final answer" },
      ]);
    },
  );
});
