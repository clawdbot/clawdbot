import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
  createDeferred,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("sessions.list surfaces transcript usage and model fallbacks from the transcript", async () => {
  const { dir } = await createSessionStoreDir();
  testState.agentConfig = {
    models: {
      "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
    },
  };
  await fs.writeFile(
    path.join(dir, "sess-parent.jsonl"),
    `${JSON.stringify({ type: "session", version: 1, id: "sess-parent" })}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "sess-child.jsonl"),
    [
      JSON.stringify({ type: "session", version: 1, id: "sess-child" }),
      JSON.stringify({
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: {
            input: 2_000,
            output: 500,
            cacheRead: 1_000,
            cost: { total: 0.0042 },
          },
        },
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    ].join("\n"),
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent"),
      "dashboard:child": sessionStoreEntry("sess-child", {
        updatedAt: Date.now() - 1_000,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        parentSessionKey: "agent:main:main",
        totalTokens: 0,
        totalTokensFresh: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    },
  });

  const { ws } = await openClient();
  const listed = await rpcReq<{
    sessions: Array<{
      key: string;
      parentSessionKey?: string;
      childSessions?: string[];
      totalTokens?: number;
      totalTokensFresh?: boolean;
      contextTokens?: number;
      estimatedCostUsd?: number;
      modelProvider?: string;
      model?: string;
    }>;
  }>(ws, "sessions.list", {});

  expect(listed.ok).toBe(true);
  const parent = listed.payload?.sessions.find((session) => session.key === "agent:main:main");
  const child = listed.payload?.sessions.find(
    (session) => session.key === "agent:main:dashboard:child",
  );
  expect(parent?.childSessions).toEqual(["agent:main:dashboard:child"]);
  expect(child?.parentSessionKey).toBe("agent:main:main");
  expect(child?.totalTokens).toBe(3_000);
  expect(child?.totalTokensFresh).toBe(true);
  expect(child?.contextTokens).toBe(1_048_576);
  expect(child?.estimatedCostUsd).toBe(0.0042);
  expect(child?.modelProvider).toBe("anthropic");
  expect(child?.model).toBe("claude-sonnet-4-6");

  ws.close();
});

test("sessions.list uses the gateway model catalog for effective thinking defaults", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: "test-provider/reasoner" },
  };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: "test-provider",
        model: "reasoner",
      }),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: "req-sessions-list-thinking-default",
      method: "sessions.list",
      params: {},
    },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [
        {
          provider: "test-provider",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
        },
      ],
    } as never,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          key: "agent:main:main",
          thinkingDefault: "medium",
        }),
      ]),
    }),
    undefined,
  );
});

test("sessions.list does not block on slow model catalog discovery", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  vi.useFakeTimers();
  try {
    const deferredCatalog = createDeferred<never>();
    const respond = vi.fn();
    const sessionsHandlers = await getSessionsHandlers();
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const request = sessionsHandlers["sessions.list"]({
      req: {
        type: "req",
        id: "req-sessions-list-slow-catalog",
        method: "sessions.list",
        params: {},
      },
      params: {},
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn(() => deferredCatalog.promise),
        logGateway: {
          debug: vi.fn(),
        },
      } as never,
    });

    await vi.advanceTimersByTimeAsync(800);
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: expect.arrayContaining([expect.objectContaining({ key: "agent:main:main" })]),
      }),
      undefined,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("sessions.changed mutation events include live usage metadata", async () => {
  const { dir } = await createSessionStoreDir();
  await fs.writeFile(
    path.join(dir, "sess-main.jsonl"),
    [
      JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
      JSON.stringify({
        id: "msg-usage-zero",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          usage: {
            input: 5_107,
            output: 1_827,
            cacheRead: 1_536,
            cacheWrite: 0,
            cost: { total: 0 },
          },
          timestamp: Date.now(),
        },
      }),
    ].join("\n"),
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex-spark",
        contextTokens: 123_456,
        totalTokens: 0,
        totalTokensFresh: false,
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "main",
      label: "Renamed",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:main" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:main",
      reason: "patch",
      totalTokens: 6_643,
      totalTokensFresh: true,
      contextTokens: 123_456,
      estimatedCostUsd: 0,
      modelProvider: "openai-codex",
      model: "gpt-5.3-codex-spark",
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test("sessions.changed mutation events include live session setting metadata", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        verboseLevel: "on",
        responseUsage: "full",
        fastMode: true,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "main",
      verboseLevel: "on",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:main" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:main",
      reason: "patch",
      verboseLevel: "on",
      responseUsage: "full",
      fastMode: true,
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test("sessions.changed mutation events include sendPolicy metadata", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        sendPolicy: "deny",
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "main",
      sendPolicy: "deny",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:main" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:main",
      reason: "patch",
      sendPolicy: "deny",
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test("sessions.changed mutation events include subagent ownership metadata", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "subagent:child": sessionStoreEntry("sess-child", {
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "subagent:child",
      label: "Child",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:subagent:child" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:subagent:child",
      reason: "patch",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent-workspace",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});
