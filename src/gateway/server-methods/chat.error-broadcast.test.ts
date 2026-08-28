// Chat error broadcast tests ensure chat.send failures still respond and emit
// error-state broadcasts for connected UI clients.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatRunState } from "../server-chat-state.js";
import { recordClientPresenceActivity } from "../server/client-presence.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { handleChatSend } from "./chat-send-handler.js";
import { chatHandlers } from "./chat.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

vi.mock("./chat-send-agent-dispatch.js", () => ({
  startChatDispatch: () => {
    throw new Error("dispatch failed after admission ACK");
  },
}));

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
    chatRunState: createChatRunState(),
    agentRunSeq,
    dedupe,
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    recordClientActivity: vi.fn<(client: GatewayClient | null) => void>(),
  };
}

describe("chat.send error broadcast", () => {
  it("rejects a claimed leaf for a session that has not materialized", async () => {
    const ctx = createMockContext();
    const respond = vi.fn();

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "main",
        message: "hello",
        expectedLeafEntryId: "stale-leaf",
        idempotencyKey: "test-fresh-stale-leaf",
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
        details: { reason: "active-leaf-changed" },
      }),
    );
    expect(ctx.addChatRun).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ctx.recordClientActivity).not.toHaveBeenCalled();
  });

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
    expect(ctx.recordClientActivity).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "records new admission activity only if the socket remains live (closed=%s)",
    async (closedDuringAdmission) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const ctx = createMockContext();
        const client: GatewayWsClient = {
          connId: "activity-send",
          presenceKey: "activity-send",
          usesSharedGatewayAuth: false,
          socket: { readyState: 1 } as GatewayWsClient["socket"],
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            role: "operator",
            scopes: ["operator.admin"],
            client: { id: "openclaw-tui", version: "test", platform: "test", mode: "cli" },
          },
          authenticatedUserId: "send@activity.test",
          personPresence: { onlineSince: Date.now() - 1_000 },
        };
        const clients = new Set([client]);
        ctx.recordClientActivity.mockImplementation((requestClient) => {
          recordClientPresenceActivity(clients, requestClient);
        });
        const entered = createDeferred();
        const release = createDeferred();
        onTestFinished(() => release.resolve());
        const respond = vi.fn();
        const options = {
          params: {
            sessionKey: "main",
            message: "accepted activity",
            idempotencyKey: "activity-send",
          },
          client,
          context: ctx as unknown as GatewayRequestContext,
          req: { type: "req" as const, id: "activity-send", method: "chat.send" },
          isWebchatConnect: () => false,
          respond,
        };
        const sending = handleChatSend(options, async () => {
          entered.resolve();
          await release.promise;
          return true;
        });
        await Promise.race([
          entered.promise,
          sending.then(() => {
            throw new Error("send finished before reaching admission");
          }),
        ]);
        expect(client.personPresence?.lastActivityAt).toBeUndefined();
        const duplicateResponse = vi.fn();
        await handleChatSend({ ...options, respond: duplicateResponse });
        expect(duplicateResponse).toHaveBeenCalledWith(
          true,
          { runId: "activity-send", status: "in_flight" },
          undefined,
          expect.objectContaining({ cached: true }),
        );
        expect(ctx.recordClientActivity).not.toHaveBeenCalled();
        if (closedDuringAdmission) {
          clients.delete(client);
        }
        const admittedAt = Date.now() + 1_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(admittedAt);
        onTestFinished(() => clock.mockRestore());
        release.resolve();
        await sending;
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId: "activity-send", status: "started" }),
          undefined,
          { runId: "activity-send" },
        );
        expect(client.personPresence?.lastActivityAt).toBe(
          closedDuringAdmission ? undefined : admittedAt,
        );
        const cachedResponse = vi.fn();
        await handleChatSend({ ...options, respond: cachedResponse });
        expect(cachedResponse.mock.calls[0]?.[3]).toMatchObject({ cached: true });
        expect(ctx.recordClientActivity).toHaveBeenCalledExactlyOnceWith(client);
      });
    },
  );

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

    const payload = expectDefined(ctx.broadcast.mock.calls[0], "error broadcast")[1] as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      runId: "test-run-1",
      state: "error",
      errorMessage: expect.stringContaining("LLM timeout"),
    });
    expect(payload).not.toHaveProperty("message");
    expect(ctx.broadcast).toHaveBeenCalledWith("chat", payload, {
      sessionKeys: ["agent:main:main"],
    });
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

    // The global agent alias canonicalizes to the agent's main session before
    // load, so errors broadcast on the same key the visible thread subscribes
    // to — the alias fan-out keys no longer carry sends.
    expect(ctx.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "test-run-global",
        sessionKey: "agent:main:main",
        state: "error",
      }),
      { sessionKeys: ["agent:main:main"] },
    );
    const canonicalPayload = expectDefined(
      ctx.nodeSendToSession.mock.calls.find(([sessionKey]) => sessionKey === "agent:main:main"),
      "canonical node error payload",
    )[2] as Record<string, unknown>;
    expect(canonicalPayload).toMatchObject({
      state: "error",
      errorMessage: expect.stringContaining("LLM timeout"),
    });
    expect(canonicalPayload).not.toHaveProperty("message");
  });
});
