/** Tests ACP translator session setup constraints and initial updates. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import {
  createNewSessionRequest,
  createLoadSessionRequest,
  expectConfigOption,
  sessionUpdatePayloads,
  expectSessionUpdate,
} from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp unsupported bridge session setup", () => {
  it("rejects per-session MCP servers on newSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
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
    const sessionUpdate = connection["__sessionUpdateMock"];
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
  it("uses a non-runtime namespace for generated bridge sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());
    const sessionKey = sessionStore.getSession(result.sessionId)?.sessionKey;

    expect(sessionKey).toMatch(/^acp-bridge:/);
    expect(isAcpSessionKey(sessionKey)).toBe(false);

    sessionStore.clearAllSessionsForTest();
  });

  it("returns initial modes and thought-level config options for new sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(result.modes?.currentModeId).toBe("adaptive");
    expect(result.modes?.availableModes.map((mode) => mode.id)).toStrictEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
    ]);
    expectConfigOption(result.configOptions, "thought_level", {
      currentValue: "adaptive",
      category: "thought_level",
    });
    expectConfigOption(result.configOptions, "verbose_level", { currentValue: "off" });
    expectConfigOption(result.configOptions, "reasoning_level", { currentValue: "off" });
    // Unset session inherits the configured default → control reads "inherit", not "off".
    expectConfigOption(result.configOptions, "response_usage", { currentValue: "inherit" });
    expectConfigOption(result.configOptions, "elevated_level", { currentValue: "off" });

    sessionStore.clearAllSessionsForTest();
  });

  it("replays user text, assistant text, and hidden assistant thinking on loadSession", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
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
        _meta: {
          sessionKey: "agent:main:work",
          kind: "direct",
        },
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
    const sessionUpdate = connection["__sessionUpdateMock"];
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
