import { describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    }),
    resolveGatewayPort: () => 18789,
  };
});

import { createClawdbotTools } from "./clawdbot-tools.js";

describe("subagents", () => {
  it("sessions_spawn announces back to the requester group surface", async () => {
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    let sendParams: { to?: string; provider?: string; message?: string } = {};
    let deletedKey: string | undefined;

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | { message?: string; sessionKey?: string }
          | undefined;
        const message = params?.message ?? "";
        const reply =
          message === "Sub-agent announce step." ? "announce now" : "result";
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 1000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text =
          (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text }] }],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; provider?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          provider: params?.provider,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      if (request.method === "sessions.delete") {
        const params = request.params as { key?: string } | undefined;
        deletedKey = params?.key;
        return { ok: true };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "discord:group:req",
      agentSurface: "discord",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call1", {
      task: "do thing",
      timeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({ status: "ok", reply: "result" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const first = agentCalls[0]?.params as
      | { lane?: string; deliver?: boolean; sessionKey?: string }
      | undefined;
    expect(first?.lane).toBe("subagent");
    expect(first?.deliver).toBe(false);
    expect(first?.sessionKey?.startsWith("subagent:")).toBe(true);

    expect(sendParams).toMatchObject({
      provider: "discord",
      to: "channel:req",
      message: "announce now",
    });
    expect(deletedKey?.startsWith("subagent:")).toBe(true);
  });

  it("sessions_spawn resolves main announce target from sessions.list", async () => {
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    let sendParams: { to?: string; provider?: string; message?: string } = {};

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: "main",
              lastChannel: "whatsapp",
              lastTo: "+123",
            },
          ],
        };
      }
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | { message?: string; sessionKey?: string }
          | undefined;
        const message = params?.message ?? "";
        const reply =
          message === "Sub-agent announce step." ? "hello from sub" : "done";
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text =
          (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text }] }],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; provider?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          provider: params?.provider,
          message: params?.message,
        };
        return { messageId: "m1" };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createClawdbotTools({
      agentSessionKey: "main",
      agentSurface: "whatsapp",
    }).find((candidate) => candidate.name === "sessions_spawn");
    if (!tool) throw new Error("missing sessions_spawn tool");

    const result = await tool.execute("call2", {
      task: "do thing",
      timeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({ status: "ok", reply: "done" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendParams).toMatchObject({
      provider: "whatsapp",
      to: "+123",
      message: "hello from sub",
    });
  });
});
