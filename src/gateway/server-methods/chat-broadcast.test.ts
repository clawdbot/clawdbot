import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChatRunState } from "../server-chat-state.js";
import { broadcastChatDelta, broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { GatewayRequestContext } from "./types.js";

function createContext(seq = 0) {
  const order: string[] = [];
  const agentRunSeq = new Map<string, number>([["run-1", seq]]);
  const broadcast = vi.fn<GatewayRequestContext["broadcast"]>(() => {
    order.push("broadcast");
  });
  const nodeSendToSession = vi.fn<GatewayRequestContext["nodeSendToSession"]>(() => {
    order.push("node");
  });
  const deleteSpy = vi.spyOn(agentRunSeq, "delete").mockImplementation((key) => {
    order.push("delete");
    return Map.prototype.delete.call(agentRunSeq, key);
  });

  return {
    context: {
      agentRunSeq,
      broadcast,
      nodeSendToSession,
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    },
    order,
    deleteSpy,
  };
}

describe("chat terminal broadcasts", () => {
  it.each([
    { sessionKey: "agent:main:main", agentId: "main", keys: ["agent:main:main"] },
    { sessionKey: "global", agentId: "work", keys: ["agent:work:global"] },
  ])(
    "keeps pending snapshots scoped and retires them with $sessionKey",
    ({ sessionKey, agentId, keys }) => {
      const { context: base, deleteSpy } = createContext();
      const context = { ...base, chatRunState: createChatRunState() };
      let current = true;
      const request = { context, runId: "run-1", sessionKey, agentId, isCurrent: () => current };

      broadcastChatDelta({ ...request, text: "First instruction" });
      const first = context.broadcast.mock.calls[0];
      expect(first?.[1]).toMatchObject({
        state: "delta",
        deltaText: "First instruction",
        replace: true,
        seq: 1,
      });
      expect(first?.[2]?.sessionKeys).toEqual(keys);
      expect(context.nodeSendToSession.mock.calls.map(([key]) => key)).toEqual(keys);
      expect(deleteSpy).not.toHaveBeenCalled();

      broadcastChatDelta({ ...request, text: "First instruction\n\nSecond instruction" });
      const second = context.broadcast.mock.calls[1];
      const liveText = second?.[2]?.liveText;
      expect(liveText?.group).toBe(first?.[2]?.liveText?.group);
      expect(liveText?.coalesce?.merge(first?.[1], second?.[1])).toBe(second?.[1]);
      expect(context.chatRunState.resolveBuffer("run-1").text).toBe(
        "First instruction\n\nSecond instruction",
      );

      broadcastChatFinal({
        ...request,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
      expect(context.broadcast.mock.calls[2]?.[1]).toMatchObject({ state: "final", seq: 3 });
      expect(context.broadcast.mock.calls[2]?.[2]?.liveText).toEqual({ group: liveText?.group });
      expect(deleteSpy).toHaveBeenCalledOnce();

      current = false;
      context.chatRunState.clearRun("run-1");
      expect(liveText?.group.aborted).toBe(true);
      expect(liveText?.isCurrent?.()).toBe(false);
      broadcastChatDelta({ ...request, text: "late instruction" });
      expect(context.broadcast).toHaveBeenCalledTimes(3);
    },
  );

  it("bounds live command text", () => {
    const { context: base } = createContext();
    const context = { ...base, chatRunState: createChatRunState() };
    const text = "x".repeat(500_001);
    broadcastChatDelta({
      context,
      runId: "run-1",
      sessionKey: "agent:main:main",
      text,
      isCurrent: () => true,
    });
    expect(context.chatRunState.resolveBuffer("run-1").text).toHaveLength(500_000);
    expect(context.broadcast.mock.calls[0]?.[1]).toHaveProperty("deltaText.length", 500_000);
  });

  it("projects global final payloads and fans out one object to both delivery keys", () => {
    const { context, order, deleteSpy } = createContext(7);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    };

    broadcastChatFinal({
      context,
      runId: "run-1",
      sessionKey: "global",
      agentId: "main",
      message,
    });

    const payload = context.broadcast.mock.calls[0]?.[1];
    expect(payload).toEqual({
      runId: "run-1",
      sessionKey: "global",
      agentId: "main",
      seq: 8,
      state: "final",
      message,
    });
    expect(context.broadcast).toHaveBeenCalledWith("chat", payload, {
      sessionKeys: ["agent:main:global", "global"],
    });
    expect(context.nodeSendToSession.mock.calls).toEqual([
      ["agent:main:global", "chat", payload],
      ["global", "chat", payload],
    ]);
    expect(context.nodeSendToSession.mock.calls[0]?.[2]).toBe(payload);
    expect(context.nodeSendToSession.mock.calls[1]?.[2]).toBe(payload);
    expect(order).toEqual(["broadcast", "node", "node", "delete"]);
    expect(deleteSpy).toHaveBeenCalledWith("run-1");
    expect(context.agentRunSeq.has("run-1")).toBe(false);
  });

  it("emits canonical error payloads without message or agentId", () => {
    const { context } = createContext(2);

    broadcastChatError({
      context,
      runId: "run-1",
      sessionKey: "agent:main:main",
      agentId: "main",
      errorMessage: "provider unavailable",
    });

    const payload = context.broadcast.mock.calls[0]?.[1];
    expect(payload).toEqual({
      runId: "run-1",
      sessionKey: "agent:main:main",
      seq: 3,
      state: "error",
      errorMessage: "provider unavailable",
    });
    expect(payload).not.toHaveProperty("message");
    expect(payload).not.toHaveProperty("agentId");
    expect(context.broadcast).toHaveBeenCalledWith("chat", payload, {
      sessionKeys: ["agent:main:main"],
    });
    expect(context.nodeSendToSession).toHaveBeenCalledWith("agent:main:main", "chat", payload);
    expect(context.nodeSendToSession.mock.calls[0]?.[2]).toBe(payload);
  });

  it("retains the incremented sequence when websocket broadcast throws", () => {
    const { context, deleteSpy } = createContext(4);
    context.broadcast.mockImplementation(() => {
      throw new Error("websocket failed");
    });

    expect(() =>
      broadcastChatFinal({
        context,
        runId: "run-1",
        sessionKey: "agent:main:main",
      }),
    ).toThrow("websocket failed");

    expect(context.agentRunSeq.get("run-1")).toBe(5);
    expect(context.nodeSendToSession).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("retains the incremented sequence when node fanout throws", () => {
    const { context, deleteSpy } = createContext(9);
    context.nodeSendToSession.mockImplementation(() => {
      throw new Error("node failed");
    });

    expect(() =>
      broadcastChatError({
        context,
        runId: "run-1",
        sessionKey: "agent:main:main",
        errorMessage: "failed",
      }),
    ).toThrow("node failed");

    expect(context.broadcast).toHaveBeenCalledOnce();
    expect(context.agentRunSeq.get("run-1")).toBe(10);
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("global chat broadcast ownership", () => {
  it("keeps the bare global subscription for its persisted fixed-store owner", () => {
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const context = {
      agentRunSeq: new Map<string, number>(),
      broadcast,
      getRuntimeConfig: () =>
        ({
          session: { scope: "global", store: "/stores/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
        }) satisfies OpenClawConfig,
      nodeSendToSession,
    };

    broadcastChatFinal({
      context,
      runId: "run-ops-global",
      sessionKey: "global",
      agentId: "ops",
    });

    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ agentId: "ops", sessionKey: "global" }),
      { sessionKeys: ["agent:ops:global", "global"] },
    );
    expect(nodeSendToSession.mock.calls.map(([key]) => key)).toEqual([
      "agent:ops:global",
      "global",
    ]);
  });
});
