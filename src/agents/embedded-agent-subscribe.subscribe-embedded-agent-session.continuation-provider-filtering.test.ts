import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

function anthropicAssistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    content: [{ type: "text", text }],
  } as unknown as AssistantMessage;
}

function completionsAssistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    content: [{ type: "text", text }],
  } as unknown as AssistantMessage;
}

function postedText(onBlockReply: ReturnType<typeof vi.fn>): string {
  return onBlockReply.mock.calls.map((call) => call[0]?.text ?? "").join(" ");
}

describe("continuation provider filtering", () => {
  it("keeps incomplete Anthropic continuation markers out of final assistant delivery", async () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-anthropic-incomplete-continuation",
      onAgentEvent,
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const answer = "Done.\nCONTINUE_WOR";

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

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalled());
    expect(postedText(onBlockReply)).toContain("Done.");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WOR");
    expect(JSON.stringify(onBlockReply.mock.calls)).not.toContain("CONTINUE_WOR");
    expect(subscription.assistantTexts.join("\n")).not.toContain("CONTINUE_WOR");
  });

  it("keeps incomplete Completions continuation markers out of final assistant delivery", async () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-incomplete-continuation",
      onAgentEvent,
      onBlockReply,
      blockReplyBreak: "text_end",
    });
    const answer = "Done.\nCONTINUE_WOR";

    emit({ type: "message_start", message: completionsAssistant("") });
    emit({
      type: "message_update",
      message: completionsAssistant(answer),
      assistantMessageEvent: { type: "text_delta", delta: answer },
    });
    emit({
      type: "message_update",
      message: completionsAssistant(answer),
      assistantMessageEvent: { type: "text_end", contentIndex: 0 },
    });
    emit({ type: "message_end", message: completionsAssistant(answer) });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalled());
    expect(postedText(onBlockReply)).toContain("Done.");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WOR");
    expect(JSON.stringify(onBlockReply.mock.calls)).not.toContain("CONTINUE_WOR");
    expect(subscription.assistantTexts.join("\n")).not.toContain("CONTINUE_WOR");
  });

  it("filters continuation markers before preserving trailing reply directives", async () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedAgentSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"],
      runId: "run-completions-continuation-directive",
      onAgentEvent,
      onBlockReply,
      blockReplyBreak: "message_end",
    });
    const answer = "Done.\nCONTINUE_WORK\n[[reply_to_current]]";

    emit({ type: "message_start", message: completionsAssistant("") });
    emit({ type: "message_end", message: completionsAssistant(answer) });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalled());
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Done.",
        replyToCurrent: true,
      }),
      expect.anything(),
    );
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("CONTINUE_WORK");
    expect(JSON.stringify(onBlockReply.mock.calls)).not.toContain("CONTINUE_WORK");
    expect(subscription.assistantTexts.join("\n")).not.toContain("CONTINUE_WORK");
  });
});
