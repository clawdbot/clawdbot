import type {
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

function createNewSessionRequest(cwd = "/tmp"): NewSessionRequest {
  return {
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as NewSessionRequest;
}

function createLoadSessionRequest(sessionId: string, cwd = "/tmp"): LoadSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as unknown as LoadSessionRequest;
}

function createPromptRequest(
  sessionId: string,
  text: string,
  meta: Record<string, unknown> = {},
): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: meta,
  } as unknown as PromptRequest;
}

function createSetSessionModeRequest(sessionId: string, modeId: string): SetSessionModeRequest {
  return {
    sessionId,
    modeId,
    _meta: {},
  } as unknown as SetSessionModeRequest;
}

function createSetSessionConfigOptionRequest(
  sessionId: string,
  configId: string,
  value: string | boolean,
): SetSessionConfigOptionRequest {
  return {
    sessionId,
    configId,
    value,
    _meta: {},
  } as unknown as SetSessionConfigOptionRequest;
}

function createToolEvent(params: {
  sessionKey: string;
  phase: "start" | "update" | "result";
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}): EventFrame {
  return {
    event: "agent",
    payload: {
      sessionKey: params.sessionKey,
      stream: "tool",
      data: {
        phase: params.phase,
        toolCallId: params.toolCallId,
        name: params.name,
        args: params.args,
        partialResult: params.partialResult,
        result: params.result,
        isError: params.isError,
      },
    },
  } as unknown as EventFrame;
}

function createChatFinalEvent(sessionKey: string): EventFrame {
  return {
    event: "chat",
    payload: {
      sessionKey,
      state: "final",
    },
  } as unknown as EventFrame;
}

async function expectOversizedPromptRejected(params: { sessionId: string; text: string }) {
  const request = vi.fn(async () => ({ ok: true })) as GatewayClient["request"];
  const sessionStore = createInMemorySessionStore();
  const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });
  await agent.loadSession(createLoadSessionRequest(params.sessionId));

  await expect(agent.prompt(createPromptRequest(params.sessionId, params.text))).rejects.toThrow(
    /maximum allowed size/i,
  );
  expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything(), expect.anything());
  const session = sessionStore.getSession(params.sessionId);
  expect(session?.activeRunId).toBeNull();
  expect(session?.abortController).toBeNull();

  sessionStore.clearAllSessionsForTest();
}

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function configOptions(value: unknown) {
  expect(Array.isArray(value), "config options").toBe(true);
  return value as Array<Record<string, unknown>>;
}

function expectConfigOption(options: unknown, id: string, fields: Record<string, unknown>) {
  const option = configOptions(options).find((candidate) => candidate.id === id);
  expect(option, `config option ${id}`).toBeDefined();
  for (const [field, value] of Object.entries(fields)) {
    expect(option?.[field]).toEqual(value);
  }
}

function sessionUpdatePayloads(source: MockCallSource, updateType?: string) {
  const payloads = source.mock.calls.map((call, index) => {
    const envelope = requireRecord(call[0], `session update envelope ${index}`);
    return {
      sessionId: envelope.sessionId,
      update: requireRecord(envelope.update, `session update ${index}`),
    };
  });
  if (!updateType) {
    return payloads;
  }
  return payloads.filter((payload) => payload.update.sessionUpdate === updateType);
}

function expectSessionUpdate(source: MockCallSource, sessionId: string, updateType: string) {
  const update = sessionUpdatePayloads(source, updateType).find(
    (payload) => payload.sessionId === sessionId,
  )?.update;
  if (!update) {
    throw new Error(`expected ${sessionId} ${updateType}`);
  }
  return update;
}

describe("acp session creation rate limit", () => {
  it("rate limits excessive newSession bursts", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.newSession(createNewSessionRequest());
    await expect(agent.newSession(createNewSessionRequest())).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("does not count loadSession refreshes for an existing session ID", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await expect(agent.loadSession(createLoadSessionRequest("new-session"))).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp unsupported bridge session setup", () => {
  it("rejects per-session MCP servers on newSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.newSession({
        ...createNewSessionRequest(),
        mcpServers: [{ name: "docs", command: "mcp-docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });

  it("rejects per-session MCP servers on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.loadSession({
        ...createLoadSessionRequest("docs-session"),
        mcpServers: [{ name: "docs", command: "mcp-docs" }] as never[],
      }),
    ).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionStore.hasSession("docs-session")).toBe(false);
    expect(sessionUpdate).not.toHaveBeenCalled();
    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp session UX bridge behavior", () => {
  it("returns initial modes and thought-level config options for new sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toContain("adaptive");
    expectConfigOption(result.configOptions, "thought_level", {
      currentValue: "adaptive",
      category: "thought_level",
    });
    expectConfigOption(result.configOptions, "verbose_level", { currentValue: "off" });
    expectConfigOption(result.configOptions, "reasoning_level", { currentValue: "off" });
    expectConfigOption(result.configOptions, "response_usage", { currentValue: "off" });
    expectConfigOption(result.configOptions, "elevated_level", { currentValue: "off" });

    sessionStore.clearAllSessionsForTest();
  });

  it("replays user text, assistant text, and hidden assistant thinking on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:work",
              label: "main-work",
              displayName: "Main work",
              derivedTitle: "Fix ACP bridge",
              kind: "direct",
              updatedAt: 1_710_000_000_000,
              thinkingLevel: "high",
              modelProvider: "openai",
              model: "gpt-5.4",
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "medium", label: "medium" },
                { id: "max", label: "max" },
              ],
              verboseLevel: "full",
              reasoningLevel: "stream",
              responseUsage: "tokens",
              elevatedLevel: "ask",
              totalTokens: 4096,
              totalTokensFresh: true,
              contextTokens: 8192,
            },
          ],
        };
      }
      if (method === "sessions.get") {
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "Question" }] },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Internal loop about NO_REPLY" },
                { type: "text", text: "Answer" },
              ],
            },
            { role: "system", content: [{ type: "text", text: "ignore me" }] },
            { role: "assistant", content: [{ type: "image", image: "skip" }] },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:work"));

    expect(result.modes?.currentModeId).toBe("high");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toEqual([
      "off",
      "medium",
      "max",
      "high",
    ]);
    expectConfigOption(result.configOptions, "thought_level", { currentValue: "high" });
    expectConfigOption(result.configOptions, "verbose_level", { currentValue: "full" });
    expectConfigOption(result.configOptions, "reasoning_level", { currentValue: "stream" });
    expectConfigOption(result.configOptions, "response_usage", { currentValue: "tokens" });
    expectConfigOption(result.configOptions, "elevated_level", { currentValue: "ask" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Question" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Internal loop about NO_REPLY" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });
    expectSessionUpdate(sessionUpdate, "agent:main:work", "available_commands_update");
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "session_info_update",
        title: "Fix ACP bridge",
        updatedAt: "2024-03-09T16:00:00.000Z",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "usage_update",
        used: 4096,
        size: 8192,
        _meta: {
          source: "gateway-session-store",
          approximate: true,
        },
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("falls back to an empty transcript when sessions.get fails during loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:recover",
              label: "recover",
              displayName: "Recover session",
              kind: "direct",
              updatedAt: 1_710_000_000_000,
              thinkingLevel: "adaptive",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      if (method === "sessions.get") {
        throw new Error("sessions.get unavailable");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.loadSession(createLoadSessionRequest("agent:main:recover"));

    expect(result.modes?.currentModeId).toBe("adaptive");
    expectSessionUpdate(sessionUpdate, "agent:main:recover", "available_commands_update");
    expect(sessionUpdatePayloads(sessionUpdate, "user_message_chunk")).toEqual([]);

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp setSessionMode bridge behavior", () => {
  it("surfaces gateway mode patch failures instead of succeeding silently", async () => {
    const sessionStore = createInMemorySessionStore();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        throw new Error("gateway rejected mode");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("mode-session"));

    await expect(
      agent.setSessionMode(createSetSessionModeRequest("mode-session", "high")),
    ).rejects.toThrow(/gateway rejected mode/i);

    sessionStore.clearAllSessionsForTest();
  });

  it("emits current mode and thought-level config updates after a successful mode change", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "mode-session",
              kind: "direct",
              updatedAt: Date.now(),
              thinkingLevel: "high",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("mode-session"));
    sessionUpdate.mockClear();

    await agent.setSessionMode(createSetSessionModeRequest("mode-session", "high"));

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "mode-session",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "high",
      },
    });
    expectConfigOption(
      expectSessionUpdate(sessionUpdate, "mode-session", "config_option_update").configOptions,
      "thought_level",
      { currentValue: "high" },
    );

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp setSessionConfigOption bridge behavior", () => {
  it("updates the thought-level config option and returns refreshed options", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "config-session",
              kind: "direct",
              updatedAt: Date.now(),
              thinkingLevel: "minimal",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("config-session"));
    sessionUpdate.mockClear();

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("config-session", "thought_level", "minimal"),
    );

    expectConfigOption(result.configOptions, "thought_level", { currentValue: "minimal" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "config-session",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "minimal",
      },
    });
    expectConfigOption(
      expectSessionUpdate(sessionUpdate, "config-session", "config_option_update").configOptions,
      "thought_level",
      { currentValue: "minimal" },
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("updates non-mode ACP config options through gateway session patches", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "reasoning-session",
              kind: "direct",
              updatedAt: Date.now(),
              thinkingLevel: "minimal",
              modelProvider: "openai",
              model: "gpt-5.4",
              reasoningLevel: "stream",
            },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("reasoning-session"));
    sessionUpdate.mockClear();

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("reasoning-session", "reasoning_level", "stream"),
    );

    expectConfigOption(result.configOptions, "reasoning_level", { currentValue: "stream" });
    expectConfigOption(
      expectSessionUpdate(sessionUpdate, "reasoning-session", "config_option_update").configOptions,
      "reasoning_level",
      { currentValue: "stream" },
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("updates fast mode ACP config options through gateway session patches", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "fast-session",
              kind: "direct",
              updatedAt: Date.now(),
              thinkingLevel: "minimal",
              modelProvider: "openai",
              model: "gpt-5.4",
              fastMode: true,
            },
          ],
        };
      }
      if (method === "sessions.patch") {
        expect(_params).toEqual({
          key: "fast-session",
          fastMode: true,
        });
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("fast-session"));
    sessionUpdate.mockClear();

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("fast-session", "fast_mode", "on"),
    );

    expectConfigOption(result.configOptions, "fast_mode", { currentValue: "on" });
    expectConfigOption(
      expectSessionUpdate(sessionUpdate, "fast-session", "config_option_update").configOptions,
      "fast_mode",
      { currentValue: "on" },
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("accepts forwarded timeout config options without failing OpenClaw ACP bridge turns", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "timeout-session",
              kind: "direct",
              updatedAt: Date.now(),
              thinkingLevel: "minimal",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      expect(method).not.toBe("sessions.patch");
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("timeout-session"));

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("timeout-session", "timeout", "180"),
    );
    expect(Array.isArray(result.configOptions)).toBe(true);

    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());

    sessionStore.clearAllSessionsForTest();
  });

  it("rejects non-string ACP config option values", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "bool-config-session",
              kind: "direct",
              updatedAt: Date.now(),
              thinkingLevel: "minimal",
              modelProvider: "openai",
              model: "gpt-5.4",
            },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("bool-config-session"));

    await expect(
      agent.setSessionConfigOption(
        createSetSessionConfigOptionRequest("bool-config-session", "thought_level", false),
      ),
    ).rejects.toThrow(
      'ACP bridge does not support non-string session config option values for "thought_level".',
    );
    expect(
      (request as unknown as MockCallSource).mock.calls.some(
        ([method, params]) =>
          method === "sessions.patch" &&
          requireRecord(params, "sessions.patch params").key === "bool-config-session",
      ),
    ).toBe(false);

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp tool streaming bridge behavior", () => {
  it("maps Gateway tool partial output and file locations into ACP tool updates", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("tool-session"));
    sessionUpdate.mockClear();

    const promptPromise = agent.prompt(createPromptRequest("tool-session", "Inspect app.ts"));

    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "tool-session",
        phase: "start",
        toolCallId: "tool-1",
        name: "read",
        args: { path: "src/app.ts", line: 12 },
      }),
    );
    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "tool-session",
        phase: "update",
        toolCallId: "tool-1",
        name: "read",
        partialResult: {
          content: [{ type: "text", text: "partial output" }],
          details: { path: "src/app.ts" },
        },
      }),
    );
    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: "tool-session",
        phase: "result",
        toolCallId: "tool-1",
        name: "read",
        result: {
          content: [{ type: "text", text: "FILE:src/app.ts" }],
          details: { path: "src/app.ts" },
        },
      }),
    );
    await agent.handleGatewayEvent(createChatFinalEvent("tool-session"));
    await promptPromise;

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "read: path: src/app.ts, line: 12",
        status: "in_progress",
        rawInput: { path: "src/app.ts", line: 12 },
        kind: "read",
        locations: [{ path: "src/app.ts", line: 12 }],
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "in_progress",
        rawOutput: {
          content: [{ type: "text", text: "partial output" }],
          details: { path: "src/app.ts" },
        },
        content: [
          {
            type: "content",
            content: { type: "text", text: "partial output" },
          },
        ],
        locations: [{ path: "src/app.ts", line: 12 }],
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "tool-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: {
          content: [{ type: "text", text: "FILE:src/app.ts" }],
          details: { path: "src/app.ts" },
        },
        content: [
          {
            type: "content",
            content: { type: "text", text: "FILE:src/app.ts" },
          },
        ],
        locations: [{ path: "src/app.ts", line: 12 }],
      },
    });

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp session metadata and usage updates", () => {
  it("emits a fresh usage snapshot after prompt completion when gateway totals are available", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "usage-session",
              displayName: "Usage session",
              kind: "direct",
              updatedAt: 1_710_000_123_000,
              thinkingLevel: "adaptive",
              modelProvider: "openai",
              model: "gpt-5.4",
              totalTokens: 1200,
              totalTokensFresh: true,
              contextTokens: 4000,
            },
          ],
        };
      }
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("usage-session"));
    sessionUpdate.mockClear();

    const promptPromise = agent.prompt(createPromptRequest("usage-session", "hello"));
    await agent.handleGatewayEvent(createChatFinalEvent("usage-session"));
    await promptPromise;

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "usage-session",
      update: {
        sessionUpdate: "session_info_update",
        title: "Usage session",
        updatedAt: "2024-03-09T16:02:03.000Z",
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "usage-session",
      update: {
        sessionUpdate: "usage_update",
        used: 1200,
        size: 4000,
        _meta: {
          source: "gateway-session-store",
          approximate: true,
        },
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("still resolves prompts when snapshot updates fail after completion", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: Date.now(),
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "usage-session",
              displayName: "Usage session",
              kind: "direct",
              updatedAt: 1_710_000_123_000,
              thinkingLevel: "adaptive",
              modelProvider: "openai",
              model: "gpt-5.4",
              totalTokens: 1200,
              totalTokensFresh: true,
              contextTokens: 4000,
            },
          ],
        };
      }
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("usage-session"));
    sessionUpdate.mockClear();
    sessionUpdate.mockRejectedValueOnce(new Error("session update transport failed"));

    const promptPromise = agent.prompt(createPromptRequest("usage-session", "hello"));
    await agent.handleGatewayEvent(createChatFinalEvent("usage-session"));

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    const session = sessionStore.getSession("usage-session");
    expect(session?.activeRunId).toBeNull();
    expect(session?.abortController).toBeNull();

    sessionStore.clearAllSessionsForTest();
  });
});

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});

describe("acp final chat snapshots", () => {
  async function createSnapshotHarness() {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return new Promise(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });
    await agent.loadSession(createLoadSessionRequest("snapshot-session"));
    sessionUpdate.mockClear();
    const promptPromise = agent.prompt(createPromptRequest("snapshot-session", "hello"));
    const runId = sessionStore.getSession("snapshot-session")?.activeRunId;
    if (!runId) {
      throw new Error("Expected ACP prompt run to be active");
    }
    return { agent, sessionUpdate, promptPromise, runId, sessionStore };
  }

  it("emits final snapshot text before resolving end_turn", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "final",
        stopReason: "end_turn",
        message: {
          content: [{ type: "text", text: "FINAL TEXT SHOULD BE EMITTED" }],
        },
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "FINAL TEXT SHOULD BE EMITTED" },
      },
    });
    expect(sessionStore.getSession("snapshot-session")?.activeRunId).toBeNull();
    sessionStore.clearAllSessionsForTest();
  });

  it("does not duplicate text when final repeats the last delta snapshot", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "delta",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    } as unknown as EventFrame);

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "final",
        stopReason: "end_turn",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
    const chunks = sessionUpdate.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>)?.update &&
        (call[0] as Record<string, Record<string, unknown>>).update?.sessionUpdate ===
          "agent_message_chunk",
    );
    expect(chunks).toHaveLength(1);
    sessionStore.clearAllSessionsForTest();
  });

  it("emits only the missing tail when the final snapshot extends prior deltas", async () => {
    const { agent, sessionUpdate, promptPromise, runId, sessionStore } =
      await createSnapshotHarness();

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "delta",
        message: {
          content: [{ type: "text", text: "Hello" }],
        },
      },
    } as unknown as EventFrame);

    await agent.handleGatewayEvent({
      event: "chat",
      payload: {
        sessionKey: "snapshot-session",
        runId,
        state: "final",
        stopReason: "max_tokens",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
      },
    } as unknown as EventFrame);

    await expect(promptPromise).resolves.toEqual({ stopReason: "max_tokens" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "snapshot-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " world" },
      },
    });
    sessionStore.clearAllSessionsForTest();
  });
});
