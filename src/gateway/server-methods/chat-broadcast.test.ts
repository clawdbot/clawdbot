import { describe, expect, it, vi } from "vitest";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
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
