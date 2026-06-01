import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createLoadSessionRequest,
  createPromptRequest,
  createChatFinalEvent,
} from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp session metadata and usage updates", () => {
  it("emits a fresh usage snapshot after prompt completion when gateway totals are available", async () => {
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
        _meta: {
          sessionKey: "usage-session",
          kind: "direct",
        },
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
