/**
 * Gateway sessions.list changed-state tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, expect, test, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  pinActivePluginSessionExtensionRegistry,
  releasePinnedPluginSessionExtensionRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { buildGatewaySessionRow } from "./session-utils.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
  createDeferred,
  createLinearSessionTranscript,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsTestHarness();

afterEach(() => {
  releasePinnedPluginSessionExtensionRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

type MockCalls = {
  mock: { calls: unknown[][] };
};
type SessionStoreEntryOptions = Parameters<typeof sessionStoreEntry>[1];
type MutationMethod = "sessions.patch" | "sessions.compact";

function expectedLastMessageTranscript(sessionId: string, contents: string[]): string {
  const records = createLinearSessionTranscript(sessionId, contents)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = records[0];
  const last = records.at(-1);
  if (!header || !last) {
    throw new Error("expected a canonical transcript fixture");
  }
  return `${JSON.stringify(header)}\n${JSON.stringify({ ...last, parentId: null })}\n`;
}

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

async function invokeSessionsList({
  requestId,
  params = {},
  context = {},
  defer = false,
}: {
  requestId: string;
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  defer?: boolean;
}) {
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const request = sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: requestId,
      method: "sessions.list",
      params,
    },
    params,
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      ...context,
    } as never,
  });
  if (!defer) {
    await request;
  }
  return { request, respond };
}

async function invokeSessionMutation({
  method,
  params,
  context = {},
  subscribedConnIds = new Set(["conn-1"]),
}: {
  method: MutationMethod;
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
  subscribedConnIds?: Set<string>;
}) {
  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers[method]({
    req: {} as never,
    params,
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => subscribedConnIds,
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig,
      ...context,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return {
    broadcastToConnIds,
    responsePayload: expectRespondPayload(respond),
  };
}

async function invokeSessionsPatch(params: Record<string, unknown>) {
  return invokeSessionMutation({ method: "sessions.patch", params });
}

async function writeMainSessionStore(options?: SessionStoreEntryOptions) {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", options),
    },
  });
}

function expectMainPatchBroadcast(
  result: Awaited<ReturnType<typeof invokeSessionsPatch>>,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expectFields(result.responsePayload, { ok: true, key: "agent:main:main" });
  return expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    ...expected,
  });
}

test("sessions.pluginPatch over WebSocket keeps pinned startup extensions after active churn", async () => {
  const { config, registry } = createPluginRegistryFixture();
  registerTestPlugin({
    registry,
    config,
    record: createPluginRecord({
      id: "session-pin-ws-fixture",
      name: "Session Pin WS Fixture",
    }),
    register(api) {
      api.registerSessionExtension({
        namespace: "workflow",
        description: "Pinned workflow state",
      });
    },
  });
  setActivePluginRegistry(registry.registry);
  pinActivePluginSessionExtensionRegistry(registry.registry);
  setActivePluginRegistry(createEmptyPluginRegistry());

  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const { ws } = await openClient();
  const patched = await rpcReq<{ ok: boolean; key: string; value: { state: string } }>(
    ws,
    "sessions.pluginPatch",
    {
      key: "main",
      pluginId: "session-pin-ws-fixture",
      namespace: "workflow",
      value: { state: "after-active-registry-churn" },
    },
  );
  ws.close();

  expect(patched.ok).toBe(true);
  expect(patched.payload).toEqual({
    ok: true,
    key: "agent:main:main",
    value: { state: "after-active-registry-churn" },
  });

  const store = loadSessionStore(storePath);
  const entry = store.main ?? store["agent:main:main"];
  expect(entry).toBeDefined();
  const row = buildGatewaySessionRow({
    cfg: { session: { store: storePath } },
    storePath,
    store,
    key: "agent:main:main",
    entry,
  });
  expect(row.pluginExtensions).toEqual([
    {
      pluginId: "session-pin-ws-fixture",
      namespace: "workflow",
      value: { state: "after-active-registry-churn" },
    },
  ]);
});

async function invokeSessionsCompact({
  getRuntimeConfig,
  params,
  subscribedConnIds = new Set(["conn-1"]),
}: {
  getRuntimeConfig: unknown;
  params: Record<string, unknown>;
  subscribedConnIds?: Set<string>;
}) {
  return invokeSessionMutation({
    method: "sessions.compact",
    params,
    context: {
      getRuntimeConfig,
    },
    subscribedConnIds,
  });
}

async function expectListedSessionActiveRun(
  requestId: string,
  run: Record<string, unknown>,
  expected: boolean,
) {
  await writeMainSessionStore();

  const { respond } = await invokeSessionsList({
    requestId,
    context: {
      chatAbortControllers: new Map([["run-1", { sessionKey: "agent:main:main", ...run }]]),
    },
  });

  const payload = expectRespondPayload(respond);
  const session = findSession(payload, "agent:main:main");
  expect(session.hasActiveRun).toBe(expected);
  expect(session.activeRunIds).toEqual(expected ? ["run-1"] : undefined);
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
        model: "test-model-without-catalog-context",
        modelSelectionLocked: true,
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
      modelSelectionLocked?: boolean;
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
  expect(child?.model).toBe("test-model-without-catalog-context");
  expect(child?.modelSelectionLocked).toBe(true);

  ws.close();
});

test("sessions.list uses the gateway model catalog for effective thinking defaults", async () => {
  testState.agentConfig = {
    model: { primary: "test-provider/reasoner" },
  };
  await writeMainSessionStore({
    modelProvider: "test-provider",
    model: "reasoner",
  });

  const { respond } = await invokeSessionsList({
    requestId: "req-sessions-list-thinking-default",
    context: {
      loadGatewayModelCatalog: async () => [
        {
          provider: "test-provider",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
        },
      ],
    },
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

test.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
  "sessions.patch returns authoritative native Codex Ultra metadata for %s",
  async (model) => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        resolveThinkingProfile: ({ compat }) => ({
          levels: [
            { id: "off" },
            { id: "high" },
            { id: "max" },
            ...(compat?.supportedReasoningEfforts?.includes("ultra")
              ? [{ id: "ultra" as const }]
              : []),
          ],
          defaultLevel: "high",
        }),
      },
    });
    setActivePluginRegistry(registry);
    testState.agentConfig = {
      model: { primary: `openai/${model}` },
      models: {
        [`openai/${model}`]: { agentRuntime: { id: "codex" } },
      },
    };
    await writeMainSessionStore({ modelProvider: "openai", model });
    const loadGatewayModelCatalog = vi.fn(async () => [
      {
        provider: "openai",
        id: model,
        name: model,
        reasoning: true,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      },
    ]);

    const result = await invokeSessionMutation({
      method: "sessions.patch",
      params: { key: "main", thinkingLevel: "ultra" },
      context: { loadGatewayModelCatalog },
    });

    const resolved = requireRecord(result.responsePayload.resolved, "resolved patch metadata");
    expectFields(resolved, {
      modelProvider: "openai",
      model,
      thinkingLevel: "ultra",
    });
    expect(requireRecord(resolved.agentRuntime, "resolved agent runtime").id).toBe("codex");
    expect(
      requireArray(resolved.thinkingLevels, "resolved thinking levels").map(
        (level) => requireRecord(level, "thinking level").id,
      ),
    ).toContain("ultra");
    expect(loadGatewayModelCatalog).toHaveBeenCalledTimes(1);

    const event = expectChangedBroadcast(result.broadcastToConnIds, {
      sessionKey: "agent:main:main",
      reason: "patch",
      thinkingLevel: "ultra",
    });
    expect(event).not.toHaveProperty("thinkingLevels");
    expect(event).not.toHaveProperty("thinkingOptions");
    expect(event).not.toHaveProperty("thinkingDefault");
  },
);

test("sessions.patch omits thinking metadata when an unrelated patch skips the catalog", async () => {
  testState.agentConfig = {
    model: { primary: "synthetic/plain" },
  };
  await writeMainSessionStore({
    modelProvider: "synthetic",
    model: "plain",
    thinkingLevel: "max",
  });
  const loadGatewayModelCatalog = vi.fn(async () => [
    {
      provider: "synthetic",
      id: "plain",
      name: "plain",
      reasoning: false,
    },
  ]);

  const result = await invokeSessionMutation({
    method: "sessions.patch",
    params: { key: "main", label: "Renamed" },
    context: { loadGatewayModelCatalog },
  });

  const resolved = requireRecord(result.responsePayload.resolved, "resolved patch metadata");
  expect(resolved).not.toHaveProperty("thinkingLevel");
  expect(resolved).not.toHaveProperty("thinkingLevels");
  expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    thinkingLevel: "max",
  });
});

test("sessions.list exposes effective fast auto defaults from the selected model", async () => {
  testState.agentConfig = {
    model: { primary: "openai/gpt-5.5" },
    models: {
      "openai/gpt-5.5": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
    },
  };
  await writeMainSessionStore({
    modelProvider: "openai",
    model: "gpt-5.5",
  });

  const { respond } = await invokeSessionsList({
    requestId: "req-sessions-list-fast-default",
  });

  const payload = expectRespondPayload(respond);
  const session = findSession(payload, "agent:main:main");
  expectFields(session, {
    fastMode: undefined,
    effectiveFastMode: "auto",
    effectiveFastModeSource: "config",
    fastAutoOnSeconds: 30,
  });
});

test("sessions.list resolves effective fast metadata from the raw runtime provider", async () => {
  testState.agentConfig = {
    model: { primary: "openai-codex/gpt-5.5" },
    models: {
      "openai/gpt-5.5": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
      "openai-codex/gpt-5.5": { params: { fastMode: false, fastAutoOnSeconds: 45 } },
    },
  };
  await writeMainSessionStore({
    modelProvider: "openai-codex",
    model: "gpt-5.5",
  });

  const { respond } = await invokeSessionsList({
    requestId: "req-sessions-list-fast-raw-provider",
  });

  const payload = expectRespondPayload(respond);
  const session = findSession(payload, "agent:main:main");
  expectFields(session, {
    effectiveFastMode: false,
    effectiveFastModeSource: "config",
    fastAutoOnSeconds: 45,
  });
});

test("sessions.changed mutation events refresh effective fast metadata", async () => {
  testState.agentConfig = {
    model: { primary: "openai/gpt-5.5" },
    models: {
      "openai/gpt-5.5": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
    },
  };
  await writeMainSessionStore({
    modelProvider: "openai",
    model: "gpt-5.5",
  });

  const result = await invokeSessionsPatch({
    key: "main",
    fastMode: false,
  });

  expectMainPatchBroadcast(result, {
    fastMode: false,
    effectiveFastMode: false,
    effectiveFastModeSource: "session",
    fastAutoOnSeconds: 30,
  });
});

test("sessions.list marks sessions with active abortable runs", async () => {
  await expectListedSessionActiveRun("req-sessions-list-active-run", {}, true);
});

test("sessions.changed publishes visible active run ids", async () => {
  await writeMainSessionStore();
  const result = await invokeSessionMutation({
    method: "sessions.patch",
    params: { key: "main", label: "Active main" },
    context: {
      chatAbortControllers: new Map([["run-1", { sessionKey: "agent:main:main" }]]),
    },
  });

  expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    hasActiveRun: true,
    activeRunIds: ["run-1"],
  });
});

test("sessions.list ignores terminal abortable runs kept for retry guards", async () => {
  await expectListedSessionActiveRun(
    "req-sessions-list-terminal-run",
    { projectSessionActive: false },
    false,
  );
});

test("sessions.list ignores hidden internal abortable runs", async () => {
  await expectListedSessionActiveRun(
    "req-sessions-list-hidden-run",
    { controlUiVisible: false },
    false,
  );
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

  const { request, respond } = await invokeSessionsList({
    requestId: "req-sessions-list-yield",
    defer: true,
    params: {
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 11,
    },
    context: {
      logGateway: {
        debug: vi.fn(),
      },
    },
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
  await writeMainSessionStore();

  vi.useFakeTimers();
  try {
    const deferredCatalog = createDeferred<never>();
    const { request, respond } = await invokeSessionsList({
      requestId: "req-sessions-list-slow-catalog",
      defer: true,
      context: {
        loadGatewayModelCatalog: vi.fn(() => deferredCatalog.promise),
        logGateway: {
          debug: vi.fn(),
        },
      },
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
          provider: "openai",
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
        modelProvider: "openai",
        model: "gpt-5.3-codex-spark",
        contextTokens: 123_456,
        totalTokens: 0,
        totalTokensFresh: false,
      }),
    },
  });

  const result = await invokeSessionsPatch({
    key: "main",
    label: "Renamed",
  });

  expectMainPatchBroadcast(result, {
    totalTokens: 6_643,
    totalTokensFresh: true,
    contextTokens: 123_456,
    estimatedCostUsd: 0,
    modelProvider: "openai",
    model: "gpt-5.3-codex-spark",
  });
});

test("sessions.changed mutation events include live session setting metadata", async () => {
  const sessionSettings = {
    verboseLevel: "on",
    responseUsage: "full",
    fastMode: true,
    lastChannel: "telegram",
    lastTo: "-100123",
    lastAccountId: "acct-1",
    lastThreadId: 42,
  } satisfies SessionStoreEntryOptions;
  await writeMainSessionStore(sessionSettings);

  const result = await invokeSessionsPatch({
    key: "main",
    verboseLevel: "on",
  });

  expectMainPatchBroadcast(result, {
    ...sessionSettings,
    // An explicit session override resolves to the same effective mode and the
    // sessions.changed builder carries the row-built channel-aware value.
    effectiveResponseUsage: "full",
  });
});

test("sessions.changed mutation events carry the resolved effectiveResponseUsage when the session has no override", async () => {
  // No explicit responseUsage and no configured default → the row builder resolves
  // effectiveResponseUsage to "off". The event must carry that resolved value, not
  // the absent raw responseUsage, so a UI consumer's effective display stays fresh.
  await writeMainSessionStore({ verboseLevel: "on" });

  const result = await invokeSessionsPatch({
    key: "main",
    verboseLevel: "on",
  });

  const payload = expectMainPatchBroadcast(result, {
    effectiveResponseUsage: "off",
  });
  // Raw responseUsage is genuinely absent (no override), proving the event does not
  // merely echo the raw field.
  expect(payload.responseUsage).toBeUndefined();
});

test("sessions.changed mutation events include sendPolicy metadata", async () => {
  await writeMainSessionStore({
    sendPolicy: "deny",
  });

  const result = await invokeSessionsPatch({
    key: "main",
    sendPolicy: "deny",
  });

  expectMainPatchBroadcast(result, {
    sendPolicy: "deny",
  });
});

test("sessions.changed mutation events include session management metadata", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-dev", {
        pinnedAt: 10,
        lastReadAt: 20,
        lastActivityAt: 5,
      }),
    },
  });

  const archived = await invokeSessionsPatch({
    key: "discord:group:dev",
    archived: true,
  });
  expectChangedBroadcast(archived.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    archived: true,
    archivedAt: expect.any(Number),
    pinned: false,
    pinnedAt: null,
    unread: false,
    lastReadAt: 20,
    lastActivityAt: 5,
  });

  const restored = await invokeSessionsPatch({
    key: "discord:group:dev",
    archived: false,
  });
  expectChangedBroadcast(restored.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    archived: false,
    archivedAt: null,
  });

  const pinned = await invokeSessionsPatch({
    key: "discord:group:dev",
    pinned: true,
  });
  expectChangedBroadcast(pinned.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    pinned: true,
    pinnedAt: expect.any(Number),
  });

  const unpinned = await invokeSessionsPatch({
    key: "discord:group:dev",
    pinned: false,
  });
  expectChangedBroadcast(unpinned.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    pinned: false,
    pinnedAt: null,
  });

  const unread = await invokeSessionsPatch({
    key: "discord:group:dev",
    unread: true,
  });
  expectChangedBroadcast(unread.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    unread: true,
    lastReadAt: 20,
    lastActivityAt: 5,
  });

  const read = await invokeSessionsPatch({
    key: "discord:group:dev",
    unread: false,
  });
  expectChangedBroadcast(read.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    unread: false,
    lastReadAt: expect.any(Number),
    lastActivityAt: 5,
  });
});

test("sessions.changed mutation events clear label-derived display names", async () => {
  await writeMainSessionStore({ label: "Dev" });

  const result = await invokeSessionsPatch({ key: "main", label: null });

  expectMainPatchBroadcast(result, {
    label: null,
    displayName: null,
  });
});

test("sessions.patch scopes selected global mutations and events to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });

  const { broadcastToConnIds, responsePayload } = await invokeSessionsPatch({
    key: "global",
    agentId: "work",
    label: "Work global",
  });

  expectFields(responsePayload, { ok: true, key: "global" });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "global",
    agentId: "work",
    reason: "patch",
    label: "Work global",
  });
  const mainStore = JSON.parse(await fs.readFile(globalStores.mainStorePath, "utf-8")) as {
    global?: { label?: string };
  };
  const workStore = JSON.parse(await fs.readFile(globalStores.workStorePath, "utf-8")) as {
    global?: { label?: string };
  };
  expect(mainStore.global?.label).toBeUndefined();
  expect(workStore.global?.label).toBe("Work global");
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact scopes selected global truncation to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { broadcastToConnIds, responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig: globalStores.getRuntimeConfig,
    params: {
      key: "global",
      agentId: "work",
      maxLines: 2,
    },
  });

  expectFields(responsePayload, { ok: true, key: "global", compacted: true, kept: 2 });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "global",
    agentId: "work",
    reason: "compact",
    compacted: true,
  });
  await expect(fs.readFile(globalStores.mainTranscript, "utf-8")).resolves.toBe(
    createLinearSessionTranscript("sess-main-global", ["main one", "main two"]),
  );
  await expect(fs.readFile(globalStores.workTranscript, "utf-8")).resolves.toBe(
    expectedLastMessageTranscript("sess-work-global", ["work one", "work two"]),
  );
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact trims default global agent when no agentId is supplied", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { broadcastToConnIds, responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig: globalStores.getRuntimeConfig,
    params: {
      key: "global",
      maxLines: 2,
    },
  });

  expectFields(responsePayload, { ok: true, key: "global", compacted: true, kept: 2 });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "global",
    agentId: "main",
    reason: "compact",
    compacted: true,
  });
  await expect(fs.readFile(globalStores.mainTranscript, "utf-8")).resolves.toBe(
    expectedLastMessageTranscript("sess-main-global", ["main one", "main two"]),
  );
  await expect(fs.readFile(globalStores.workTranscript, "utf-8")).resolves.toBe(
    createLinearSessionTranscript("sess-work-global", ["work one", "work two"]),
  );
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact keeps manual trim no-op response shape", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { broadcastToConnIds, responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig: globalStores.getRuntimeConfig,
    params: {
      key: "global",
      agentId: "work",
      maxLines: 5,
    },
  });

  expectFields(responsePayload, { ok: true, key: "global", compacted: false, kept: 3 });
  expect(broadcastToConnIds).not.toHaveBeenCalled();
  await expect(fs.readFile(globalStores.workTranscript, "utf-8")).resolves.toBe(
    createLinearSessionTranscript("sess-work-global", ["work one", "work two"]),
  );
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact keeps manual trim no-transcript response shape", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore();
  const { broadcastToConnIds, responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig: globalStores.getRuntimeConfig,
    params: {
      key: "global",
      agentId: "work",
      maxLines: 1,
    },
  });

  expectFields(responsePayload, {
    ok: true,
    key: "global",
    compacted: false,
    reason: "no transcript",
  });
  expect(broadcastToConnIds).not.toHaveBeenCalled();
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact passes the selected global agent into embedded compaction", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig: globalStores.getRuntimeConfig,
    params: {
      key: "global",
      agentId: "work",
    },
    subscribedConnIds: new Set(),
  });

  expectFields(responsePayload, { ok: true, key: "global", compacted: true });
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  expect(embeddedRunMock.compactEmbeddedAgentSession.mock.calls[0]?.[0]).toMatchObject({
    sessionId: "sess-work-global",
    sessionKey: "global",
    agentId: "work",
    authProfileId: "github-copilot:work",
  });
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact mounts a dashboard managed worktree as its workspace", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionFile = path.join(dir, "sess-suggested.jsonl");
  await fs.writeFile(
    sessionFile,
    createLinearSessionTranscript("sess-suggested", ["one", "two"]),
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      "dashboard:suggested": sessionStoreEntry("sess-suggested", {
        sessionFile,
        spawnedCwd: "/tmp/suggested-worktree",
      }),
    },
  });
  const { getRuntimeConfig } = await getGatewayConfigModule();

  const { responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig,
    params: { key: "agent:main:dashboard:suggested" },
    subscribedConnIds: new Set(),
  });

  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  expectFields(responsePayload, {
    ok: true,
    key: "agent:main:dashboard:suggested",
    compacted: true,
  });
  expect(embeddedRunMock.compactEmbeddedAgentSession.mock.calls[0]?.[0]).toMatchObject({
    workspaceDir: "/tmp/suggested-worktree",
    cwd: "/tmp/suggested-worktree",
  });
});

test("sessions.changed mutation events include subagent ownership metadata", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "subagent:child": sessionStoreEntry("sess-child", {
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        spawnedCwd: "/tmp/task-repo",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      }),
    },
  });

  const { broadcastToConnIds, responsePayload } = await invokeSessionsPatch({
    key: "subagent:child",
    label: "Child",
  });

  expectFields(responsePayload, { ok: true, key: "agent:main:subagent:child" });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "agent:main:subagent:child",
    reason: "patch",
    spawnedBy: "agent:main:main",
    spawnedWorkspaceDir: "/tmp/subagent-workspace",
    spawnedCwd: "/tmp/task-repo",
    forkedFromParent: true,
    spawnDepth: 2,
    subagentRole: "orchestrator",
    subagentControlScope: "children",
  });
});
