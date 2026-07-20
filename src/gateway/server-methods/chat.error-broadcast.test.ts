import { describe, expect, it, vi } from "vitest";
import { chatHandlers, testing } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

function createMockContext() {
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const chatAbortControllers = new Map();
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map();

  return {
    broadcast,
    nodeSendToSession,
    chatAbortControllers,
    agentRunSeq,
    dedupe,
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
  };
}

function getChatBroadcastPayload(ctx: ReturnType<typeof createMockContext>) {
  const call = ctx.broadcast.mock.calls.find(([event]) => event === "chat");
  expect(call).toBeDefined();
  return call?.[1] as Record<string, unknown>;
}

describe("chat terminal broadcasts", () => {
  it("mirrors final attribution at the top level, nested message, and node session", () => {
    const ctx = createMockContext();

    testing.broadcastChatFinal({
      context: ctx,
      runId: "test-final-1",
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "served by fallback" }],
      },
      model: "moonshotai/Kimi-K2.5",
      provider: "deepinfra",
    });

    const payload = getChatBroadcastPayload(ctx);
    expect(payload).toMatchObject({
      runId: "test-final-1",
      sessionKey: "agent:main:main",
      state: "final",
      model: "moonshotai/Kimi-K2.5",
      provider: "deepinfra",
      message: {
        role: "assistant",
        model: "moonshotai/Kimi-K2.5",
        provider: "deepinfra",
      },
    });
    expect(ctx.nodeSendToSession).toHaveBeenCalledWith("agent:main:main", "chat", payload);
    expect(ctx.agentRunSeq.has("test-final-1")).toBe(false);
  });

  it("classifies a known setup failure and mirrors the same terminal to the node session", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    // Make addChatRun throw synchronously (inside the try block at line 2470)
    ctx.addChatRun.mockImplementation(() => {
      throw Object.assign(new Error("LLM timeout"), { code: "TIMEOUT" });
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "test-run-1",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ runId: "test-run-1", status: "error" }),
      expect.any(Object),
      expect.any(Object),
    );

    const payload = getChatBroadcastPayload(ctx);
    expect(payload).toMatchObject({
      runId: "test-run-1",
      state: "error",
      errorMessage: expect.stringContaining("LLM timeout"),
      errorKind: "timeout",
    });
    expect(ctx.nodeSendToSession).toHaveBeenCalledWith(expect.any(String), "chat", payload);
  });

  it("defaults an unclassified setup failure to unknown", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();
    ctx.addChatRun.mockImplementation(() => {
      throw new Error("opaque provider failure");
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "test-run-2",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    const payload = getChatBroadcastPayload(ctx);
    expect(payload).toMatchObject({
      runId: "test-run-2",
      state: "error",
      errorKind: "unknown",
    });
    expect(ctx.nodeSendToSession).toHaveBeenCalledWith(expect.any(String), "chat", payload);
  });
});
