import { describe, expect, it, vi } from "vitest";
import { chatHandlers } from "./chat.js";
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
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
  };
}

describe("chat.send error broadcast", () => {
  it("should broadcast error when addChatRun throws", async () => {
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

    // Verify respond was called with error
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ runId: "test-run-1", status: "error" }),
      expect.any(Object),
      expect.any(Object),
    );

    // Verify broadcastChatError was called (via context.broadcast)
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "test-run-1",
        state: "error",
        errorMessage: expect.stringContaining("LLM timeout"),
        message: expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("LLM timeout"),
            }),
          ],
        }),
      }),
    );
  });

  it("scopes selected-agent global errors to the linked agent", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    ctx.addChatRun.mockImplementation(() => {
      throw Object.assign(new Error("LLM timeout"), { code: "TIMEOUT" });
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "global",
        agentId: "main",
        message: "hello",
        idempotencyKey: "test-run-global",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(ctx.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "test-run-global",
        sessionKey: "global",
        agentId: "main",
        state: "error",
      }),
    );
    expect(ctx.nodeSendToSession).toHaveBeenCalledWith(
      "agent:main:global",
      "chat",
      expect.objectContaining({
        agentId: "main",
        state: "error",
      }),
    );
    expect(ctx.nodeSendToSession).toHaveBeenCalledWith(
      "global",
      "chat",
      expect.objectContaining({
        agentId: "main",
        state: "error",
        message: expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("LLM timeout"),
            }),
          ],
        }),
      }),
    );
  });
});
