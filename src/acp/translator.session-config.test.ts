import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createLoadSessionRequest,
  createSetSessionModeRequest,
  createSetSessionConfigOptionRequest,
  type MockCallSource,
  requireRecord,
  expectConfigOption,
  expectSessionUpdate,
} from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

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
    const sessionUpdate = connection["__sessionUpdateMock"];
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
    const requestMock = vi.fn(async (method: string) => {
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
    });
    const request = requestMock as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("timeout-session"));

    const result = await agent.setSessionConfigOption(
      createSetSessionConfigOptionRequest("timeout-session", "timeout", "180"),
    );
    expect(Array.isArray(result.configOptions)).toBe(true);

    expect(requestMock.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);

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
