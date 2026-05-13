import type { PromptRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import {
  createChatEvent,
  createPendingPromptHarness,
  createSessionAgentHarness,
  observeSettlement,
  promptAgent,
} from "./translator.prompt-harness.test-support.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireFirstRequestIdempotencyKey(requestMock: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): string {
  const firstCall = requestMock.mock.calls[0];
  if (!firstCall) {
    throw new Error("expected request mock call");
  }
  const params = firstCall[1];
  if (!params || typeof params !== "object") {
    throw new Error("expected request params");
  }
  const idempotencyKey = (params as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof idempotencyKey !== "string") {
    throw new Error("expected request idempotency key");
  }
  return idempotencyKey;
}

describe("acp translator stop reason mapping", () => {
  it("error state resolves as end_turn, not refusal", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "error",
        errorMessage: "gateway timeout",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("error state with no errorMessage resolves as end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "error",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("aborted state resolves as cancelled", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "aborted",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("reconciles provisional ACP session keys to canonical Gateway keys by run id", async () => {
    const sentRunIds: string[] = [];
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "chat.send") {
        const runId = params?.idempotencyKey;
        if (typeof runId === "string") {
          sentRunIds.push(runId);
        }
      }
      return {};
    }) as GatewayClient["request"];
    const { agent, sessionId, sessionStore } = createSessionAgentHarness(request, {
      sessionKey: "acp:session-1",
    });

    const firstPrompt = promptAgent(agent, sessionId);
    await vi.waitFor(() => {
      expect(sentRunIds).toHaveLength(1);
    });
    await agent.handleGatewayEvent(
      createChatEvent({
        runId: sentRunIds[0],
        sessionKey: "agent:main:acp:session-1",
        seq: 1,
        state: "final",
        message: {
          content: [{ type: "text", text: "first" }],
        },
      }),
    );

    await expect(firstPrompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(sessionStore.getSession(sessionId)?.sessionKey).toBe("agent:main:acp:session-1");

    const secondPrompt = promptAgent(agent, sessionId, "again");
    await vi.waitFor(() => {
      expect(sentRunIds).toHaveLength(2);
    });
    const requestCalls = (
      request as unknown as {
        mock: { calls: Array<[string, { sessionKey?: string }, { timeoutMs?: number | null }]> };
      }
    ).mock.calls;
    const lastRequestCall = requestCalls.at(-1);
    expect(lastRequestCall?.[0]).toBe("chat.send");
    expect(lastRequestCall?.[1].sessionKey).toBe("agent:main:acp:session-1");
    expect(lastRequestCall?.[2]).toEqual({ timeoutMs: null });
    await agent.handleGatewayEvent(
      createChatEvent({
        runId: sentRunIds[1],
        sessionKey: "agent:main:acp:session-1",
        seq: 2,
        state: "final",
      }),
    );

    await expect(secondPrompt).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("keeps in-flight prompts pending across transient gateway disconnects", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();
    const settleSpy = observeSettlement(promptPromise);

    agent.handleGatewayDisconnect("1006: connection lost");
    await Promise.resolve();

    expect(settleSpy).not.toHaveBeenCalled();

    agent.handleGatewayReconnect();
    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: "agent:main:main",
        seq: 1,
        state: "final",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("rejects in-flight prompts when the gateway does not reconnect before the grace window", async () => {
    vi.useFakeTimers();
    try {
      const { agent, promptPromise } = await createPendingPromptHarness();
      void promptPromise.catch(() => {});

      agent.handleGatewayDisconnect("1006: connection lost");
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(promptPromise).rejects.toThrow("Gateway disconnected: 1006: connection lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pre-ack send disconnects inside the reconnect grace window", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "chat.send") {
          throw new Error("gateway closed (1006): connection lost");
        }
        return {};
      }) as GatewayClient["request"];
      const { agent, sessionId } = createSessionAgentHarness(request);
      const promptPromise = promptAgent(agent, sessionId);
      const settleSpy = observeSettlement(promptPromise);

      await Promise.resolve();
      expect(settleSpy).not.toHaveBeenCalled();

      agent.handleGatewayDisconnect("1006: connection lost");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settleSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(promptPromise).rejects.toThrow("Gateway disconnected: 1006: connection lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a missed final event on reconnect via agent.wait", async () => {
    let runId: string | undefined;
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "chat.send") {
        runId = params?.idempotencyKey as string | undefined;
        return {};
      }
      if (method === "agent.wait") {
        return { status: "ok" };
      }
      return {};
    }) as GatewayClient["request"];
    const { agent, sessionId } = createSessionAgentHarness(request);
    const promptPromise = promptAgent(agent, sessionId);

    await vi.waitFor(() => {
      expect(runId).toBeTypeOf("string");
      expect(runId).not.toBe("");
    });
    const capturedRunId = requireValue(runId, "chat.send run id");

    agent.handleGatewayDisconnect("1006: connection lost");
    agent.handleGatewayReconnect();

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(request).toHaveBeenCalledWith(
      "agent.wait",
      {
        runId: capturedRunId,
        timeoutMs: 0,
      },
      { timeoutMs: null },
    );
  });

  it("rechecks accepted prompts at the disconnect deadline after reconnect timeout", async () => {
    vi.useFakeTimers();
    try {
      let chatRunId: string | undefined;
      const agentWaitParams: Array<Record<string, unknown> | undefined> = [];
      let waitCount = 0;
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "chat.send") {
          const runId = params?.idempotencyKey;
          if (typeof runId !== "string") {
            throw new Error("expected chat.send idempotency key");
          }
          chatRunId = runId;
          return {};
        }
        if (method === "agent.wait") {
          waitCount += 1;
          agentWaitParams.push(params);
          return waitCount === 1 ? { status: "timeout" } : { status: "ok" };
        }
        return {};
      }) as GatewayClient["request"];
      const { agent, sessionId } = createSessionAgentHarness(request);
      const promptPromise = promptAgent(agent, sessionId);
      const settleSpy = observeSettlement(promptPromise);

      await Promise.resolve();
      agent.handleGatewayDisconnect("1006: connection lost");
      agent.handleGatewayReconnect();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settleSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
      expect(agentWaitParams).toEqual([
        {
          runId: requireValue(chatRunId, "chat.send run id"),
          timeoutMs: 0,
        },
        {
          runId: requireValue(chatRunId, "chat.send run id"),
          timeoutMs: 0,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps accepted prompts pending when the deadline recheck still reports timeout", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "chat.send") {
          return {};
        }
        if (method === "agent.wait") {
          return { status: "timeout" };
        }
        return {};
      }) as GatewayClient["request"];
      const { agent, sessionId } = createSessionAgentHarness(request);
      const promptPromise = promptAgent(agent, sessionId);

      await Promise.resolve();
      agent.handleGatewayDisconnect("1006: connection lost");
      agent.handleGatewayReconnect();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(Promise.race([promptPromise, Promise.resolve("pending")])).resolves.toBe(
        "pending",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear a newer disconnect deadline while reconnect reconciliation is still running", async () => {
    vi.useFakeTimers();
    try {
      let resolveAgentWait: ((value: { status: "timeout" }) => void) | undefined;
      let agentWaitCount = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "chat.send") {
          return {};
        }
        if (method === "agent.wait") {
          agentWaitCount += 1;
          if (agentWaitCount > 1) {
            return { status: "timeout" };
          }
          return await new Promise<{ status: "timeout" }>((resolve) => {
            resolveAgentWait = resolve;
          });
        }
        return {};
      }) as GatewayClient["request"];
      const { agent, sessionId } = createSessionAgentHarness(request);
      const promptPromise = promptAgent(agent, sessionId);
      const settleSpy = observeSettlement(promptPromise);

      await Promise.resolve();
      agent.handleGatewayDisconnect("1006: first disconnect");
      agent.handleGatewayReconnect();
      await vi.waitFor(() => {
        if (resolveAgentWait === undefined) {
          throw new Error("expected agent.wait resolver");
        }
      });
      const resolveWait = requireValue(resolveAgentWait, "agent.wait resolver");

      agent.handleGatewayDisconnect("1006: second disconnect");
      resolveWait({ status: "timeout" });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settleSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(promptPromise).rejects.toThrow("Gateway disconnected: 1006: second disconnect");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pre-ack prompts when reconnect timeout still finds no run", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "chat.send") {
          throw new Error("gateway closed (1006): connection lost");
        }
        if (method === "agent.wait") {
          return { status: "timeout" };
        }
        return {};
      }) as GatewayClient["request"];
      const { agent, sessionId } = createSessionAgentHarness(request);
      const promptPromise = promptAgent(agent, sessionId);
      void promptPromise.catch(() => {});

      await Promise.resolve();
      agent.handleGatewayDisconnect("1006: connection lost");
      agent.handleGatewayReconnect();
      await Promise.resolve();

      await expect(Promise.race([promptPromise, Promise.resolve("pending")])).resolves.toBe(
        "pending",
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(promptPromise).rejects.toThrow("Gateway disconnected: 1006: connection lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a superseded pre-ack prompt when a newer prompt has replaced the session entry", async () => {
    let promptCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "chat.send") {
        return {};
      }
      promptCount += 1;
      if (promptCount === 1) {
        throw new Error("gateway closed (1006): connection lost");
      }
      return {};
    }) as GatewayClient["request"];
    const { agent, sessionId } = createSessionAgentHarness(request);

    const firstPrompt = promptAgent(agent, sessionId, "first");
    await Promise.resolve();

    const secondPrompt = promptAgent(agent, sessionId, "second");

    await expect(firstPrompt).rejects.toThrow("gateway closed (1006): connection lost");
    await expect(Promise.race([secondPrompt, Promise.resolve("pending")])).resolves.toBe("pending");
  });

  it("rejects stale pre-ack prompts when a superseded send resolves late", async () => {
    vi.useFakeTimers();
    try {
      let firstSendResolve: (() => void) | undefined;
      let sendCount = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "chat.send") {
          sendCount += 1;
          if (sendCount === 1) {
            return await new Promise<void>((resolve) => {
              firstSendResolve = resolve;
            });
          }
          throw new Error("gateway closed (1006): connection lost");
        }
        if (method === "agent.wait") {
          return { status: "timeout" };
        }
        return {};
      }) as GatewayClient["request"];
      const { agent, sessionId } = createSessionAgentHarness(request);

      const firstPrompt = promptAgent(agent, sessionId, "first");
      void firstPrompt.catch(() => {});
      await Promise.resolve();
      const resolveFirstSend = requireValue(firstSendResolve, "first chat.send resolver");

      const secondPrompt = promptAgent(agent, sessionId, "second");
      void secondPrompt.catch(() => {});
      await Promise.resolve();
      expect(sendCount).toBe(2);

      resolveFirstSend();
      await Promise.resolve();

      agent.handleGatewayDisconnect("1006: connection lost");
      agent.handleGatewayReconnect();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(secondPrompt).rejects.toThrow("Gateway disconnected: 1006: connection lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes terminal prompts while rejecting stale pre-ack prompts", async () => {
    vi.useFakeTimers();
    try {
      let acceptedRunId: string | undefined;
      let acceptedWaitCount = 0;
      const requestMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "chat.send") {
          return params?.sessionKey === "agent:main:second"
            ? Promise.reject(new Error("gateway closed (1006): connection lost"))
            : {};
        }
        if (method === "agent.wait") {
          return params?.runId === acceptedRunId && acceptedRunId
            ? acceptedWaitCount++ === 0
              ? { status: "timeout" }
              : { status: "ok" }
            : { status: "timeout" };
        }
        return {};
      });
      const request = requestMock as GatewayClient["request"];
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "session-1",
        sessionKey: "agent:main:first",
        cwd: "/tmp",
      });
      sessionStore.createSession({
        sessionId: "session-2",
        sessionKey: "agent:main:second",
        cwd: "/tmp",
      });
      const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
        sessionStore,
      });

      const acceptedPrompt = agent.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "accepted" }],
        _meta: {},
      } as unknown as PromptRequest);
      const preAckPrompt = agent.prompt({
        sessionId: "session-2",
        prompt: [{ type: "text", text: "pre-ack" }],
        _meta: {},
      } as unknown as PromptRequest);
      observeSettlement(acceptedPrompt);
      void preAckPrompt.catch(() => {});

      await Promise.resolve();
      acceptedRunId = requestMock.mock.calls.find((call) => {
        const [method, requestParams] = call;
        return method === "chat.send" && requestParams?.sessionKey === "agent:main:first";
      })?.[1]?.idempotencyKey as string | undefined;

      agent.handleGatewayDisconnect("1006: connection lost");
      agent.handleGatewayReconnect();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(acceptedPrompt).resolves.toEqual({ stopReason: "end_turn" });
      await expect(preAckPrompt).rejects.toThrow("Gateway disconnected: 1006: connection lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles prompts started while the gateway is disconnected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        throw new Error("gateway closed (1006): connection lost");
      }
      if (method === "agent.wait") {
        return { status: "ok" };
      }
      return {};
    }) as GatewayClient["request"];
    const { agent, sessionId } = createSessionAgentHarness(request);

    agent.handleGatewayDisconnect("1006: connection lost");
    const promptPromise = promptAgent(agent, sessionId);
    const settleSpy = observeSettlement(promptPromise);
    await Promise.resolve();
    agent.handleGatewayReconnect();

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(settleSpy).toHaveBeenCalledWith({
      kind: "resolve",
      value: { stopReason: "end_turn" },
    });
  });

  it("does not let a stale disconnect deadline reject a newer prompt on the same session", async () => {
    vi.useFakeTimers();
    try {
      let sendCount = 0;
      const requestMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "chat.send") {
          sendCount += 1;
          if (sendCount === 1) {
            throw new Error("gateway closed (1006): connection lost");
          }
          return {};
        }
        if (method === "agent.wait") {
          return params?.runId === firstRunId ? { status: "timeout" } : { status: "ok" };
        }
        return {};
      });
      const request = requestMock as GatewayClient["request"];
      const { agent, sessionId } = createSessionAgentHarness(request);

      const firstPrompt = promptAgent(agent, sessionId, "first");
      void firstPrompt.catch(() => {});
      await Promise.resolve();
      const firstRunId = requireFirstRequestIdempotencyKey(requestMock);

      agent.handleGatewayDisconnect("1006: connection lost");
      agent.handleGatewayReconnect();
      await Promise.resolve();

      const secondPrompt = promptAgent(agent, sessionId, "second");
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(Promise.race([secondPrompt, Promise.resolve("pending")])).resolves.toBe(
        "pending",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
