// Reasoning, commentary, and provider pre-tool narration delivery.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  THINKING_TAG_CASES,
  createReasoningFinalAnswerMessage,
  createStubSessionHarness,
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("reasoning block delivery", () => {
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

describe("reasoning without block replies", () => {
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

type AssistantMessageWithPhase = AssistantMessage & {
  // Some providers expose phase on the assistant message, while others only
  // include it in textSignature metadata.
  phase?: "commentary" | "final_answer";
};

describe("subscribeEmbeddedAgentSession", () => {
  it("suppresses commentary-phase assistant messages before tool use", () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onPartialReply,
      blockReplyBreak: "message_end",
    });

    const commentaryMessage = {
      role: "assistant",
      phase: "commentary",
      content: [{ type: "text", text: "Need send." }],
      stopReason: "toolUse",
    } as AssistantMessageWithPhase;

    emit({ type: "message_start", message: commentaryMessage });
    emit({ type: "message_end", message: commentaryMessage });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toStrictEqual([]);
  });

  it("suppresses commentary when phase is only present in textSignature metadata", () => {
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
      onBlockReply,
      onPartialReply,
      blockReplyBreak: "message_end",
    });

    const commentaryMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Need send.",
          textSignature: JSON.stringify({ v: 1, id: "msg_sig", phase: "commentary" }),
        },
      ],
      stopReason: "toolUse",
    } as AssistantMessage;

    emit({ type: "message_start", message: commentaryMessage });
    emit({
      type: "message_update",
      message: commentaryMessage,
      assistantMessageEvent: { type: "text_delta", delta: "Need send." },
    });
    emit({ type: "message_end", message: commentaryMessage });

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toStrictEqual([]);
  });
});

function anthropicAssistant(text: string, extra?: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    content: [{ type: "text", text }, ...(extra ?? [])],
  } as unknown as AssistantMessage;
}

function postedBlockReplyText(onBlockReply: ReturnType<typeof vi.fn>): string {
  return onBlockReply.mock.calls.map((call) => call[0]?.text ?? "").join(" ");
}

describe("subscribeEmbeddedAgentSession — Anthropic pre-tool narration", () => {
  it("withholds pre-tool narration from durable block replies on a text_end channel", () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-anthropic-withhold",
      onBlockReply,
      blockReplyBreak: "text_end",
      // Tiny chunking would mid-drain the narration during deltas without the gate.
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });

    const narration = "Let me check the files before I answer. ";
    emit({ type: "message_start", message: anthropicAssistant("") });
    emit({
      type: "message_update",
      message: anthropicAssistant(narration),
      assistantMessageEvent: { type: "text_delta", delta: narration },
    });
    // Tool execution flushes the block-reply buffer before running — the leak point.
    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-1",
      args: { command: "ls" },
    });
    // The turn resolves as a tool turn: the leading text is commentary.
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        api: "anthropic-messages",
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: narration,
            textSignature: JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" }),
          },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: {} },
        ],
      } as unknown as AssistantMessage,
    });

    expect(postedBlockReplyText(onBlockReply)).not.toContain("Let me check the files");
  });

  it("still delivers a non-tool Anthropic answer in full on a text_end channel", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-anthropic-answer",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    const answer = "Here is the full answer.";
    emit({ type: "message_start", message: anthropicAssistant("") });
    emit({
      type: "message_update",
      message: anthropicAssistant(answer),
      assistantMessageEvent: { type: "text_delta", delta: answer },
    });
    emit({
      type: "message_update",
      message: anthropicAssistant(answer),
      assistantMessageEvent: { type: "text_end", contentIndex: 0 },
    });
    emit({ type: "message_end", message: anthropicAssistant(answer) });

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalled();
    });
    expect(postedBlockReplyText(onBlockReply)).toContain("Here is the full answer.");
  });
});

function completionsAssistant(text: string, extra?: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    content: [{ type: "text", text }, ...(extra ?? [])],
  } as unknown as AssistantMessage;
}

function postedText(onBlockReply: ReturnType<typeof vi.fn>): string {
  return onBlockReply.mock.calls.map((call) => call[0]?.text ?? "").join(" ");
}

describe("Chat Completions pre-tool narration", () => {
  it("withholds reasoning-associated unphased text from live partial replies", () => {
    const { session, emit } = createStubSessionHarness();
    const onPartialReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-reasoning-pending",
      onPartialReply,
    });

    const message = {
      role: "assistant",
      api: "openai-completions",
      openclawDelivery: { textPhaseRequiresTerminal: true },
      content: [{ type: "text", text: "Interim text." }],
    } as unknown as AssistantMessage;
    emit({ type: "message_start", message });
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Interim text." },
    });

    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("withholds pre-tool narration from durable text_end block replies", () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-withhold",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });

    const narration = "Importing ORDER-1234 into the tracker… ";
    emit({ type: "message_start", message: completionsAssistant("") });
    emit({
      type: "message_update",
      message: completionsAssistant(narration),
      assistantMessageEvent: { type: "text_delta", delta: narration },
    });
    emit({
      type: "tool_execution_start",
      toolName: "import_order",
      toolCallId: "tool-1",
      args: { id: "ORDER-1234" },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-completions",
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: narration,
            textSignature: JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" }),
          },
          { type: "toolCall", id: "tool-1", name: "import_order", arguments: {} },
        ],
      } as unknown as AssistantMessage,
    });

    expect(postedText(onBlockReply)).not.toContain("Importing ORDER-1234");
  });

  it("delivers permanently unphased ordinary text in prefix-before-suffix order", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-answer",
      onBlockReply,
      onPartialReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });

    emit({ type: "message_start", message: completionsAssistant("") });
    emit({
      type: "message_update",
      message: completionsAssistant("prefix "),
      assistantMessageEvent: { type: "text_delta", delta: "prefix " },
    });
    emit({
      type: "message_update",
      message: completionsAssistant("prefix suffix"),
      assistantMessageEvent: { type: "text_end", contentIndex: 0, delta: "suffix" },
    });
    emit({ type: "message_end", message: completionsAssistant("prefix suffix") });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalled());
    expect(onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: "prefix" }));
    expect(postedText(onBlockReply)).toContain("prefix suffix");
  });

  it("delivers text when spurious tool calls were stripped and tags rolled back", async () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-spurious",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    const answer = "Here is the answer.";
    emit({ type: "message_start", message: completionsAssistant("") });
    emit({
      type: "message_update",
      message: completionsAssistant(answer),
      assistantMessageEvent: { type: "text_delta", delta: answer },
    });
    emit({
      type: "message_update",
      message: {
        role: "assistant",
        api: "openai-completions",
        content: [
          {
            type: "text",
            text: answer,
            textSignature: JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" }),
          },
          { type: "toolCall", id: "tool-spurious", name: "noop", arguments: {} },
        ],
      } as unknown as AssistantMessage,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
    });
    emit({ type: "message_end", message: completionsAssistant(answer) });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalled());
    expect(postedText(onBlockReply)).toContain(answer);
  });

  it("withholds post-tool text until final toolUse commentary classification", () => {
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-post-tool",
      onBlockReply,
      blockReplyBreak: "text_end",
    });

    emit({ type: "message_start", message: completionsAssistant("") });
    emit({
      type: "message_update",
      message: completionsAssistant("post-tool commentary"),
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 1,
        delta: "post-tool commentary",
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-completions",
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
          {
            type: "text",
            text: "post-tool commentary",
            textSignature: JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" }),
          },
        ],
      } as unknown as AssistantMessage,
    });

    expect(postedText(onBlockReply)).not.toContain("post-tool commentary");
  });
});
