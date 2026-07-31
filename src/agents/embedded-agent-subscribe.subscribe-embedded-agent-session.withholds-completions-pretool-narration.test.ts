import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

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
    subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-answer",
      onBlockReply,
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
