// Anthropic tags pre-tool narration commentary only at the tool_use boundary, so
// during the unphased deltas the subscriber must not durably commit the text on
// block-reply (text_end) channels — otherwise the mid-drain or the pre-tool
// flushBlockReplyBuffer posts the narration as an answer. A non-tool answer must
// still be delivered in full.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

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
