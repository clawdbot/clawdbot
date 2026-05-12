import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("calls onBlockReplyFlush before tool_execution_start to preserve message boundaries", () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReplyFlush = vi.fn();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-flush-test",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    // Simulate text arriving before tool
    emit({
      type: "message_start",
      message: { role: "assistant" },
    });

    emitAssistantTextDelta({ emit, delta: "First message before tool." });

    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    // Tool execution starts - should trigger flush
    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-flush-1",
      args: { command: "echo hello" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    // Another tool - should flush again
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-flush-2",
      args: { path: "/tmp/test.txt" },
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(2);
  });
  it("flushes buffered block chunks before tool execution", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-flush-buffer",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 200 },
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });

    emitAssistantTextDelta({ emit, delta: "Short chunk." });

    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-flush-buffer-1",
      args: { command: "echo flush" },
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls.at(0)?.[0]?.text).toBe("Short chunk.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });

  it("waits for async block replies before tool_execution_start flush", async () => {
    const { session, emit } = createStubSessionHarness();
    const delivered: string[] = [];
    const flushSnapshots: string[][] = [];

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-async-tool-flush",
      onBlockReply: async (payload) => {
        await Promise.resolve();
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
      onBlockReplyFlush: vi.fn(() => {
        flushSnapshots.push([...delivered]);
      }),
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 50, maxChars: 200 },
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });
    emitAssistantTextDelta({ emit, delta: "Short chunk." });

    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "tool-async-flush-1",
      args: { command: "echo flush" },
    });
    await vi.waitFor(() => {
      expect(delivered).toEqual(["Short chunk."]);
      expect(flushSnapshots).toEqual([["Short chunk."]]);
    });
  });

  it("calls onBlockReplyFlush at message_end for message-boundary turns", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-message-end-flush",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "message_end",
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });
    emitAssistantTextDelta({ emit, delta: "Final reply before lifecycle end." });
    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final reply before lifecycle end." }],
      },
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls.at(0)?.[0]?.text).toBe("Final reply before lifecycle end.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });

  it("waits for async block replies before message_end flush", async () => {
    const { session, emit } = createStubSessionHarness();
    const delivered: string[] = [];
    const flushSnapshots: string[][] = [];

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-async-message-end-flush",
      onBlockReply: async (payload) => {
        await Promise.resolve();
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
      onBlockReplyFlush: vi.fn(() => {
        flushSnapshots.push([...delivered]);
      }),
      blockReplyBreak: "message_end",
    });

    emit({
      type: "message_start",
      message: { role: "assistant" },
    });
    emitAssistantTextDelta({ emit, delta: "Final reply before lifecycle end." });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final reply before lifecycle end." }],
      },
    });
    await vi.waitFor(() => {
      expect(delivered).toEqual(["Final reply before lifecycle end."]);
      expect(flushSnapshots).toEqual([["Final reply before lifecycle end."]]);
    });
  });
});
