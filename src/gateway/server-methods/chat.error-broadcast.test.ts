// Chat error broadcast tests ensure chat.send failures still respond and emit
// error-state broadcasts for connected UI clients.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

function createMockContext() {
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const chatAbortControllers = new Map();
  const chatAbortedRuns = new Map();
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map();

  return {
    broadcast,
    nodeSendToSession,
    chatAbortControllers,
    chatAbortedRuns,
    agentRunSeq,
    dedupe,
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
  };
}

describe("chat.send error broadcast", () => {
  it("rejects a stale expected session routing contract before dispatch", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "main",
        message: "hello",
        expectedSessionRoutingContract: "global|main|main",
        idempotencyKey: "test-stale-routing",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: { reason: "session-routing-changed" },
      }),
    );
    expect(ctx.addChatRun).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it("returns an idempotent cached send after session routing changes", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();
    ctx.dedupe.set("chat:test-cached-routing", {
      ts: Date.now(),
      ok: true,
      payload: { runId: "test-cached-routing", status: "started" },
    });

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "main",
        message: "hello",
        expectedSessionRoutingContract: "global|main|main",
        idempotencyKey: "test-cached-routing",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      { runId: "test-cached-routing", status: "started" },
      undefined,
      { cached: true },
    );
  });

  it("rejects a stale routing contract before a stop side effect", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "main",
        message: "/stop",
        expectedSessionRoutingContract: "global|main|main",
        idempotencyKey: "test-stale-stop-routing",
      },
      respond: respond as never,
      context: ctx as unknown as GatewayRequestContext,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ details: { reason: "session-routing-changed" } }),
    );
    expect(ctx.addChatRun).not.toHaveBeenCalled();
  });

  it("should broadcast error when addChatRun throws", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    // Make addChatRun throw synchronously (inside the try block at line 2470)
    ctx.addChatRun.mockImplementation(() => {
      throw Object.assign(new Error("LLM timeout"), { code: "TIMEOUT" });
    });

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
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
