// Covers embedded backend behavior used by the TUI runtime.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isEmbeddedMode, setEmbeddedMode } from "../infra/embedded-mode.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";

const agentCommandFromIngressMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const applySessionsPatchToStoreMock = vi.fn();
const createSessionGoalMock = vi.fn();
const clearSessionGoalMock = vi.fn();
const getSessionGoalMock = vi.fn();
const updateSessionGoalStatusMock = vi.fn();
const listSessionsFromStoreAsyncMock = vi.fn(
  async (_options?: unknown): Promise<{ sessions: unknown[] }> => ({ sessions: [] }),
);
const buildGatewaySessionInfoMock = vi.fn(
  (params: { key: string; entry?: { sessionId?: string; thinkingLevel?: string } }) => ({
    key: params.key,
    kind: "direct",
    updatedAt: null,
    sessionId: params.entry?.sessionId,
    thinkingLevel: params.entry?.thinkingLevel,
  }),
);
const getSessionDefaultsMock = vi.fn(() => ({
  modelProvider: null,
  model: null,
  contextTokens: null,
}));
const loadCombinedSessionStoreForGatewayMock = vi.fn((_options?: unknown) => ({
  storePath: "/tmp/openclaw-sessions.json",
  store: {},
}));
const getRuntimeConfigMock = vi.fn(() => ({}));
const loadGatewayModelCatalogMock = vi.fn(
  (_params?: unknown): Array<{ id: string; name: string; provider: string }> => [],
);
type LoadSessionEntryMockResult = {
  cfg: Record<string, unknown>;
  canonicalKey: string;
  storePath?: string;
  store?: Record<string, unknown>;
  entry?: Record<string, unknown>;
};
const loadSessionEntryMock = vi.fn(
  (sessionKey: string, _opts?: { agentId?: string }): LoadSessionEntryMockResult => ({
    cfg: {},
    canonicalKey: sessionKey,
    storePath: "/tmp/openclaw-sessions.json",
    store: {},
    entry: {},
  }),
);
let registeredListener: ((evt: unknown) => void) | undefined;
const embeddedEventTimestamp = Date.parse("2026-05-09T07:26:00.000Z");

vi.mock("../agents/agent-command.js", () => ({
  agentCommandFromIngress: (...args: unknown[]) => agentCommandFromIngressMock(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: (listener: (evt: unknown) => void) => {
    registeredListener = listener;
    return () => {
      if (registeredListener === listener) {
        registeredListener = undefined;
      }
    };
  },
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../config/sessions.js", () => ({
  clearSessionGoal: (...args: unknown[]) => clearSessionGoalMock(...args),
  createSessionGoal: (...args: unknown[]) => createSessionGoalMock(...args),
  formatSessionGoalStatus: (goal?: { objective?: string }) =>
    goal ? `Goal: ${goal.objective ?? ""}` : "No goal for this session.",
  getSessionGoal: (...args: unknown[]) => getSessionGoalMock(...args),
  resolveAgentMainSessionKey: () => "agent:main:main",
  resolveStorePath: () => "/tmp/openclaw-sessions.json",
  updateSessionGoalStatus: (...args: unknown[]) => updateSessionGoalStatusMock(...args),
  updateSessionStore: (...args: unknown[]) => updateSessionStoreMock(...args),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (cfg?: {
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  }) =>
    cfg?.agents?.list?.find((agent) => agent.default)?.id ?? cfg?.agents?.list?.[0]?.id ?? "main",
  resolveSessionAgentId: () => "main",
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-selection.js", () => ({
  buildAllowedModelSet: ({ catalog }: { catalog: unknown[] }) => ({ allowedCatalog: catalog }),
  buildConfiguredModelCatalog: ({ cfg }: { cfg: { models?: { providers?: unknown } } }) =>
    Object.entries(
      (cfg.models?.providers as Record<string, { models?: Array<{ id: string }> }>) ?? {},
    ).flatMap(([provider, entry]) =>
      (entry.models ?? []).map((model) => ({
        id: `${provider}/${model.id}`,
        name: model.id,
        provider,
      })),
    ),
  resolveThinkingDefault: () => undefined,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
  loadConfig: () => getRuntimeConfigMock(),
}));

vi.mock("../gateway/cli-session-history.js", () => ({
  augmentChatHistoryWithCliSessionImports: ({ localMessages }: { localMessages?: unknown[] }) =>
    localMessages ?? [],
}));

vi.mock("../gateway/chat-display-projection.js", () => ({
  projectChatDisplayMessages: (messages: unknown[]) => messages,
  projectRecentChatDisplayMessages: (messages: unknown[]) => messages,
  resolveEffectiveChatHistoryMaxChars: () => 100_000,
}));

vi.mock("../gateway/server-constants.js", () => ({
  getMaxChatHistoryMessagesBytes: () => 100_000,
}));

vi.mock("../gateway/server-methods/chat.js", () => ({
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: 100_000,
  augmentChatHistoryWithCanvasBlocks: (messages: unknown[]) => messages,
  enforceChatHistoryFinalBudget: ({ messages }: { messages: unknown[] }) => ({ messages }),
  replaceOversizedChatHistoryMessages: ({ messages }: { messages: unknown[] }) => ({ messages }),
}));

vi.mock("../gateway/session-utils.js", () => ({
  buildGatewaySessionInfo: (params: Parameters<typeof buildGatewaySessionInfoMock>[0]) =>
    buildGatewaySessionInfoMock(params),
  getSessionDefaults: () => getSessionDefaultsMock(),
  listAgentsForGateway: () => [],
  listSessionsFromStoreAsync: (...args: unknown[]) => listSessionsFromStoreAsyncMock(...args),
  loadCombinedSessionStoreForGateway: (...args: unknown[]) =>
    loadCombinedSessionStoreForGatewayMock(...args),
  loadSessionEntry: (sessionKey: string, opts?: { agentId?: string }) =>
    loadSessionEntryMock(sessionKey, opts),
  migrateAndPruneGatewaySessionStoreKey: ({ key }: { key: string }) => ({ primaryKey: key }),
  readSessionMessagesAsync: async () => [],
  resolveGatewaySessionStoreTarget: ({ key }: { key: string }) => ({
    canonicalKey: key,
    storePath: "/tmp/openclaw-sessions.json",
  }),
  resolveSessionModelRef: () => ({ provider: "openai", model: "gpt-5.4" }),
}));

vi.mock("../gateway/server-model-catalog.js", () => ({
  loadGatewayModelCatalog: (params?: unknown) => loadGatewayModelCatalogMock(params),
}));

vi.mock("../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: () => ({ ok: true, key: "agent:main:main", entry: {} }),
}));

vi.mock("../gateway/session-utils.fs.js", () => ({
  capArrayByJsonBytes: (items: unknown[]) => ({ items }),
}));

vi.mock("../gateway/sessions-patch.js", () => ({
  applySessionsPatchToStore: (...args: unknown[]) => applySessionsPatchToStoreMock(...args),
}));

vi.mock("../gateway/server-methods/agent-timestamp.js", () => ({
  injectTimestamp: (message: string) => message,
  timestampOptsFromConfig: () => ({}),
}));

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EmbeddedTuiBackend", () => {
  const originalRuntimeLog = defaultRuntime.log;
  const originalRuntimeError = defaultRuntime.error;

  beforeAll(async () => {
    await import("./embedded-backend.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(embeddedEventTimestamp);
    agentCommandFromIngressMock.mockReset();
    updateSessionStoreMock.mockReset();
    updateSessionStoreMock.mockImplementation(
      async (_storePath: string, update: (store: Record<string, unknown>) => unknown) =>
        await update({}),
    );
    createSessionGoalMock.mockReset();
    createSessionGoalMock.mockImplementation(async ({ objective }: { objective: string }) => ({
      objective,
      tokensUsed: 0,
    }));
    clearSessionGoalMock.mockReset();
    clearSessionGoalMock.mockResolvedValue(false);
    getSessionGoalMock.mockReset();
    getSessionGoalMock.mockResolvedValue({ status: "missing" });
    updateSessionGoalStatusMock.mockReset();
    updateSessionGoalStatusMock.mockImplementation(async ({ status }: { status: string }) => ({
      objective: "ship",
      status,
      tokensUsed: 0,
    }));
    listSessionsFromStoreAsyncMock.mockReset();
    listSessionsFromStoreAsyncMock.mockResolvedValue({ sessions: [] });
    loadCombinedSessionStoreForGatewayMock.mockReset();
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
    });
    applySessionsPatchToStoreMock.mockReset();
    applySessionsPatchToStoreMock.mockResolvedValue({ ok: true, entry: {} });
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({});
    loadGatewayModelCatalogMock.mockReset();
    loadGatewayModelCatalogMock.mockReturnValue([]);
    loadSessionEntryMock.mockReset();
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: {},
    }));
    buildGatewaySessionInfoMock.mockClear();
    getSessionDefaultsMock.mockClear();
    registeredListener = undefined;
    setEmbeddedMode(false);
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
  });

  afterEach(() => {
    vi.useRealTimers();
    setEmbeddedMode(false);
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
  });

  it("bridges assistant and lifecycle events into chat events", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    const onConnected = vi.fn();
    backend.onConnected = onConnected;
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await flushMicrotasks();
    expect(onConnected).toHaveBeenCalledTimes(1);

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "hello",
      runId: "run-local-1",
    });

    registeredListener?.({
      runId: "run-local-1",
      stream: "assistant",
      data: { text: "hello", delta: "hello" },
    });
    registeredListener?.({
      runId: "run-local-1",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: [{ text: "hello" }], meta: {} });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "agent",
        payload: {
          runId: "run-local-1",
          stream: "assistant",
          data: { text: "hello", delta: "hello" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          state: "delta",
          deltaText: "hello",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      },
      {
        event: "agent",
        payload: {
          runId: "run-local-1",
          stream: "lifecycle",
          data: { phase: "end", stopReason: "stop" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          state: "final",
          stopReason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      },
    ]);
  });

  it("lists configured replace-mode models without loading the gateway catalog", async () => {
    getRuntimeConfigMock.mockReturnValue({
      models: {
        mode: "replace",
        providers: {
          "tui-pty-mock": {
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
    });

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(backend.listModels()).resolves.toEqual([
      {
        id: "tui-pty-mock/gpt-5.5",
        name: "gpt-5.5",
        provider: "tui-pty-mock",
        contextWindow: undefined,
        reasoning: undefined,
      },
    ]);
    expect(loadGatewayModelCatalogMock).not.toHaveBeenCalled();
  });

  it("preserves empty configured replace-mode model catalogs", async () => {
    getRuntimeConfigMock.mockReturnValue({
      models: {
        mode: "replace",
        providers: {},
      },
    });

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(backend.listModels()).resolves.toEqual([]);
    expect(loadGatewayModelCatalogMock).not.toHaveBeenCalled();
  });

  it("loads the gateway catalog for replace-mode provider wildcard allowlists", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: {
        defaults: {
          models: {
            "tui-pty-mock/*": {},
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          "tui-pty-mock": {
            models: [{ id: "configured" }],
          },
        },
      },
    });
    loadGatewayModelCatalogMock.mockReturnValue([
      {
        id: "discovered",
        name: "discovered",
        provider: "tui-pty-mock",
      },
    ]);

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(backend.listModels()).resolves.toEqual([
      {
        id: "discovered",
        name: "discovered",
        provider: "tui-pty-mock",
        contextWindow: undefined,
        reasoning: undefined,
      },
    ]);
    expect(loadGatewayModelCatalogMock).toHaveBeenCalledWith({ readOnly: false });
  });

  it("patches wildcard replace-mode sessions against the same full catalog as model listing", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: {
        defaults: {
          models: {
            "tui-pty-mock/*": {},
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          "tui-pty-mock": {
            models: [{ id: "configured" }],
          },
        },
      },
    });
    loadGatewayModelCatalogMock.mockReturnValue([
      {
        id: "discovered",
        name: "discovered",
        provider: "tui-pty-mock",
      },
    ]);
    applySessionsPatchToStoreMock.mockImplementation(
      async ({
        loadGatewayModelCatalog,
      }: {
        loadGatewayModelCatalog?: () => Promise<unknown[]>;
      }) => {
        await loadGatewayModelCatalog?.();
        return { ok: true, entry: {} };
      },
    );

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(
      backend.patchSession({
        key: "agent:main:main",
        model: "tui-pty-mock/discovered",
      }),
    ).resolves.toMatchObject({
      ok: true,
      key: "agent:main:main",
    });
    expect(loadGatewayModelCatalogMock).toHaveBeenCalledWith({ readOnly: false });
  });

  it("scopes local session lists to the selected agent store", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await backend.listSessions({ agentId: "work", includeGlobal: true, search: "global" });

    expect(loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith({}, { agentId: "work" });
    expect(listSessionsFromStoreAsyncMock).toHaveBeenCalledWith({
      cfg: {},
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      opts: { agentId: "work", includeGlobal: true, search: "global" },
    });
  });

  it("creates a local session entry before starting a goal", async () => {
    loadSessionEntryMock.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
    });

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(
      backend.runGoalCommand({
        sessionKey: "agent:main:main",
        command: "/GOAL start Ship Goal",
      }),
    ).resolves.toEqual({ text: "Goal started: Ship Goal" });
    expect(createSessionGoalMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      objective: "Ship Goal",
      fallbackEntry: {
        sessionId: expect.any(String),
        updatedAt: expect.any(Number),
      },
    });
  });

  it("uses the selected agent when running local global goal commands", async () => {
    loadSessionEntryMock.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "global",
      storePath: "/tmp/openclaw-work-sessions.json",
      entry: { sessionId: "session-work", updatedAt: embeddedEventTimestamp },
    });

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(
      backend.runGoalCommand({
        sessionKey: "global",
        agentId: "work",
        command: "/goal status",
      }),
    ).resolves.toEqual({ text: "No goal for this session." });

    expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(getSessionGoalMock).toHaveBeenCalledWith({
      sessionKey: "global",
      storePath: "/tmp/openclaw-work-sessions.json",
    });
  });

  it("loads history thinking defaults from configured replace-mode models", async () => {
    loadSessionEntryMock.mockReturnValue({
      cfg: {
        models: {
          mode: "replace",
          providers: {
            "tui-pty-mock": {
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      },
      canonicalKey: "agent:main:main",
      entry: {},
    });

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(backend.loadHistory({ sessionKey: "agent:main:main" })).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      messages: [],
      thinkingLevel: undefined,
    });
    expect(loadGatewayModelCatalogMock).not.toHaveBeenCalled();
  });

  it("loads selected-agent global history from the selected agent store", async () => {
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "global",
      storePath: "/tmp/openclaw-work-sessions.json",
      entry: { sessionId: "session-work-global" },
    });

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await expect(
      backend.loadHistory({ sessionKey: "global", agentId: "work" }),
    ).resolves.toMatchObject({
      sessionKey: "global",
      sessionId: "session-work-global",
      messages: [],
    });
    expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "work" });
  });

  it("passes selected-agent global scope into local chat turns", async () => {
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();
    backend.start();
    try {
      await backend.sendChat({
        sessionKey: "global",
        agentId: "work",
        message: "hello",
        runId: "run-global-work",
      });
      await flushMicrotasks();

      expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "work" });
      expect(agentCommandFromIngressMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "global",
          agentId: "work",
          message: expect.stringContaining("hello"),
        }),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await backend.stop();
    }
  });

  it("waits for local post-turn maintenance before emitting chat final", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "compact after final",
      runId: "run-local-maintenance",
    });

    registeredListener?.({
      runId: "run-local-maintenance",
      stream: "assistant",
      data: { text: "done", delta: "done" },
    });
    registeredListener?.({
      runId: "run-local-maintenance",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });
    await flushMicrotasks();

    expect(
      events.some(
        (entry) =>
          entry.event === "chat" && (entry.payload as { state?: string }).state === "final",
      ),
    ).toBe(false);

    pending.resolve({ payloads: [{ text: "done" }], meta: {} });
    await flushMicrotasks();

    expect(
      events
        .filter((entry) => entry.event === "chat")
        .map((entry) => (entry.payload as { state?: string }).state),
    ).toEqual(["delta", "final"]);
  });

  it("waits for local post-turn maintenance during stop", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const abortListener = vi.fn();
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", abortListener);
      return pending.promise;
    });

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "compact before shutdown",
      runId: "run-local-stop-maintenance",
    });

    registeredListener?.({
      runId: "run-local-stop-maintenance",
      stream: "assistant",
      data: { text: "done", delta: "done" },
    });
    registeredListener?.({
      runId: "run-local-stop-maintenance",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    let stopped = false;
    const stopPromise = backend.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();

    expect(stopped).toBe(false);
    expect(abortListener).not.toHaveBeenCalled();
    expect(isEmbeddedMode()).toBe(true);

    pending.resolve({ payloads: [{ text: "done" }], meta: {} });
    await stopPromise;

    expect(abortListener).not.toHaveBeenCalled();
    expect(registeredListener).toBeUndefined();
    expect(isEmbeddedMode()).toBe(false);
  });

  it("aborts local post-turn maintenance when stop grace elapses", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" }, async () => {
      const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
      const pending = deferred<{
        payloads: Array<{ text: string }>;
        meta: Record<string, unknown>;
      }>();
      const abortListener = vi.fn();
      agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", abortListener);
        return pending.promise;
      });

      const backend = new EmbeddedTuiBackend();
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "compact before shutdown",
        runId: "run-local-stop-timeout",
      });

      registeredListener?.({
        runId: "run-local-stop-timeout",
        stream: "lifecycle",
        data: { phase: "end", stopReason: "stop" },
      });

      let stopped = false;
      const stopPromise = backend.stop().then(() => {
        stopped = true;
      });
      await flushMicrotasks();
      expect(stopped).toBe(false);
      expect(abortListener).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5);
      await stopPromise;

      expect(abortListener).toHaveBeenCalledTimes(1);
      expect(isEmbeddedMode()).toBe(false);
    });
  });

  it("queues same-session sends behind local post-turn maintenance", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const first = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const second = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const firstAbortListener = vi.fn();
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", firstAbortListener);
        return first.promise;
      })
      .mockReturnValueOnce(second.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "first",
      runId: "run-local-first",
    });

    registeredListener?.({
      runId: "run-local-first",
      stream: "assistant",
      data: { text: "first done", delta: "first done" },
    });
    registeredListener?.({
      runId: "run-local-first",
      stream: "lifecycle",
      data: { phase: "finishing", stopReason: "stop" },
    });

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "second",
      runId: "run-local-second",
    });

    expect(firstAbortListener).not.toHaveBeenCalled();
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });

    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
  });

  it("queues same-session sends behind active local runs", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" }, async () => {
      const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
      const first = deferred<{
        payloads: Array<{ text: string }>;
        meta: Record<string, unknown>;
      }>();
      const second = deferred<{
        payloads: Array<{ text: string }>;
        meta: Record<string, unknown>;
      }>();
      const firstAbortListener = vi.fn();
      agentCommandFromIngressMock
        .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
          opts.abortSignal?.addEventListener("abort", firstAbortListener);
          return first.promise;
        })
        .mockReturnValueOnce(second.promise);

      const backend = new EmbeddedTuiBackend();
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "first",
        runId: "run-local-first",
      });

      registeredListener?.({
        runId: "run-local-first",
        stream: "assistant",
        data: { text: "first response", delta: "first response" },
      });

      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "second",
        runId: "run-local-second",
      });
      await vi.advanceTimersByTimeAsync(5);
      await flushMicrotasks();

      expect(firstAbortListener).not.toHaveBeenCalled();
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

      first.resolve({ payloads: [{ text: "first done" }], meta: {} });
      await vi.waitFor(() => {
        expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
      });

      second.resolve({ payloads: [{ text: "second done" }], meta: {} });
      await flushMicrotasks();
    });
  });

  it("does not queue stop commands behind active local runs", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const first = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const firstAbortListener = vi.fn(() => {
      first.resolve({ payloads: [{ text: "first aborted" }], meta: {} });
    });
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", firstAbortListener);
      return first.promise;
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "first",
      runId: "run-local-first",
    });

    registeredListener?.({
      runId: "run-local-first",
      stream: "assistant",
      data: { text: "first response", delta: "first response" },
    });

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/stop",
      runId: "run-local-stop",
    });

    expect(firstAbortListener).toHaveBeenCalledTimes(1);
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
  });

  it("stops terminal local runs while post-turn maintenance is pending", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const first = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const firstAbortListener = vi.fn(() => {
      first.resolve({ payloads: [{ text: "first aborted" }], meta: {} });
    });
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", firstAbortListener);
      return first.promise;
    });

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "first",
      runId: "run-local-first-terminal",
    });

    registeredListener?.({
      runId: "run-local-first-terminal",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/stop",
      runId: "run-local-stop-terminal",
    });

    expect(firstAbortListener).toHaveBeenCalledTimes(1);
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "run-local-first-terminal",
        sessionKey: "agent:main:main",
        state: "aborted",
      },
    });
  });

  it("sends broad stop-like text as a normal prompt when idle", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "do not do that",
      runId: "run-local-normal-stop-like-text",
    });

    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    pending.resolve({ payloads: [{ text: "normal prompt" }], meta: {} });
    await flushMicrotasks();
  });

  it("sends idle slash stop as a normal prompt so the TUI receives a terminal event", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/stop",
      runId: "run-local-idle-stop",
    });

    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    pending.resolve({ payloads: [{ text: "idle stop prompt" }], meta: {} });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "run-local-idle-stop",
        sessionKey: "agent:main:main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "idle stop prompt" }],
          timestamp: embeddedEventTimestamp,
        },
      },
    });
  });

  it("queues same-session sends behind terminal local runs until maintenance settles", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const first = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const second = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "first",
      runId: "run-local-first",
    });

    registeredListener?.({
      runId: "run-local-first",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "second",
      runId: "run-local-second",
    });
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });

    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
  });

  it("runs selected-agent global sends independently across agents", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const first = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const second = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "global",
      agentId: "main",
      message: "first",
      runId: "run-local-main-global",
    });
    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "second",
      runId: "run-local-work-global",
    });

    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);

    first.resolve({ payloads: [{ text: "main done" }], meta: {} });
    second.resolve({ payloads: [{ text: "work done" }], meta: {} });
    await flushMicrotasks();
  });

  it("does not stop another agent's selected global local run", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const first = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const stop = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const firstAbortListener = vi.fn(() => {
      first.resolve({ payloads: [{ text: "main aborted" }], meta: {} });
    });
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", firstAbortListener);
        return first.promise;
      })
      .mockReturnValueOnce(stop.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "global",
      agentId: "main",
      message: "first",
      runId: "run-local-main-global-stop",
    });
    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "/stop",
      runId: "run-local-work-global-stop",
    });

    expect(firstAbortListener).not.toHaveBeenCalled();
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);

    first.resolve({ payloads: [{ text: "main done" }], meta: {} });
    stop.resolve({ payloads: [{ text: "work stop" }], meta: {} });
    await flushMicrotasks();
  });

  it("does not abort selected-global run ids across default-agent boundaries", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    getRuntimeConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    });
    const defaultRun = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const workRun = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    const defaultAbortListener = vi.fn(() => {
      defaultRun.resolve({ payloads: [{ text: "default aborted" }], meta: {} });
    });
    const workAbortListener = vi.fn(() => {
      workRun.resolve({ payloads: [{ text: "work aborted" }], meta: {} });
    });
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", defaultAbortListener);
        return defaultRun.promise;
      })
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", workAbortListener);
        return workRun.promise;
      });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "global",
      message: "default",
      runId: "run-local-default-global",
    });
    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "work",
      runId: "run-local-work-global",
    });

    await expect(
      backend.abortChat({
        sessionKey: "global",
        agentId: "work",
        runId: "run-local-default-global",
      }),
    ).resolves.toEqual({ ok: true, aborted: false });
    await expect(
      backend.abortChat({
        sessionKey: "global",
        runId: "run-local-work-global",
      }),
    ).resolves.toEqual({ ok: true, aborted: false });

    expect(defaultAbortListener).not.toHaveBeenCalled();
    expect(workAbortListener).not.toHaveBeenCalled();

    defaultRun.resolve({ payloads: [{ text: "default done" }], meta: {} });
    workRun.resolve({ payloads: [{ text: "work done" }], meta: {} });
    await flushMicrotasks();
  });

  it("scopes selected global patches to the selected agent", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const backend = new EmbeddedTuiBackend();

    await backend.patchSession({
      key: "global",
      agentId: "work",
      fastMode: true,
    });

    expect(applySessionsPatchToStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeKey: "global",
        agentId: "work",
        patch: expect.objectContaining({
          key: "global",
          agentId: "work",
          fastMode: true,
        }),
      }),
    );
  });

  it("fails a queued local send when the previous finishing run does not settle", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" }, async () => {
      const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
      const first = deferred<{
        payloads: Array<{ text: string }>;
        meta: Record<string, unknown>;
      }>();
      agentCommandFromIngressMock.mockReturnValueOnce(first.promise);

      const backend = new EmbeddedTuiBackend();
      const events: Array<{ event: string; payload: unknown }> = [];
      backend.onEvent = (evt) => {
        events.push({ event: evt.event, payload: evt.payload });
      };
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "first",
        runId: "run-local-first",
      });

      registeredListener?.({
        runId: "run-local-first",
        stream: "assistant",
        data: { text: "first done", delta: "first done" },
      });
      registeredListener?.({
        runId: "run-local-first",
        stream: "lifecycle",
        data: { phase: "finishing", stopReason: "stop" },
      });

      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "second",
        runId: "run-local-second",
      });

      await vi.advanceTimersByTimeAsync(5);
      await flushMicrotasks();

      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
      expect(
        events.some(
          (entry) =>
            entry.event === "chat" &&
            (entry.payload as { runId?: string; state?: string; errorMessage?: string }).runId ===
              "run-local-second" &&
            (entry.payload as { state?: string }).state === "error" &&
            ((entry.payload as { errorMessage?: string }).errorMessage ?? "").includes(
              "timed out waiting for previous local run",
            ),
        ),
      ).toBe(true);
    });
  });

  it("fails a queued local send immediately when shutdown grace is zero", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "0" }, async () => {
      const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
      const first = deferred<{
        payloads: Array<{ text: string }>;
        meta: Record<string, unknown>;
      }>();
      agentCommandFromIngressMock.mockReturnValueOnce(first.promise);

      const backend = new EmbeddedTuiBackend();
      const events: Array<{ event: string; payload: unknown }> = [];
      backend.onEvent = (evt) => {
        events.push({ event: evt.event, payload: evt.payload });
      };
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "first",
        runId: "run-local-first",
      });

      registeredListener?.({
        runId: "run-local-first",
        stream: "lifecycle",
        data: { phase: "finishing", stopReason: "stop" },
      });

      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "second",
        runId: "run-local-second",
      });
      await flushMicrotasks();

      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
      expect(
        events.some(
          (entry) =>
            entry.event === "chat" &&
            (entry.payload as { runId?: string; state?: string; errorMessage?: string }).runId ===
              "run-local-second" &&
            (entry.payload as { state?: string }).state === "error" &&
            ((entry.payload as { errorMessage?: string }).errorMessage ?? "").includes(
              "timed out waiting for previous local run",
            ),
        ),
      ).toBe(true);
    });
  });

  it("clears local finishing state before surfacing a post-turn failure", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    agentCommandFromIngressMock
      .mockImplementationOnce(() => {
        registeredListener?.({
          runId: "run-local-first",
          stream: "lifecycle",
          data: { phase: "finishing", stopReason: "stop" },
        });
        throw new Error("post-turn compaction failed");
      })
      .mockResolvedValueOnce({ payloads: [{ text: "second done" }], meta: {} });

    const backend = new EmbeddedTuiBackend();
    let callsAfterSendDuringError = 0;
    let sentDuringError: Promise<{ runId: string }> | undefined;
    backend.onEvent = (evt) => {
      const payload = evt.payload as { runId?: string; state?: string };
      if (
        evt.event === "chat" &&
        payload.runId === "run-local-first" &&
        payload.state === "error"
      ) {
        sentDuringError = backend.sendChat({
          sessionKey: "agent:main:main",
          message: "second",
          runId: "run-local-second",
        });
        callsAfterSendDuringError = agentCommandFromIngressMock.mock.calls.length;
      }
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "first",
      runId: "run-local-first",
    });

    await vi.waitFor(() => {
      expect(sentDuringError).toBeDefined();
    });
    expect(callsAfterSendDuringError).toBe(2);
    await sentDuringError;
    await flushMicrotasks();
  });

  it("keeps final short replies like No after suppressing lead-fragment deltas", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "answer shortly",
      runId: "run-local-no",
    });

    registeredListener?.({
      runId: "run-local-no",
      stream: "assistant",
      data: { text: "No", delta: "No" },
    });
    registeredListener?.({
      runId: "run-local-no",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: [{ text: "No" }], meta: {} });
    await flushMicrotasks();

    const chatPayloads = events
      .filter((entry) => entry.event === "chat")
      .map(
        (entry) =>
          entry.payload as {
            runId?: string;
            sessionKey?: string;
            state?: string;
            stopReason?: string;
            message?: { content?: Array<{ text?: string }> };
          },
      );
    const nonEmptyDeltas = chatPayloads.filter(
      (payload) => payload.state === "delta" && payload.message?.content?.[0]?.text,
    );
    expect(nonEmptyDeltas).toHaveLength(0);
    expect(chatPayloads.at(-1)).toStrictEqual({
      runId: "run-local-no",
      sessionKey: "agent:main:main",
      state: "final",
      stopReason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "No" }],
        timestamp: embeddedEventTimestamp,
      },
    });
  });

  it("marks local embedded replacement deltas", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "replace",
      runId: "run-local-replace",
    });

    registeredListener?.({
      runId: "run-local-replace",
      stream: "assistant",
      data: { text: "Hello world" },
    });
    registeredListener?.({
      runId: "run-local-replace",
      stream: "assistant",
      data: { text: "Goodbye world" },
    });

    pending.resolve({ payloads: [{ text: "Goodbye world" }], meta: {} });
    await flushMicrotasks();

    const chatPayloads = events
      .filter((entry) => entry.event === "chat")
      .map(
        (entry) =>
          entry.payload as {
            state?: string;
            deltaText?: string;
            replace?: boolean;
          },
      );
    expect(
      chatPayloads
        .filter((payload) => payload.state === "delta")
        .map((payload) => ({
          state: payload.state,
          deltaText: payload.deltaText,
          replace: payload.replace,
        })),
    ).toEqual([
      { state: "delta", deltaText: "Hello world", replace: undefined },
      { state: "delta", deltaText: "Goodbye world", replace: true },
    ]);
  });

  it("keeps a fallback response deliverable after a retryable lifecycle error", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "recover after timeout",
      runId: "run-local-fallback",
    });

    registeredListener?.({
      runId: "run-local-fallback",
      stream: "lifecycle",
      data: { phase: "error", error: "primary model timed out" },
    });
    await flushMicrotasks();
    expect(
      events.some(
        (entry) =>
          entry.event === "chat" && (entry.payload as { state?: string }).state === "error",
      ),
    ).toBe(false);

    registeredListener?.({
      runId: "run-local-fallback",
      stream: "lifecycle",
      data: {
        phase: "fallback_step",
        fallbackStepFinalOutcome: "succeeded",
        fallbackStepFromModel: "anthropic/claude-sonnet-4-6",
        fallbackStepToModel: "anthropic/claude-sonnet-4-5",
      },
    });
    registeredListener?.({
      runId: "run-local-fallback",
      stream: "assistant",
      data: { text: "fallback answer", delta: "fallback answer" },
    });
    registeredListener?.({
      runId: "run-local-fallback",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: [{ text: "fallback answer" }], meta: {} });
    await flushMicrotasks();
    vi.advanceTimersByTime(15_001);

    const chatPayloads = events
      .filter((entry) => entry.event === "chat")
      .map((entry) => entry.payload as { state?: string; message?: { content?: unknown } });
    expect(chatPayloads.some((payload) => payload.state === "error")).toBe(false);
    const finalPayload = chatPayloads.at(-1);
    expect(finalPayload?.state).toBe("final");
    const finalContent = finalPayload?.message?.content as Array<{ type?: string; text?: string }>;
    expect(finalContent).toHaveLength(1);
    expect(finalContent[0]?.type).toBe("text");
    expect(finalContent[0]?.text).toBe("fallback answer");
  });

  it("emits side-result events for local /btw runs", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: "nothing important" }],
      meta: {},
    });

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/btw what changed?",
      runId: "run-btw-1",
    });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: "run-btw-1",
          sessionKey: "agent:main:main",
          question: "what changed?",
          text: "nothing important",
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-btw-1",
          sessionKey: "agent:main:main",
          state: "final",
        },
      },
    ]);
  });

  it("emits side-result events for local /side alias runs", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: "alias answer" }],
      meta: {},
    });

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/side what changed?",
      runId: "run-side-1",
    });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: "run-side-1",
          sessionKey: "agent:main:main",
          question: "what changed?",
          text: "alias answer",
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-side-1",
          sessionKey: "agent:main:main",
          state: "final",
        },
      },
    ]);
  });

  it("registers tool-first local runs before forwarding agent events", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "run tool first",
      runId: "run-tool-first",
    });

    registeredListener?.({
      runId: "run-tool-first",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-tool-first", name: "exec" },
    });
    pending.resolve({ payloads: [{ text: "done" }], meta: {} });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "chat",
        payload: {
          runId: "run-tool-first",
          sessionKey: "agent:main:main",
          state: "delta",
          deltaText: "",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      },
      {
        event: "agent",
        payload: {
          runId: "run-tool-first",
          stream: "tool",
          data: { phase: "start", toolCallId: "tc-tool-first", name: "exec" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-tool-first",
          sessionKey: "agent:main:main",
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      },
    ]);
  });

  it("aborts active local runs", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    let capturedSignal: AbortSignal | undefined;
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise((_, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "long task",
      runId: "run-abort-1",
    });

    const result = await backend.abortChat({
      sessionKey: "agent:main:main",
      runId: "run-abort-1",
    });
    await flushMicrotasks();

    expect(result).toEqual({ ok: true, aborted: true });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("passes explicit chat timeouts to the agent command as seconds", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
      meta: {},
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    try {
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "Wake up, my friend!",
        runId: "run-explicit-timeout",
        timeoutMs: 300_000,
      });
      await flushMicrotasks();

      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
      const ingressOptions = agentCommandFromIngressMock.mock.calls.at(0)?.[0] as
        | { timeout?: unknown }
        | undefined;
      expect(ingressOptions?.timeout).toBe("300");
    } finally {
      await backend.stop();
    }
  });

  it("restores embedded mode and runtime loggers on stop", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");

    const backend = new EmbeddedTuiBackend();
    backend.start();

    expect(isEmbeddedMode()).toBe(true);
    expect(defaultRuntime.log).not.toBe(originalRuntimeLog);
    expect(defaultRuntime.error).not.toBe(originalRuntimeError);

    await backend.stop();

    expect(isEmbeddedMode()).toBe(false);
    expect(defaultRuntime.log).toBe(originalRuntimeLog);
    expect(defaultRuntime.error).toBe(originalRuntimeError);
  });
});
