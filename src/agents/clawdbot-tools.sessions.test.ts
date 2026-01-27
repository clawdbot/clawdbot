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
        agentToAgent: { maxPingPongTurns: 2 },
      },
    }),
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-core-tools.js";
import { createMoltbotTools } from "./moltbot-tools.js";

const waitForCalls = async (getCount: () => number, count: number, timeoutMs = 2000) => {
  const start = Date.now();
  while (getCount() < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} calls`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe("sessions tools", () => {
  it("uses number (not integer) in tool schemas for Gemini compatibility", () => {
    const tools = createMoltbotTools();
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      if (!tool) throw new Error(`missing ${name} tool`);
      return tool;
    };

    const schemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();

      const properties = schema.properties ?? {};
      const value = properties[prop] as { type?: unknown } | undefined;
      expect(value).toBeDefined();
      if (!value) throw new Error(`missing ${toolName} schema prop: ${prop}`);
      return value;
    };

    expect(schemaProp("sessions_history", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "activeMinutes").type).toBe("number");
    expect(schemaProp("sessions_list", "messageLimit").type).toBe("number");
    expect(schemaProp("sessions_send", "timeoutSeconds").type).toBe("number");
    expect(schemaProp("sessions_spawn", "thinking").type).toBe("string");
    expect(schemaProp("sessions_spawn", "runTimeoutSeconds").type).toBe("number");
    expect(schemaProp("sessions_spawn", "timeoutSeconds").type).toBe("number");
  });

  it("sessions_list filters kinds and includes messages", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "s-main",
              updatedAt: 10,
              lastChannel: "whatsapp",
            },
            {
              key: "discord:group:dev",
              kind: "group",
              sessionId: "s-group",
              updatedAt: 11,
              channel: "discord",
              displayName: "discord:g-dev",
            },
            {
              key: "cron:job-1",
              kind: "direct",
              sessionId: "s-cron",
              updatedAt: 9,
            },
            { key: "global", kind: "global" },
            { key: "unknown", kind: "unknown" },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createMoltbotTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_list tool");

    const result = await tool.execute("call1", { messageLimit: 1 });
    const details = result.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(details.sessions).toHaveLength(3);
    const main = details.sessions?.find((s) => s.key === "main");
    expect(main?.channel).toBe("whatsapp");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const cronOnly = await tool.execute("call2", { kinds: ["cron"] });
    const cronDetails = cronOnly.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(cronDetails.sessions).toHaveLength(1);
    expect(cronDetails.sessions?.[0]?.kind).toBe("cron");
  });

  it("sessions_history filters tool messages by default", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
        };
      }
      return {};
    });

    const tool = createMoltbotTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_history tool");

    const result = await tool.execute("call3", { sessionKey: "main" });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.role).toBe("assistant");

    const withTools = await tool.execute("call4", {
      sessionKey: "main",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: unknown[] };
    expect(withToolsDetails.messages).toHaveLength(2);
  });

  it("sessions_history resolves sessionId inputs", async () => {
    callGatewayMock.mockReset();
    const sessionId = "sess-group";
    const targetKey = "agent:main:discord:channel:1457165743010611293";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        return {
          key: targetKey,
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        };
      }
      return {};
    });

    const tool = createMoltbotTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_history tool");

    const result = await tool.execute("call5", { sessionKey: sessionId });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toHaveLength(1);
    const historyCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "chat.history",
    );
    expect(historyCall?.[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_history errors on missing sessionId", async () => {
    callGatewayMock.mockReset();
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        throw new Error("No session found");
      }
      return {};
    });

    const tool = createMoltbotTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_history tool");

    const result = await tool.execute("call6", { sessionKey: sessionId });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Session not found|No session found/);
  });

  it("sessions_send supports fire-and-forget and wait", async () => {
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let _historyCallCount = 0;
    let sendCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { message?: string; sessionKey?: string } | undefined;
        const message = params?.message ?? "";
        let reply = "REPLY_SKIP";
        if (message === "ping" || message === "wait") {
          reply = "done";
        } else if (message === "Agent-to-agent announce step.") {
          reply = "ANNOUNCE_SKIP";
        } else if (params?.sessionKey === requesterKey) {
          reply = "pong";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 1234 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        _historyCallCount += 1;
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text,
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        sendCallCount += 1;
        return { messageId: "m1" };
      }
      return {};
    });

    const tool = createMoltbotTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_send tool");

    const fire = await tool.execute("call5", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    expect(fire.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
      delivery: { status: "pending", mode: "announce" },
    });
    await waitForCalls(() => calls.filter((call) => call.method === "agent").length, 4);
    await waitForCalls(() => calls.filter((call) => call.method === "agent.wait").length, 4);
    await waitForCalls(() => calls.filter((call) => call.method === "chat.history").length, 4);

    const waitPromise = tool.execute("call6", {
      sessionKey: "main",
      message: "wait",
      timeoutSeconds: 1,
    });
    const waited = await waitPromise;
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "done",
      delivery: { status: "pending", mode: "announce" },
    });
    expect(typeof (waited.details as { runId?: string }).runId).toBe("string");
    await waitForCalls(() => calls.filter((call) => call.method === "agent").length, 8);
    await waitForCalls(() => calls.filter((call) => call.method === "agent.wait").length, 8);
    await waitForCalls(() => calls.filter((call) => call.method === "chat.history").length, 8);

    const agentCalls = calls.filter((call) => call.method === "agent");
    const waitCalls = calls.filter((call) => call.method === "agent.wait");
    const historyOnlyCalls = calls.filter((call) => call.method === "chat.history");
    expect(agentCalls).toHaveLength(8);
    for (const call of agentCalls) {
      expect(call.params).toMatchObject({
        lane: "nested",
        channel: "webchat",
      });
    }
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent message context",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent reply step",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent announce step",
          ),
      ),
    ).toBe(true);
    expect(waitCalls).toHaveLength(8);
    expect(historyOnlyCalls).toHaveLength(8);
    expect(sendCallCount).toBe(0);
  });

  it("sessions_send resolves sessionId inputs", async () => {
    callGatewayMock.mockReset();
    const sessionId = "sess-send";
    const targetKey = "agent:main:discord:channel:123";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        return { key: targetKey };
      }
      if (request.method === "agent") {
        return { runId: "run-1", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createMoltbotTools({
      agentSessionKey: "main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_send tool");

    const result = await tool.execute("call7", {
      sessionKey: sessionId,
      message: "ping",
      timeoutSeconds: 0,
    });
    const details = result.details as { status?: string };
    expect(details.status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCall?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_send runs ping-pong then announces", async () => {
    callGatewayMock.mockReset();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "discord:group:target";
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              message?: string;
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
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
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      return {};
    });

    const tool = createMoltbotTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing sessions_send tool");

    const waited = await tool.execute("call7", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "initial",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(4);
    for (const call of agentCalls) {
      expect(call.params).toMatchObject({
        lane: "nested",
        channel: "webchat",
      });
    }

    const replySteps = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replySteps).toHaveLength(2);
    expect(sendParams).toMatchObject({
      to: "channel:target",
      channel: "discord",
      message: "announce now",
    });
  });
});
