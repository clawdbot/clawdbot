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

type MockCalls = {
  mock: { calls: unknown[][] };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value), `${label} should be an object`).toBe(true);
  if (!isRecord(value)) {
    throw new Error(`${label} should be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), `${label} should be an array`).toBe(true);
  if (!Array.isArray(value)) {
    throw new Error(`${label} should be an array`);
  }
  return value;
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function expectRespondPayload(respond: MockCalls): Record<string, unknown> {
  expect(respond.mock.calls).toHaveLength(1);
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  expect(error).toBeUndefined();
  return requireRecord(payload, "response payload");
}

function findSession(
  payload: Record<string, unknown>,
  sessionKey: string,
): Record<string, unknown> {
  const sessions = requireArray(payload.sessions, "response sessions");
  const session = sessions.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.key === sessionKey,
  );
  if (!session) {
    throw new Error(`Missing session ${sessionKey}`);
  }
  return session;
}

function expectChangedBroadcast(
  broadcastToConnIds: MockCalls,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expect(broadcastToConnIds.mock.calls).toHaveLength(1);
  const [event, payload, connIds, options] = broadcastToConnIds.mock.calls[0] ?? [];
  expect(event).toBe("sessions.changed");
  expect(connIds).toEqual(new Set(["conn-1"]));
  expect(options).toEqual({ dropIfSlow: true });
  const payloadRecord = requireRecord(payload, "broadcast payload");
  expectFields(payloadRecord, expected);
  return payloadRecord;
}

test("sessions.list keeps bulk rows lightweight and uses persisted model fields", async () => {
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
  expect(child?.totalTokens).toBeUndefined();
  expect(child?.totalTokensFresh).toBe(false);
  expect(child?.contextTokens).toBeUndefined();
  expect(child?.estimatedCostUsd).toBeUndefined();
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

  const payload = expectRespondPayload(respond);
  const defaults = requireRecord(payload.defaults, "response defaults");
  expect(defaults.thinkingDefault).toBe("medium");
  const session = findSession(payload, "agent:main:main");
  expectFields(session, {
    thinkingDefault: "medium",
    thinkingOptions: ["off", "minimal", "low", "medium", "high"],
  });
});

test("sessions.list marks sessions with active abortable runs", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: "req-sessions-list-active-run",
      method: "sessions.list",
      params: {},
    },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      chatAbortControllers: new Map([["run-1", { sessionKey: "agent:main:main" }]]),
    } as never,
  });

  const payload = expectRespondPayload(respond);
  const session = findSession(payload, "agent:main:main");
  expect(session.hasActiveRun).toBe(true);
});

test("sessions.list yields before responding during bulk transcript hydration", async () => {
  const { dir } = await createSessionStoreDir();
  const entries: Record<string, ReturnType<typeof sessionStoreEntry>> = {};
  const now = Date.now();
  for (let i = 0; i < 11; i += 1) {
    const sessionId = `sess-list-yield-${i}`;
    entries[`bulk-${i}`] = sessionStoreEntry(sessionId, { updatedAt: now - i });
    await fs.writeFile(
      path.join(dir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({ message: { role: "user", content: `title ${i}` } }),
        JSON.stringify({ message: { role: "assistant", content: `last ${i}` } }),
      ].join("\n"),
      "utf-8",
    );
  }
  await writeSessionStore({ entries });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const request = sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: "req-sessions-list-yield",
      method: "sessions.list",
      params: {
        includeDerivedTitles: true,
        includeLastMessage: true,
        limit: 11,
      },
    },
    params: {
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 11,
    },
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      logGateway: {
        debug: vi.fn(),
      },
    } as never,
  });

  await Promise.resolve();
  await Promise.resolve();

  expect(respond).not.toHaveBeenCalled();
  await request;
  const payload = expectRespondPayload(respond);
  const session = findSession(payload, "agent:main:bulk-0");
  expectFields(session, {
    derivedTitle: "title 0",
    lastMessagePreview: "last 0",
  });
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

    const payload = expectRespondPayload(respond);
    findSession(payload, "agent:main:main");
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

  const responsePayload = expectRespondPayload(respond);
  expectFields(responsePayload, { ok: true, key: "agent:main:main" });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    totalTokens: 6_643,
    totalTokensFresh: true,
    contextTokens: 123_456,
    estimatedCostUsd: 0,
    modelProvider: "openai-codex",
    model: "gpt-5.3-codex-spark",
  });
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

  const responsePayload = expectRespondPayload(respond);
  expectFields(responsePayload, { ok: true, key: "agent:main:main" });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    verboseLevel: "on",
    responseUsage: "full",
    fastMode: true,
    lastChannel: "telegram",
    lastTo: "-100123",
    lastAccountId: "acct-1",
    lastThreadId: 42,
  });
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

  const responsePayload = expectRespondPayload(respond);
  expectFields(responsePayload, { ok: true, key: "agent:main:main" });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    sendPolicy: "deny",
  });
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

  const responsePayload = expectRespondPayload(respond);
  expectFields(responsePayload, { ok: true, key: "agent:main:subagent:child" });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "agent:main:subagent:child",
    reason: "patch",
    spawnedBy: "agent:main:main",
    spawnedWorkspaceDir: "/tmp/subagent-workspace",
    forkedFromParent: true,
    spawnDepth: 2,
    subagentRole: "orchestrator",
    subagentControlScope: "children",
  });
});
