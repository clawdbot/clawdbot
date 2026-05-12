import { describe, expect, it, vi } from "vitest";
import {
  createTextEndBlockReplyHarness,
  extractTextPayloads,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  function setupTextEndSubscription() {
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

  it("keeps a full later reply that shares a prefix without an intervening tool call", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitAssistantSnapshot = (content: string) => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextEnd({ emit, content });
    };

    emitAssistantSnapshot("OK");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });

    emitAssistantSnapshot("OK, here's the detail");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(2);
    });

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["OK", "OK, here's the detail"]);
    expect(subscription.assistantTexts).toEqual(["OK", "OK, here's the detail"]);
  });

  it("keeps a full post-tool reply when the prior block is not a preamble", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitAssistantSnapshot = (content: string) => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextEnd({ emit, content });
    };

    emitAssistantSnapshot("Checking...");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });

    emit({
      type: "tool_execution_start",
      toolName: "browser",
      toolCallId: "tool-post-check",
      args: {},
    });
    await Promise.resolve();

    emitAssistantSnapshot("Checking... found X");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(2);
    });

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
      "Checking...",
      "Checking... found X",
    ]);
    expect(subscription.assistantTexts).toEqual(["Checking...", "Checking... found X"]);
  });

  it("keeps a full post-tool reply when the shared prefix is whitespace-separated", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({ onBlockReply });

    const emitAssistantSnapshot = (content: string) => {
      emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextEnd({ emit, content });
    };

    emitAssistantSnapshot("Checking:");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });

    emit({
      type: "tool_execution_start",
      toolName: "browser",
      toolCallId: "tool-post-check-colon",
      args: {},
    });
    await Promise.resolve();

    emitAssistantSnapshot("Checking: found X");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(2);
    });

    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
      "Checking:",
      "Checking: found X",
    ]);
    expect(subscription.assistantTexts).toEqual(["Checking:", "Checking: found X"]);
  });

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
      result: "ok",
    });
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

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
