// Covers embedded backend behavior used by the TUI runtime.
import fs from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionAnswerUnconfirmedError } from "../agents/harness/gateway-question-dispatch.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { isEmbeddedMode, setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  clearEmbeddedPluginApprovalBroker,
  getEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import { defaultRuntime } from "../runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import { notifyListeners } from "../shared/listeners.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { EmbeddedTuiBackend as EmbeddedTuiBackendType } from "./embedded-backend.js";

type EmbeddedAgentResult = {
  payloads: Array<{ text: string }>;
  meta: Record<string, unknown>;
};

let EmbeddedTuiBackend: typeof EmbeddedTuiBackendType;

const agentCommandFromIngressMock = vi.fn();
const queueEmbeddedAgentMessageWithOutcomeAsyncMock = vi.fn();
const resolveActiveEmbeddedRunSessionIdMock = vi.fn();
const runBtwSideQuestionMock = vi.fn();
const formatSessionUsageCostSummaryMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const applySessionPatchProjectionMock = vi.fn();
const projectSessionsPatchEntryMock = vi.fn();
const createSessionGoalMock = vi.fn();
const clearSessionGoalMock = vi.fn();
const getSessionGoalMock = vi.fn();
const updateSessionGoalObjectiveMock = vi.fn();
const updateSessionGoalStatusMock = vi.fn();
const loadAgentRuntimePluginRegistryHandleMock = vi.fn();
const withPluginRuntimeRegistryScopeMock = vi.fn((_registry: unknown, run: () => unknown) => run());
const ensureContextWindowCacheLoadedMock = vi.fn(async () => undefined);
const runSessionStartupMigrationMock = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => undefined,
);
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn<
  (_config: unknown, _options?: unknown) => Promise<void>
>(async () => undefined);
const unregisterConfigWriteListenerMock = vi.fn();
let configWriteListener: ((event: { runtimeConfig: Record<string, unknown> }) => void) | undefined;
const createGatewaySessionMock = vi.fn();
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
const buildAllowedModelSetMock = vi.fn(({ catalog }: { catalog: unknown[] }) => ({
  allowedCatalog: catalog,
}));
const readChatHistoryPageMock = vi.fn(
  async (_params?: unknown): Promise<{ messages: unknown[] }> => ({
    messages: [],
  }),
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

vi.mock("../agents/embedded-agent-runner/runs.js", () => ({
  queueEmbeddedAgentMessageWithOutcomeAsync: (...args: unknown[]) =>
    queueEmbeddedAgentMessageWithOutcomeAsyncMock(...args),
}));

vi.mock("../agents/embedded-agent-runner/active-run-projections.js", () => ({
  resolveActiveEmbeddedRunSessionId: (...args: unknown[]) =>
    resolveActiveEmbeddedRunSessionIdMock(...args),
}));

vi.mock("../agents/btw.js", () => ({
  runBtwSideQuestion: (...args: unknown[]) => runBtwSideQuestionMock(...args),
}));

vi.mock("../auto-reply/reply/commands-session-cost.runtime.js", () => ({
  formatSessionUsageCostSummary: (...args: unknown[]) => formatSessionUsageCostSummaryMock(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
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
  resolveSessionStorePathCore: () => "/tmp/openclaw-sessions.json",
  updateSessionGoalObjective: (...args: unknown[]) => updateSessionGoalObjectiveMock(...args),
  updateSessionGoalStatus: (...args: unknown[]) => updateSessionGoalStatusMock(...args),
  updateSessionStore: (...args: unknown[]) => updateSessionStoreMock(...args),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  applySessionPatchProjection: (...args: unknown[]) => applySessionPatchProjectionMock(...args),
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentDir: (_cfg: unknown, agentId: string) => `/tmp/openclaw-agent-${agentId}/agent`,
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) => `/tmp/openclaw-agent-${agentId}`,
  resolveDefaultAgentId: (cfg?: {
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  }) =>
    cfg?.agents?.list?.find((agent) => agent.default)?.id ?? cfg?.agents?.list?.[0]?.id ?? "main",
  resolveSessionAgentId: (params: { sessionKey?: string; agentId?: string }) =>
    params.agentId ?? /^agent:([^:]+):/.exec(params.sessionKey ?? "")?.[1] ?? "main",
}));

vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: (...args: unknown[]) =>
    loadAgentRuntimePluginRegistryHandleMock(...args),
}));

vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  withPluginRuntimeRegistryScope: (...args: [unknown, () => unknown]) =>
    withPluginRuntimeRegistryScopeMock(...args),
}));

vi.mock("../agents/context.js", () => ({
  ensureContextWindowCacheLoaded: () => ensureContextWindowCacheLoadedMock(),
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  refreshPreparedModelRuntimeSnapshots: (config: unknown, options?: unknown) =>
    refreshPreparedModelRuntimeSnapshotsMock(config, options),
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-selection.js", () => ({
  buildAllowedModelSet: (params: { catalog: unknown[]; agentId?: string }) =>
    buildAllowedModelSetMock(params),
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
  registerConfigWriteListener: (
    listener: (event: { runtimeConfig: Record<string, unknown> }) => void,
  ) => {
    configWriteListener = listener;
    return unregisterConfigWriteListenerMock;
  },
}));

vi.mock("../config/sessions/startup-migration.js", () => ({
  runSessionStartupMigration: (...args: Parameters<typeof runSessionStartupMigrationMock>) =>
    runSessionStartupMigrationMock(...args),
}));

vi.mock("../gateway/chat-display-projection.js", () => ({
  projectChatDisplayMessages: (messages: unknown[]) => messages,
  resolveEffectiveChatHistoryMaxChars: () => 100_000,
}));

vi.mock("../gateway/server-constants.js", () => ({
  getMaxChatHistoryMessagesBytes: () => 100_000,
}));

vi.mock("../gateway/server-methods/chat.js", () => ({
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: 100_000,
  augmentChatHistoryWithCanvasBlocks: (messages: unknown[]) => messages,
  replaceOversizedChatHistoryMessages: ({ messages }: { messages: unknown[] }) => ({ messages }),
}));

vi.mock("../gateway/server-methods/chat-history-pages.js", () => ({
  enrichChatHistoryCompactionMarkers: (messages: unknown[]) => messages,
  readChatHistoryPage: (params: unknown) => readChatHistoryPageMock(params),
}));

vi.mock("../gateway/session-utils.js", () => ({
  buildGatewaySessionInfo: (params: Parameters<typeof buildGatewaySessionInfoMock>[0]) =>
    buildGatewaySessionInfoMock(params),
  getSessionDefaults: () => getSessionDefaultsMock(),
  listAgentsForGateway: () => [],
  listSessionsFromStoreAsync: (...args: unknown[]) => listSessionsFromStoreAsyncMock(...args),
  loadCombinedSessionStoreForGatewayCore: (...args: unknown[]) =>
    loadCombinedSessionStoreForGatewayMock(...args),
  loadSessionEntry: (sessionKey: string, opts?: { agentId?: string }) =>
    loadSessionEntryMock(sessionKey, opts),
  loadGatewaySessionEntryReadOnly: (sessionKey: string, opts?: { agentId?: string }) =>
    loadSessionEntryMock(sessionKey, opts),
  resolveCanonicalGatewaySessionStoreKey: ({ key }: { key: string }) => ({
    primaryKey: key,
    target: { storeKeys: [key] },
  }),
  resolveGatewaySessionStoreTargetWithStore: ({ key }: { key: string }) => ({
    canonicalKey: key,
    storeKeys: [key],
    storePath: "/tmp/openclaw-sessions.json",
  }),
  resolveSessionModelRef: () => ({ provider: "openai", model: "gpt-5.4" }),
}));

vi.mock("../gateway/server-model-catalog.js", () => ({
  loadGatewayModelCatalog: (params?: unknown) => loadGatewayModelCatalogMock(params),
}));

vi.mock("../gateway/session-create-service.js", () => ({
  createGatewaySession: (...args: unknown[]) => createGatewaySessionMock(...args),
}));

vi.mock("../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: () => ({
    ok: true,
    key: "agent:main:main",
    entry: {},
    resolved: { modelProvider: "openai", model: "gpt-5.4" },
  }),
}));

vi.mock("../gateway/session-transcript-readers.js", () => ({
  capArrayByJsonBytes: (items: unknown[]) => ({ items }),
}));

vi.mock("../gateway/sessions-patch.js", () => ({
  projectSessionsPatchEntry: (...args: unknown[]) => projectSessionsPatchEntryMock(...args),
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

function emitRegisteredAgentEvent(evt: unknown) {
  if (registeredListener) {
    notifyListeners([registeredListener], evt);
  }
}

function captureBackendEvents(backend: EmbeddedTuiBackendType) {
  const events: Array<{ event: string; payload: unknown }> = [];
  backend.onEvent = ({ event, payload }) => {
    events.push({ event, payload });
  };
  return events;
}

function sendMainChat(backend: EmbeddedTuiBackendType, message: string, runId: string) {
  return backend.sendChat({ sessionKey: "agent:main:main", message, runId });
}

describe("EmbeddedTuiBackend", () => {
  const originalRuntimeLog = defaultRuntime.log;
  const originalRuntimeError = defaultRuntime.error;

  beforeAll(async () => {
    ({ EmbeddedTuiBackend } = await import("./embedded-backend.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(embeddedEventTimestamp);
    agentCommandFromIngressMock.mockReset();
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockReset();
    resolveActiveEmbeddedRunSessionIdMock.mockReset();
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue(undefined);
    runBtwSideQuestionMock.mockReset();
    formatSessionUsageCostSummaryMock.mockReset();
    formatSessionUsageCostSummaryMock.mockResolvedValue("💸 Usage cost\nSession $1.23");
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
    updateSessionGoalObjectiveMock.mockReset();
    updateSessionGoalStatusMock.mockReset();
    updateSessionGoalStatusMock.mockImplementation(async ({ status }: { status: string }) => ({
      objective: "ship",
      status,
      tokensUsed: 0,
    }));
    loadAgentRuntimePluginRegistryHandleMock.mockReset();
    withPluginRuntimeRegistryScopeMock.mockClear();
    ensureContextWindowCacheLoadedMock.mockReset();
    ensureContextWindowCacheLoadedMock.mockResolvedValue(undefined);
    runSessionStartupMigrationMock.mockReset();
    runSessionStartupMigrationMock.mockResolvedValue(undefined);
    refreshPreparedModelRuntimeSnapshotsMock.mockReset();
    refreshPreparedModelRuntimeSnapshotsMock.mockResolvedValue(undefined);
    unregisterConfigWriteListenerMock.mockReset();
    configWriteListener = undefined;
    createGatewaySessionMock.mockReset();
    createGatewaySessionMock.mockResolvedValue({
      ok: true,
      key: "agent:main:tui-created",
      entry: { sessionId: "created-session" },
      resolved: { modelProvider: "openai", model: "gpt-5.4" },
      resetExisting: false,
    });
    listSessionsFromStoreAsyncMock.mockReset();
    listSessionsFromStoreAsyncMock.mockResolvedValue({ sessions: [] });
    loadCombinedSessionStoreForGatewayMock.mockReset();
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
    });
    applySessionPatchProjectionMock.mockReset();
    applySessionPatchProjectionMock.mockImplementation(
      async (params: {
        project: (context: {
          existingEntry?: unknown;
          isLabelInUse: (label: string) => boolean;
          primaryKey: string;
          store: Readonly<Record<string, unknown>>;
        }) => Promise<unknown>;
        resolveTarget: (snapshot: { store: Readonly<Record<string, unknown>> }) => {
          primaryKey: string;
        };
      }) => {
        const store = {};
        const target = params.resolveTarget({ store });
        return await params.project({ ...target, store, isLabelInUse: () => false });
      },
    );
    projectSessionsPatchEntryMock.mockReset();
    projectSessionsPatchEntryMock.mockResolvedValue({ ok: true, entry: {} });
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({});
    loadGatewayModelCatalogMock.mockReset();
    loadGatewayModelCatalogMock.mockReturnValue([]);
    buildAllowedModelSetMock.mockClear();
    readChatHistoryPageMock.mockReset();
    readChatHistoryPageMock.mockResolvedValue({ messages: [] });
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
    const broker = getEmbeddedPluginApprovalBroker();
    broker?.stop();
    if (broker) {
      clearEmbeddedPluginApprovalBroker(broker);
    }
    vi.useRealTimers();
    setEmbeddedMode(false);
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
  });

  it("creates TUI sessions through the shared gateway lifecycle", async () => {
    const backend = new EmbeddedTuiBackend();

    const result = await backend.createSession({
      key: "tui-created",
      agentId: "main",
      parentSessionKey: "agent:main:main",
    });

    expect(createGatewaySessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        key: "tui-created",
        agentId: "main",
        parentSessionKey: "agent:main:main",
        armSessionDiffBaselineCapture: true,
        emitCommandHooks: true,
        commandSource: "tui:embedded",
        loadGatewayModelCatalog: expect.any(Function),
      }),
    );
    expect(result).toEqual({
      ok: true,
      key: "agent:main:tui-created",
      entry: { sessionId: "created-session" },
      resolved: { modelProvider: "openai", model: "gpt-5.4" },
    });
  });

  it("returns the resolved model from the shared reset lifecycle", async () => {
    const backend = new EmbeddedTuiBackend();

    await expect(backend.resetSession("main", "new")).resolves.toEqual({
      ok: true,
      key: "agent:main:main",
      entry: {},
      resolved: { modelProvider: "openai", model: "gpt-5.4" },
    });
  });

  it("bridges assistant and lifecycle events into chat events", async () => {
    const pending = deferred<EmbeddedAgentResult>();
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

    await sendMainChat(backend, "hello", "run-local-1");

    registeredListener?.({
      runId: "run-local-1",
      stream: "assistant",
      data: { delta: "hello" },
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
          sessionKey: "agent:main:main",
          agentId: "main",
          stream: "assistant",
          data: { delta: "hello" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          agentId: "main",
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
          sessionKey: "agent:main:main",
          agentId: "main",
          stream: "lifecycle",
          data: { phase: "end", stopReason: "stop" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          agentId: "main",
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

  it("isolates TUI event consumer failures in the agent event bus", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    backend.onEvent = () => {
      throw new Error("render failed");
    };
    backend.start();
    await sendMainChat(backend, "hello", "run-listener-error");

    expect(() =>
      emitRegisteredAgentEvent({
        runId: "run-listener-error",
        stream: "assistant",
        data: { text: "hello", delta: "hello" },
      }),
    ).not.toThrow();
    await flushMicrotasks();

    backend.onEvent = undefined;
    pending.resolve({ payloads: [{ text: "hello" }], meta: {} });
    await flushMicrotasks();
    await backend.stop();
  });

  it("bridges local plugin approvals without a Gateway", async () => {
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await flushMicrotasks();

    const approvalBroker = getEmbeddedPluginApprovalBroker();
    if (!approvalBroker) {
      throw new Error("expected embedded plugin approval broker");
    }
    const decision = approvalBroker.request({
      request: {
        title: "Apply workspace skill proposal",
        description: "Apply a pending workspace skill proposal into live workspace skills.",
        toolName: "skill_workshop",
        sessionKey: "agent:main:main",
        allowedDecisions: ["allow-once", "deny"],
      },
      timeoutMs: 5_000,
    });
    const approvals = await backend.listPluginApprovals();
    const approval = Array.isArray(approvals) ? approvals[0] : undefined;

    expect(approval).toMatchObject({
      request: {
        title: "Apply workspace skill proposal",
        toolName: "skill_workshop",
        sessionKey: "agent:main:main",
      },
    });
    expect(events).toContainEqual({
      event: "plugin.approval.requested",
      payload: approval,
    });
    await expect(backend.resolvePluginApproval(approval?.id, "allow-once")).resolves.toEqual({
      ok: true,
    });
    await expect(decision).resolves.toMatchObject({ decision: "allow-once" });

    await backend.stop();
    expect(getEmbeddedPluginApprovalBroker()).toBeNull();
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

  it("passes the selected agent into model filtering", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: {
          main: { modelPolicy: { allow: ["fixture/main-model"] } },
          work: { modelPolicy: { allow: ["fixture/work-model"] } },
        },
      },
      models: {
        mode: "replace",
        providers: {
          fixture: {
            models: [{ id: "main-model" }, { id: "work-model" }],
          },
        },
      },
    });

    const backend = new EmbeddedTuiBackend();

    await backend.listModels({ agentId: "work" });

    expect(buildAllowedModelSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work" }),
    );
  });

  it("preserves an empty restrictive model policy for the selected agent", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: {
          main: { modelPolicy: { allow: ["openai/*"] } },
          work: { modelPolicy: { allow: ["openai/*"] } },
        },
      },
    });
    loadGatewayModelCatalogMock.mockReturnValue([
      { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
    ]);
    buildAllowedModelSetMock.mockReturnValueOnce({ allowedCatalog: [] });

    await expect(new EmbeddedTuiBackend().listModels({ agentId: "work" })).resolves.toEqual([]);
    expect(buildAllowedModelSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work" }),
    );
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
    projectSessionsPatchEntryMock.mockImplementation(
      async ({
        loadGatewayModelCatalog,
      }: {
        loadGatewayModelCatalog?: () => Promise<unknown[]>;
      }) => {
        await loadGatewayModelCatalog?.();
        return { ok: true, entry: {} };
      },
    );

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
    expect(applySessionPatchProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKeys: ["agent:main:main"] }),
    );
    expect(loadGatewayModelCatalogMock).toHaveBeenCalledWith({ readOnly: false });
  });

  it("rejects a missing harness-owned session before a local patch can create it", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-patch";
    projectSessionsPatchEntryMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
      },
    });
    const backend = new EmbeddedTuiBackend();

    await expect(backend.patchSession({ key: sessionKey, label: "squat" })).rejects.toThrow(
      AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
    );

    expect(applySessionPatchProjectionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionKeys: expect.anything() }),
    );
    expect(projectSessionsPatchEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ storeKey: sessionKey, existingEntry: undefined }),
    );
  });

  it("allows local patches to an existing harness-owned session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:existing-patch";
    const existingEntry = {
      sessionId: "existing-harness-session",
      updatedAt: embeddedEventTimestamp,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    applySessionPatchProjectionMock.mockImplementationOnce(
      async (params: {
        project: (context: {
          existingEntry?: typeof existingEntry;
          isLabelInUse: (label: string) => boolean;
          primaryKey: string;
          store: Readonly<Record<string, typeof existingEntry>>;
        }) => Promise<unknown>;
        resolveTarget: (snapshot: { store: Readonly<Record<string, typeof existingEntry>> }) => {
          primaryKey: string;
        };
      }) => {
        const store = { [sessionKey]: existingEntry };
        const target = params.resolveTarget({ store });
        return await params.project({
          ...target,
          store,
          existingEntry,
          isLabelInUse: () => false,
        });
      },
    );
    projectSessionsPatchEntryMock.mockResolvedValueOnce({
      ok: true,
      entry: { ...existingEntry, label: "kept" },
    });
    const backend = new EmbeddedTuiBackend();

    await expect(backend.patchSession({ key: sessionKey, label: "kept" })).resolves.toMatchObject({
      ok: true,
      key: sessionKey,
      entry: { sessionId: "existing-harness-session", label: "kept" },
    });
    expect(projectSessionsPatchEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ storeKey: sessionKey, existingEntry }),
    );
  });

  it("scopes local session lists to the selected agent store", async () => {
    const backend = new EmbeddedTuiBackend();

    await backend.listSessions({ agentId: "work", includeGlobal: true, search: "global" });

    expect(loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(
      {},
      { agentId: "work", projection: "list" },
    );
    expect(listSessionsFromStoreAsyncMock).toHaveBeenCalledWith({
      cfg: {},
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      opts: { agentId: "work", includeGlobal: true, search: "global" },
    });
  });

  it("gates session reads on the startup migration so legacy keys are never observed early", async () => {
    let resolveMigration: () => void = () => {};
    const migrationDone = new Promise<void>((resolve) => {
      resolveMigration = resolve;
    });
    runSessionStartupMigrationMock.mockReturnValueOnce(migrationDone);

    const backend = new EmbeddedTuiBackend();
    backend.start();

    const listed = backend.listSessions({ agentId: "work" });
    await flushMicrotasks();
    expect(listSessionsFromStoreAsyncMock).not.toHaveBeenCalled();

    resolveMigration();
    await listed;
    expect(runSessionStartupMigrationMock).toHaveBeenCalledWith({
      cfg: {},
      env: process.env,
      log: {
        info: expect.any(Function),
        warn: expect.any(Function),
      },
    });
    expect(listSessionsFromStoreAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("rejects embedded session reads when the actual startup migration finds a legacy store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = await state.writeText(
        "custom/sessions.json",
        JSON.stringify({
          "agent:main:legacy": { sessionId: "legacy-session", updatedAt: 1 },
        }),
      );
      const before = await fs.readFile(storePath);
      getRuntimeConfigMock.mockReturnValue({ session: { store: storePath } });
      const actual = await vi.importActual<
        typeof import("../config/sessions/startup-migration.js")
      >("../config/sessions/startup-migration.js");
      runSessionStartupMigrationMock.mockImplementationOnce(async (...args: unknown[]) => {
        await actual.runSessionStartupMigration(
          args[0] as Parameters<typeof actual.runSessionStartupMigration>[0],
        );
      });
      const backend = new EmbeddedTuiBackend();

      backend.start();
      try {
        await expect(backend.listSessions({ agentId: "main" })).rejects.toThrow(
          "Legacy session store requires migration",
        );
      } finally {
        await backend.stop();
      }
      expect(await fs.readFile(storePath)).toEqual(before);
    });
  });

  it("publishes a static configured runtime before admitting the first local turn", async () => {
    const initialConfig = { agents: { list: [{ id: "main" }] } };
    getRuntimeConfigMock.mockReturnValue(initialConfig);
    const publication = deferred<void>();
    refreshPreparedModelRuntimeSnapshotsMock.mockReturnValueOnce(publication.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();

    const send = backend.sendChat({
      sessionKey: "agent:main:main",
      message: "hello",
      runId: "run-waits-for-static-runtime",
    });
    await flushMicrotasks();

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(initialConfig, {
      catalogMode: "static",
    });
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();

    publication.resolve();
    await send;
    await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1));
    await backend.stop();
  });

  it("queues config runtime publication ahead of later local turns and unregisters on stop", async () => {
    const initialConfig = { agents: { list: [{ id: "main" }] } };
    const nextConfig = { agents: { list: [{ id: "main" }], defaults: { model: "openai/next" } } };
    getRuntimeConfigMock.mockReturnValue(initialConfig);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await vi.waitFor(() => expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledOnce());

    const replacement = deferred<void>();
    refreshPreparedModelRuntimeSnapshotsMock.mockReturnValueOnce(replacement.promise);
    configWriteListener?.({ runtimeConfig: nextConfig });

    const send = backend.sendChat({
      sessionKey: "agent:main:main",
      message: "after config write",
      runId: "run-waits-for-config-runtime",
    });
    await flushMicrotasks();

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenLastCalledWith(nextConfig, {
      catalogMode: "static",
    });
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();

    replacement.resolve();
    await send;
    await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1));
    await backend.stop();

    expect(unregisterConfigWriteListenerMock).toHaveBeenCalledOnce();
  });

  it("forwards overlapping config publications immediately for runtime latest-wins coalescing", async () => {
    const initialConfig = { agents: { list: [{ id: "main" }] } };
    const middleConfig = { agents: { defaults: { model: "openai/middle" } } };
    const latestConfig = { agents: { defaults: { model: "openai/latest" } } };
    getRuntimeConfigMock.mockReturnValue(initialConfig);
    const initial = deferred<void>();
    const middle = deferred<void>();
    const latest = deferred<void>();
    refreshPreparedModelRuntimeSnapshotsMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(middle.promise)
      .mockReturnValueOnce(latest.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await vi.waitFor(() => expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledOnce());

    try {
      configWriteListener?.({ runtimeConfig: middleConfig });
      configWriteListener?.({ runtimeConfig: latestConfig });
      await flushMicrotasks();

      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenNthCalledWith(2, middleConfig, {
        catalogMode: "static",
      });
      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenNthCalledWith(3, latestConfig, {
        catalogMode: "static",
      });
    } finally {
      initial.resolve();
      middle.resolve();
      latest.resolve();
      await backend.stop();
    }
  });

  it("rechecks runtime publication when a queued turn reaches model admission", async () => {
    const first = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ payloads: [{ text: "second done" }], meta: {} });
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: { messages: { queue: { mode: "followup" } } },
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: { queueDebounceMs: 0 },
    }));

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "first",
      runId: "runtime-refresh-first",
    });
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "queued second",
      runId: "runtime-refresh-second",
    });

    const replacement = deferred<void>();
    refreshPreparedModelRuntimeSnapshotsMock.mockReturnValueOnce(replacement.promise);
    configWriteListener?.({
      runtimeConfig: { agents: { defaults: { model: "openai/next" } } },
    });
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await flushMicrotasks();

    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    replacement.resolve();
    await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2));
    await backend.stop();
  });

  it("creates a local session entry before starting a goal", async () => {
    loadSessionEntryMock.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
    });

    const backend = new EmbeddedTuiBackend();

    await expect(
      backend.runGoalCommand({
        sessionKey: "agent:main:main",
        command: "/GOAL start Ship Goal",
      }),
    ).resolves.toEqual({
      text: "Goal started: Ship Goal",
      continuationPrompt: "Ship Goal",
    });
    expect(createSessionGoalMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      objective: "Ship Goal",
      actor: { type: "human" },
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

  it("runs local usage cost with the canonical session entry and selected agent", async () => {
    const cfg = { session: { scope: "global" } };
    const sessionEntry = { sessionId: "session-work", updatedAt: embeddedEventTimestamp };
    loadSessionEntryMock.mockReturnValueOnce({
      cfg,
      canonicalKey: "global",
      storePath: "/tmp/openclaw-work-sessions.json",
      entry: sessionEntry,
    });
    const backend = new EmbeddedTuiBackend();

    await expect(
      backend.runUsageCostCommand({ sessionKey: "global", agentId: "work" }),
    ).resolves.toEqual({
      text: "💸 Usage cost\nSession $1.23",
    });

    expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(formatSessionUsageCostSummaryMock).toHaveBeenCalledWith({
      cfg,
      sessionKey: "global",
      agentId: "work",
      sessionEntry,
      storePath: "/tmp/openclaw-work-sessions.json",
    });
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
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

    const backend = new EmbeddedTuiBackend();

    await expect(
      backend.loadHistory({ sessionKey: "global", agentId: "work" }),
    ).resolves.toMatchObject({
      sessionKey: "global",
      sessionId: "session-work-global",
      messages: [],
    });
    expect(loadSessionEntryMock).toHaveBeenCalledWith("global", {
      agentId: "work",
      includeStoreChildEntries: true,
    });
  });

  it("keeps gateway subagent binding off for embedded /btw side questions", async () => {
    // The embedded TUI runs the side question locally, so it must not borrow the
    // active registry's subagent and node capabilities. Only gateway-hosted
    // callers opt into allowGatewaySubagentBinding.
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "global",
      storePath: "/tmp/openclaw-btw-sessions.json",
      store: {},
      entry: { sessionId: "session-btw-local" },
    });
    runBtwSideQuestionMock.mockResolvedValueOnce({ text: "side done" });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "global",
      message: "/btw local only",
      runId: "run-btw-local",
    });
    await vi.waitFor(() => expect(runBtwSideQuestionMock).toHaveBeenCalledTimes(1));
    await backend.stop();

    expect(runBtwSideQuestionMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "allowGatewaySubagentBinding",
    );
  });

  it("reports the newest matching non-BTW local run in embedded history", async () => {
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-work-sessions.json",
      store: {},
      entry: { sessionId: "session-work-global" },
    }));
    const first = deferred<{ payloads: Array<{ text: string }>; meta: Record<string, unknown> }>();
    const second = deferred<{ payloads: Array<{ text: string }>; meta: Record<string, unknown> }>();
    const side = deferred<{ text: string }>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    runBtwSideQuestionMock.mockReturnValueOnce(side.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "first",
      runId: "run-work-first",
    });
    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "second",
      runId: "run-work-newest",
    });
    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "/btw detached",
      runId: "run-work-btw",
    });

    await expect(
      backend.loadHistory({ sessionKey: "global", agentId: "work" }),
    ).resolves.toMatchObject({
      inFlightRun: { runId: "run-work-newest", text: "" },
    });

    side.resolve({ text: "side done" });
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2));
    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
    await backend.stop();
  });

  it("uses the canonical gateway projector for embedded TUI history reads", async () => {
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      entry: { sessionId: "sess-main" },
    });

    const backend = new EmbeddedTuiBackend();

    await backend.loadHistory({ sessionKey: "agent:main:main" });

    expect(readChatHistoryPageMock).toHaveBeenCalledWith({
      entry: { sessionId: "sess-main" },
      provider: "openai",
      sessionId: "sess-main",
      storePath: "/tmp/openclaw-sessions.json",
      sessionAgentId: "main",
      canonicalKey: "agent:main:main",
      max: 200,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 100_000,
      offset: undefined,
      messageId: undefined,
    });
  });

  it("loads runtime plugins for the send-path workspace before returning embedded history", async () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    loadSessionEntryMock.mockReturnValue({
      cfg,
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      entry: { spawnedWorkspaceDir: "/tmp/openclaw-custom-workspace" },
    });

    const backend = new EmbeddedTuiBackend();

    await expect(backend.loadHistory({ sessionKey: "agent:main:main" })).resolves.toMatchObject({
      runtimePluginsPrewarm: { status: "warmed" },
    });
    expect(loadAgentRuntimePluginRegistryHandleMock).toHaveBeenCalledWith({
      config: cfg,
      workspaceDir: "/tmp/openclaw-agent-main",
    });
  });

  it("returns embedded history when runtime plugin loading fails", async () => {
    loadAgentRuntimePluginRegistryHandleMock.mockImplementationOnce(() => {
      throw new Error("runtime unavailable");
    });
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      entry: {},
    });

    const backend = new EmbeddedTuiBackend();

    await expect(backend.loadHistory({ sessionKey: "agent:main:main" })).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      messages: [],
      runtimePluginsPrewarm: { status: "failed", error: "runtime unavailable" },
    });
  });

  it("clears a prior runtime registry after plugins are disabled", async () => {
    const registry = {};
    loadAgentRuntimePluginRegistryHandleMock
      .mockReturnValueOnce(registry)
      .mockReturnValueOnce(undefined);
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "agent:main:main",
      entry: {},
    });
    const backend = new EmbeddedTuiBackend();

    await backend.loadHistory({ sessionKey: "agent:main:main" });
    await backend.loadHistory({ sessionKey: "agent:main:main" });
    withPluginRuntimeRegistryScopeMock.mockClear();
    await backend.listModels();

    expect(withPluginRuntimeRegistryScopeMock).toHaveBeenCalledWith(
      undefined,
      expect.any(Function),
    );
  });

  it("clears a prior runtime registry after a later preload fails", async () => {
    const registry = {};
    loadAgentRuntimePluginRegistryHandleMock
      .mockReturnValueOnce(registry)
      .mockImplementationOnce(() => {
        throw new Error("runtime unavailable");
      });
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "agent:main:main",
      entry: {},
    });
    const backend = new EmbeddedTuiBackend();

    await backend.loadHistory({ sessionKey: "agent:main:main" });
    await backend.loadHistory({ sessionKey: "agent:main:main" });
    withPluginRuntimeRegistryScopeMock.mockClear();
    await backend.listModels();

    expect(withPluginRuntimeRegistryScopeMock).toHaveBeenCalledWith(
      undefined,
      expect.any(Function),
    );
  });

  it("passes selected-agent global scope into local chat turns", async () => {
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

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

  it("stamps the selected global agent on chat, agent, and BTW envelopes", async () => {
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-work-sessions.json",
      store: {},
      entry: { sessionId: "session-work-global" },
    }));
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);
    runBtwSideQuestionMock.mockResolvedValueOnce({ text: "side done" });
    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (event) => events.push({ event: event.event, payload: event.payload });
    backend.start();

    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "hello",
      runId: "run-global-work",
    });
    registeredListener?.({
      runId: "run-global-work",
      stream: "assistant",
      data: { delta: "hello" },
    });
    pending.resolve({ payloads: [{ text: "hello" }], meta: {} });
    await flushMicrotasks();
    await backend.sendChat({
      sessionKey: "global",
      agentId: "work",
      message: "/btw detached",
      runId: "run-global-work-btw",
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        event: "chat.side_result",
        payload: expect.objectContaining({ text: "side done", agentId: "work" }),
      }),
    );
    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "global", agentId: "work" }),
    );

    expect(
      events.filter((event) => ["chat", "agent", "chat.side_result"].includes(event.event)),
    ).not.toHaveLength(0);
    for (const event of events) {
      if (!["chat", "agent", "chat.side_result"].includes(event.event)) {
        continue;
      }
      expect(event.payload).toMatchObject({ sessionKey: "global", agentId: "work" });
    }
    await backend.stop();
  });

  it("waits for local post-turn maintenance before emitting chat final", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

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
    const pending = deferred<EmbeddedAgentResult>();
    const abortListener = vi.fn();
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", abortListener);
      return pending.promise;
    });

    const backend = new EmbeddedTuiBackend();
    captureBackendEvents(backend);
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
      const pending = deferred<EmbeddedAgentResult>();
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
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
    const firstAbortListener = vi.fn();
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", firstAbortListener);
        return first.promise;
      })
      .mockReturnValueOnce(second.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");

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

    await sendMainChat(backend, "second", "run-local-second");

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
      const first = deferred<EmbeddedAgentResult>();
      const second = deferred<EmbeddedAgentResult>();
      const firstAbortListener = vi.fn();
      agentCommandFromIngressMock
        .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
          opts.abortSignal?.addEventListener("abort", firstAbortListener);
          return first.promise;
        })
        .mockReturnValueOnce(second.promise);

      const backend = new EmbeddedTuiBackend();
      backend.start();
      await sendMainChat(backend, "first", "run-local-first");

      registeredListener?.({
        runId: "run-local-first",
        stream: "assistant",
        data: { text: "first response", delta: "first response" },
      });

      await sendMainChat(backend, "second", "run-local-second");
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

  it("cancels a queued local turn without waiting for the active provider", async () => {
    const active = deferred<{ payloads: Array<{ text: string }>; meta: Record<string, unknown> }>();
    let activeSignal: AbortSignal | undefined;
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      activeSignal = opts.abortSignal;
      return active.promise;
    });
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: { messages: { queue: { mode: "followup" } } },
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: { queueDebounceMs: 0 },
    }));
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await sendMainChat(backend, "the active provider does not settle", "active-provider");
    await sendMainChat(backend, "cancel this queued turn", "queued-provider");

    await backend.abortChat({ sessionKey: "agent:main:main", runId: "queued-provider" });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "queued-provider",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "aborted",
      },
    });
    expect(activeSignal?.aborted).toBe(false);
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    active.resolve({ payloads: [{ text: "active provider completed" }], meta: {} });
    await flushMicrotasks();
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
  });

  it("keeps later queued turns behind the active provider when intermediate turns are canceled", async () => {
    const active = deferred<{ payloads: Array<{ text: string }>; meta: Record<string, unknown> }>();
    let activeSignal: AbortSignal | undefined;
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        activeSignal = opts.abortSignal;
        return active.promise;
      })
      .mockResolvedValueOnce({ payloads: [{ text: "the later turn completed" }], meta: {} });
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: { messages: { queue: { mode: "followup" } } },
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: { queueDebounceMs: 0 },
    }));
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();

    await sendMainChat(backend, "first", "queue-first");
    await sendMainChat(backend, "second", "queue-second");
    await sendMainChat(backend, "third", "queue-third");
    await sendMainChat(backend, "fourth", "queue-fourth");
    await backend.abortChat({ sessionKey: "agent:main:main", runId: "queue-second" });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "queue-second",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "aborted",
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(activeSignal?.aborted).toBe(false);
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    await backend.abortChat({ sessionKey: "agent:main:main", runId: "queue-third" });
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "queue-third",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "aborted",
      },
    });
    expect(activeSignal?.aborted).toBe(false);
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    active.resolve({ payloads: [{ text: "the active turn completed" }], meta: {} });
    await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2));
    expect(agentCommandFromIngressMock.mock.calls[1]?.[0]).toMatchObject({
      runId: "queue-fourth",
      message: "fourth",
    });
  });

  it("steers same-session sends into the active local run", async () => {
    const first = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(first.promise);
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue("active-session");
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: {},
    }));
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockResolvedValue({
      queued: true,
      sessionId: "active-session",
      target: "embedded_run",
      gatewayHealth: "live",
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");

    const result = await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "steer this turn",
      runId: "run-local-second",
    });

    expect(result).toEqual({ runId: "run-local-first" });
    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).toHaveBeenCalledWith(
      "active-session",
      "steer this turn",
      { steeringMode: "all", debounceMs: 500, isInboundUserMessage: true },
    );
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    first.resolve({ payloads: [{ text: "done" }], meta: {} });
    await flushMicrotasks();
  });

  it("surfaces uncertain question input without queuing it again", async () => {
    const first = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(first.promise);
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue("active-session");
    const error = new QuestionAnswerUnconfirmedError("synthetic-question");
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockRejectedValue(error);
    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    try {
      await expect(
        backend.sendChat({
          sessionKey: "agent:main:main",
          message: "answer",
          runId: "run-local-second",
        }),
      ).rejects.toBe(error);
    } finally {
      first.resolve({ payloads: [{ text: "done" }], meta: {} });
      await flushMicrotasks();
    }
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
  });

  it("queues local sends when active-runtime steering rejects them", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue("active-session");
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: {},
    }));
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockResolvedValue({
      queued: false,
      sessionId: "active-session",
      reason: "runtime_rejected",
      gatewayHealth: "live",
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    await sendMainChat(backend, "queue on rejection", "run-local-second");

    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });
    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
  });

  it("honors a persisted local followup queue override", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: { messages: { queue: { mode: "steer" } } },
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: { queueMode: "followup", queueDebounceMs: 0 },
    }));
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue("active-session");

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    await sendMainChat(backend, "follow up later", "run-local-second");

    expect(resolveActiveEmbeddedRunSessionIdMock).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).not.toHaveBeenCalled();
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });
    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
  });

  it("collects pending local messages into one followup turn", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const collected = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(collected.promise);
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: { messages: { queue: { mode: "collect" } } },
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: {},
    }));

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    const second = await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "collect alpha",
      runId: "run-local-second",
    });
    const third = await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "collect beta",
      runId: "run-local-third",
    });

    expect(second).toEqual({ runId: "run-local-second" });
    expect(third).toEqual({ runId: "run-local-second" });
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });
    const collectedCall = agentCommandFromIngressMock.mock.calls[1];
    if (!collectedCall) {
      throw new Error("expected collected local followup call");
    }
    const collectedPrompt = (collectedCall[0] as { message: string }).message;
    expect(collectedPrompt).toContain("[Queued messages while agent was busy]");
    expect(collectedPrompt).toContain("collect alpha");
    expect(collectedPrompt).toContain("collect beta");
    collected.resolve({ payloads: [{ text: "collected done" }], meta: {} });
    await flushMicrotasks();
  });

  it.each(["old", "new"] as const)(
    "keeps a local overflow summary after future drops switch to %s",
    async (nextDropPolicy) => {
      const active = deferred<EmbeddedAgentResult>();
      const collected = deferred<EmbeddedAgentResult>();
      agentCommandFromIngressMock
        .mockReturnValueOnce(active.promise)
        .mockReturnValueOnce(collected.promise);
      let dropPolicy: "summarize" | "old" | "new" = "summarize";
      let cap = 1;
      loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
        cfg: { messages: { queue: { mode: "collect", cap, drop: dropPolicy } } },
        canonicalKey: sessionKey,
        storePath: "/tmp/openclaw-sessions.json",
        store: {},
        entry: { queueDebounceMs: 0 },
      }));

      const backend = new EmbeddedTuiBackend();
      backend.start();
      try {
        await sendMainChat(backend, "active turn", `run-local-policy-active-${nextDropPolicy}`);
        await sendMainChat(
          backend,
          "first overflowed message",
          `run-local-policy-first-${nextDropPolicy}`,
        );
        await sendMainChat(
          backend,
          "second queued message",
          `run-local-policy-second-${nextDropPolicy}`,
        );

        dropPolicy = nextDropPolicy;
        cap = 2;
        await sendMainChat(
          backend,
          "third queued message",
          `run-local-policy-third-${nextDropPolicy}`,
        );

        active.resolve({ payloads: [{ text: "active done" }], meta: {} });
        await vi.waitFor(() => {
          expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
        });
        const queuedCall = agentCommandFromIngressMock.mock.calls[1];
        if (!queuedCall) {
          throw new Error("expected queued local followup call");
        }
        const queuedPrompt = (queuedCall[0] as { message: string }).message;
        expect(queuedPrompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
        expect(queuedPrompt).toContain("first overflowed message");
        expect(queuedPrompt).toContain("second queued message");
        expect(queuedPrompt).toContain("third queued message");
        expect(queuedPrompt.match(/\[Queue overflow\]/g) ?? []).toHaveLength(1);

        collected.resolve({ payloads: [{ text: "collected done" }], meta: {} });
        await flushMicrotasks();
      } finally {
        await backend.stop();
      }
    },
  );

  it("applies the local queue cap and drop-new policy", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: {
        messages: { queue: { mode: "followup", cap: 1, drop: "new" } },
      },
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: {},
    }));

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    await sendMainChat(backend, "kept followup", "run-local-second");
    const dropped = await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "dropped followup",
      runId: "run-local-third",
    });

    expect(dropped).toEqual({ runId: "run-local-second" });
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });
    expect(agentCommandFromIngressMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ message: "kept followup" }),
    );
    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
  });

  it("interrupts the active local run before starting its replacement", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const firstAbortListener = vi.fn(() => {
      first.resolve({ payloads: [{ text: "first aborted" }], meta: {} });
    });
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", firstAbortListener);
        return first.promise;
      })
      .mockResolvedValueOnce({ payloads: [{ text: "replacement done" }], meta: {} });
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: { messages: { queue: { mode: "interrupt" } } },
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: {},
    }));

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    await sendMainChat(backend, "replace it", "run-local-second");

    expect(firstAbortListener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does not inject local queue directives into an active run", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const firstAbortListener = vi.fn();
    agentCommandFromIngressMock
      .mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        opts.abortSignal?.addEventListener("abort", firstAbortListener);
        return first.promise;
      })
      .mockResolvedValueOnce({ payloads: [{ text: "queue updated" }], meta: {} });
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: { queueMode: "interrupt" },
    }));
    resolveActiveEmbeddedRunSessionIdMock.mockReturnValue("active-session");

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/queue followup",
      runId: "run-local-queue",
    });

    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).not.toHaveBeenCalled();
    expect(firstAbortListener).not.toHaveBeenCalled();
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await flushMicrotasks();
  });

  it("does not queue stop commands behind active local runs", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const firstAbortListener = vi.fn(() => {
      first.resolve({ payloads: [{ text: "first aborted" }], meta: {} });
    });
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", firstAbortListener);
      return first.promise;
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");

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
    const first = deferred<EmbeddedAgentResult>();
    const firstAbortListener = vi.fn(() => {
      first.resolve({ payloads: [{ text: "first aborted" }], meta: {} });
    });
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      opts.abortSignal?.addEventListener("abort", firstAbortListener);
      return first.promise;
    });

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
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
        agentId: "main",
        state: "aborted",
      },
    });
  });

  it("retains the latest tool validation summary for an aborted chat event", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockImplementationOnce(() => pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "edit the file",
      runId: "run-validation-loop",
    });

    registeredListener?.({
      runId: "run-validation-loop",
      stream: "tool",
      data: {
        phase: "result",
        toolErrorSummary: "edit tool validation failed: edits: must have required properties edits",
      },
    });
    registeredListener?.({
      runId: "run-validation-loop",
      stream: "lifecycle",
      data: {
        phase: "end",
        aborted: true,
      },
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "run-validation-loop",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "aborted",
        errorMessage: "edit tool validation failed: edits: must have required properties edits",
      },
    });
  });

  const structuredLifecycleSecret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
  const structuredLifecycleError = `\u001b[31mThe image is too large. Authorization: Bearer ${structuredLifecycleSecret}\u001b[0m`;

  it.each([
    {
      label: "a provider timeout after mechanical cancellation",
      lifecycle: {
        phase: "end",
        reason: "transport_cleanup",
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      meta: {
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      text: "The provider timed out. Please try again.",
      partialText: "A partial response before the provider timed out.",
    },
    {
      label: "a non-provider timeout with partial assistant output",
      meta: { stopReason: "timeout" },
      text: "The provider timed out. Please try again.",
      partialText: "A partial response before the run timed out.",
    },
    {
      label: "a mechanically aborted blocked turn",
      lifecycle: {
        phase: "end",
        aborted: true,
        stopReason: "aborted",
        livenessState: "blocked",
      },
      meta: { aborted: true, stopReason: "aborted", livenessState: "blocked" },
      text: "Agent run blocked before producing a usable result.",
      partialText: "A partial response before the run became blocked.",
    },
    {
      label: "an abandoned turn without cancellation",
      lifecycle: { phase: "end", livenessState: "abandoned" },
      meta: { livenessState: "abandoned" },
      text: "Agent run ended before producing a complete result.",
      partialText: "A partial response before the run was abandoned.",
    },
    {
      label: "a structured agent failure",
      meta: { error: { kind: "image_size", message: "Internal provider diagnostic" } },
      text: "The image is too large. Resize it and try again.",
    },
    {
      label: "a structured lifecycle failure",
      lifecycle: {
        phase: "end",
        aborted: false,
        error: { kind: "image_size", message: structuredLifecycleError },
      },
      meta: {
        aborted: false,
        error: { kind: "image_size", message: structuredLifecycleError },
      },
      text: "The image is too large. Authorization: Bearer ***",
      secret: structuredLifecycleSecret,
    },
    {
      label: "an explicit non-aborted failure after controller cancellation",
      abortBeforeLifecycle: true,
      lifecycle: {
        phase: "end",
        aborted: false,
        error: { kind: "retry_limit", message: "The provider exhausted its retry limit." },
      },
      meta: {
        aborted: false,
        error: { kind: "retry_limit", message: "The provider exhausted its retry limit." },
      },
      text: "The provider exhausted its retry limit.",
    },
  ])(
    "projects $label as an actionable terminal failure",
    async ({ lifecycle, meta, text, partialText, abortBeforeLifecycle, secret }) => {
      const pending = deferred<{
        payloads: Array<{ text: string; mediaUrl: null }>;
        meta: Record<string, unknown>;
      }>();
      agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);
      const backend = new EmbeddedTuiBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "show the actual terminal outcome",
        runId: "canonical-terminal",
      });
      const queuedRunReady = (
        backend as unknown as { runs: Map<string, { queuedRunReady: Promise<void> }> }
      ).runs.get("canonical-terminal")?.queuedRunReady;
      let queueReady = false;
      void queuedRunReady?.then(() => {
        queueReady = true;
      });

      if (abortBeforeLifecycle) {
        await backend.abortChat({ sessionKey: "agent:main:main", runId: "canonical-terminal" });
      }
      if (lifecycle) {
        registeredListener?.({ runId: "canonical-terminal", stream: "lifecycle", data: lifecycle });
        await flushMicrotasks();
        expect(queueReady).toBe(true);
        expect(events).toContainEqual({
          event: "chat",
          payload: {
            runId: "canonical-terminal",
            sessionKey: "agent:main:main",
            agentId: "main",
            state: "error",
            errorMessage: text,
          },
        });
      }
      pending.resolve({ payloads: [{ text: partialText ?? text, mediaUrl: null }], meta });
      await flushMicrotasks();

      expect(events).toContainEqual({
        event: "chat",
        payload: {
          runId: "canonical-terminal",
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "error",
          errorMessage: text,
        },
      });
      expect(
        events.filter(
          ({ event, payload }) =>
            event === "chat" && (payload as { state?: string }).state === "error",
        ),
      ).toHaveLength(1);
      if (secret) {
        const terminal = events.find(
          ({ event, payload }) =>
            event === "chat" && (payload as { state?: string }).state === "error",
        )?.payload as { errorMessage: string };
        expect(terminal.errorMessage).not.toContain(secret);
        expect(terminal.errorMessage).not.toContain("\u001b");
      }
    },
  );

  it.each([
    {
      label: "a provider timeout",
      meta: { stopReason: "timeout", timeoutPhase: "provider", providerStarted: true },
      diagnostic: "The provider timed out. Please try again.",
    },
    {
      label: "a queued timeout",
      meta: { stopReason: "timeout", timeoutPhase: "queue", providerStarted: false },
      diagnostic: "The provider timed out. Please try again.",
    },
    {
      label: "a blocked run",
      meta: { livenessState: "blocked" },
      diagnostic: "Agent run blocked before producing a usable result.",
    },
    {
      label: "an abandoned run",
      meta: { livenessState: "abandoned" },
      diagnostic: "Agent run ended before producing a complete result.",
    },
  ])("does not let partial assistant output hide $label", async ({ meta, diagnostic }) => {
    const partialText = "Partial assistant output before the terminal failure.";
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: partialText }],
      meta,
    });
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "preserve the canonical failure diagnostic",
      runId: "partial-terminal",
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "partial-terminal",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "error",
        errorMessage: diagnostic,
      },
    });
  });

  it("surfaces canonical error-only thrown outcomes without exposing the wrapped cause", async () => {
    const { AgentRunTerminalOutcomeError } = await import("../agents/agent-run-terminal-error.js");
    const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
    agentCommandFromIngressMock.mockRejectedValueOnce(
      new AgentRunTerminalOutcomeError(new Error(`hidden provider credential ${secret}`), {
        reason: "failed",
        status: "error",
      }),
    );
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "surface the canonical failure",
      runId: "error-only-terminal",
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "error-only-terminal",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "error",
        errorMessage: "Agent run failed.",
      },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("preserves a wrapped canonical cancellation without redundant abort metadata", async () => {
    const { AgentRunTerminalOutcomeError } = await import("../agents/agent-run-terminal-error.js");
    agentCommandFromIngressMock.mockRejectedValueOnce(
      new AgentRunTerminalOutcomeError(new Error("underlying cancellation"), {
        reason: "cancelled",
        status: "error",
      }),
    );
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "preserve the canonical cancellation",
      runId: "wrapped-cancellation",
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "wrapped-cancellation",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "aborted",
      },
    });
  });

  it.each([
    {
      label: "an unrelated completed reason during an actual abort",
      data: { phase: "end", reason: "completed", aborted: true, stopReason: "aborted" },
      terminal: { state: "aborted" },
    },
    {
      label: "an unrelated cancelled reason during an actual provider error",
      data: {
        phase: "end",
        reason: "cancelled",
        aborted: false,
        error: "real provider failure",
      },
      terminal: { state: "error", errorMessage: "real provider failure" },
    },
  ])("ignores $label in open lifecycle event data", async ({ data, terminal }) => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "trust canonical facts, not an open reason",
      runId: "open-lifecycle-reason",
    });

    registeredListener?.({ runId: "open-lifecycle-reason", stream: "lifecycle", data });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "open-lifecycle-reason",
        sessionKey: "agent:main:main",
        agentId: "main",
        ...terminal,
      },
    });
    pending.resolve({ payloads: [{ text: "the provider finally settled" }], meta: {} });
    await flushMicrotasks();
  });

  it("preserves a yielded parent turn in the embedded session projection", async () => {
    const pending = deferred<{
      payloads: Array<{ text: string; mediaUrl: null }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "wait for the delegated turn",
      runId: "yielded-parent",
    });

    registeredListener?.({
      runId: "yielded-parent",
      stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" },
    });
    pending.resolve({
      payloads: [{ text: "Delegated work is continuing.", mediaUrl: null }],
      meta: { yielded: true, livenessState: "paused", stopReason: "end_turn" },
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: expect.objectContaining({
        runId: "yielded-parent",
        state: "final",
        stopReason: "end_turn",
        yielded: true,
      }),
    });
  });

  it.each([
    { stream: "assistant", data: { text: "Recovered" } },
    { stream: "tool", data: { phase: "start", name: "read" } },
  ] as const)(
    "clears stale validation diagnostics on local $stream progress",
    async (progressEvent) => {
      const pending = deferred<EmbeddedAgentResult>();
      agentCommandFromIngressMock.mockImplementationOnce(() => pending.promise);

      const backend = new EmbeddedTuiBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "recover after invalid arguments",
        runId: "run-recovered-validation",
      });

      registeredListener?.({
        runId: "run-recovered-validation",
        stream: "tool",
        data: {
          phase: "result",
          toolErrorSummary: "edit tool validation failed: invalid arguments",
        },
      });
      registeredListener?.({
        runId: "run-recovered-validation",
        stream: progressEvent.stream,
        data: progressEvent.data,
      });
      registeredListener?.({
        runId: "run-recovered-validation",
        stream: "lifecycle",
        data: { phase: "end", aborted: true },
      });
      await flushMicrotasks();

      expect(events).toContainEqual({
        event: "chat",
        payload: {
          runId: "run-recovered-validation",
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "aborted",
        },
      });
    },
  );

  it("drops unsafe lifecycle tool-error summaries", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockImplementationOnce(() => pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "open the page",
      runId: "run-unsafe-abort",
    });

    registeredListener?.({
      runId: "run-unsafe-abort",
      stream: "lifecycle",
      data: {
        phase: "end",
        aborted: true,
        toolErrorSummary: "browser failed\nsecret output",
      },
    });
    await flushMicrotasks();

    expect(events).toContainEqual({
      event: "chat",
      payload: {
        runId: "run-unsafe-abort",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "aborted",
      },
    });
  });

  it("sends broad stop-like text as a normal prompt when idle", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "do not do that", "run-local-normal-stop-like-text");

    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    pending.resolve({ payloads: [{ text: "normal prompt" }], meta: {} });
    await flushMicrotasks();
  });

  it("sends idle slash stop as a normal prompt so the TUI receives a terminal event", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
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
        agentId: "main",
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
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "first", "run-local-first");

    registeredListener?.({
      runId: "run-local-first",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    await sendMainChat(backend, "second", "run-local-second");
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);

    first.resolve({ payloads: [{ text: "first done" }], meta: {} });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
    });

    second.resolve({ payloads: [{ text: "second done" }], meta: {} });
    await flushMicrotasks();
  });

  it("runs selected-agent global sends independently across agents", async () => {
    const first = deferred<EmbeddedAgentResult>();
    const second = deferred<EmbeddedAgentResult>();
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
    const first = deferred<EmbeddedAgentResult>();
    const stop = deferred<EmbeddedAgentResult>();
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
    getRuntimeConfigMock.mockReturnValue({
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    });
    const defaultRun = deferred<EmbeddedAgentResult>();
    const workRun = deferred<EmbeddedAgentResult>();
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
    ).resolves.toEqual({ ok: true, aborted: false, runIds: [] });
    await expect(
      backend.abortChat({
        sessionKey: "global",
        runId: "run-local-work-global",
      }),
    ).resolves.toEqual({ ok: true, aborted: false, runIds: [] });

    expect(defaultAbortListener).not.toHaveBeenCalled();
    expect(workAbortListener).not.toHaveBeenCalled();

    defaultRun.resolve({ payloads: [{ text: "default done" }], meta: {} });
    workRun.resolve({ payloads: [{ text: "work done" }], meta: {} });
    await flushMicrotasks();
  });

  it("scopes selected global patches to the selected agent", async () => {
    const backend = new EmbeddedTuiBackend();

    await backend.patchSession({
      key: "global",
      agentId: "work",
      fastMode: true,
    });

    expect(projectSessionsPatchEntryMock).toHaveBeenCalledWith(
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
      const first = deferred<EmbeddedAgentResult>();
      agentCommandFromIngressMock.mockReturnValueOnce(first.promise);

      const backend = new EmbeddedTuiBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      await sendMainChat(backend, "first", "run-local-first");

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

      await sendMainChat(backend, "second", "run-local-second");

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

  it("keeps the bounded post-turn timeout visible through canceled queue predecessors", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "5" }, async () => {
      const active = deferred<EmbeddedAgentResult>();
      agentCommandFromIngressMock.mockReturnValueOnce(active.promise);
      loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
        cfg: { messages: { queue: { mode: "followup" } } },
        canonicalKey: sessionKey,
        storePath: "/tmp/openclaw-sessions.json",
        store: {},
        entry: { queueDebounceMs: 0 },
      }));
      const backend = new EmbeddedTuiBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "first",
        runId: "grace-first",
      });
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "second",
        runId: "grace-second",
      });
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "third",
        runId: "grace-third",
      });

      registeredListener?.({
        runId: "grace-first",
        stream: "lifecycle",
        data: { phase: "finishing", stopReason: "stop" },
      });
      await backend.abortChat({ sessionKey: "agent:main:main", runId: "grace-second" });
      await vi.advanceTimersByTimeAsync(10);

      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        event: "chat",
        payload: expect.objectContaining({
          runId: "grace-third",
          state: "error",
          errorMessage: expect.stringContaining("timed out waiting for previous local run"),
        }),
      });
      active.resolve({ payloads: [{ text: "first eventually settled" }], meta: {} });
      await flushMicrotasks();
    });
  });

  it("fails a queued local send immediately when shutdown grace is zero", async () => {
    await withEnvAsync({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "0" }, async () => {
      const first = deferred<EmbeddedAgentResult>();
      agentCommandFromIngressMock.mockReturnValueOnce(first.promise);

      const backend = new EmbeddedTuiBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      await sendMainChat(backend, "first", "run-local-first");

      registeredListener?.({
        runId: "run-local-first",
        stream: "lifecycle",
        data: { phase: "finishing", stopReason: "stop" },
      });

      await sendMainChat(backend, "second", "run-local-second");
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
      }
    };

    backend.start();
    await sendMainChat(backend, "first", "run-local-first");

    await vi.waitFor(() => {
      expect(sentDuringError).toBeDefined();
    });
    await sentDuringError;
    await flushMicrotasks();
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "replaces streamed drafts with the authoritative final answer",
      finalPayloads: [{ text: "Authoritative final answer" }],
      expectedText: "Authoritative final answer",
    },
    {
      name: "keeps an authoritative final answer that extends the streamed draft",
      finalPayloads: [{ text: "Draft answer with its complete authoritative tail" }],
      expectedText: "Draft answer with its complete authoritative tail",
    },
    {
      name: "preserves every authoritative final payload block",
      finalPayloads: [{ text: "First final block" }, { text: "Second final block" }],
      expectedText: "First final block\n\nSecond final block",
    },
    {
      name: "preserves streamed text when the final payload contains no text",
      finalPayloads: [],
      expectedText: "Draft answer",
    },
    {
      name: "preserves an ordinary MEDIA-like suffix in the authoritative final answer",
      finalPayloads: [{ text: "The selected size is\nM" }],
      expectedText: "The selected size is\nM",
    },
  ])("$name", async ({ finalPayloads, expectedText }) => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await sendMainChat(backend, "finish the draft", "run-local-authoritative-final");

    registeredListener?.({
      runId: "run-local-authoritative-final",
      stream: "assistant",
      data: { text: "Draft answer", delta: "Draft answer" },
    });
    registeredListener?.({
      runId: "run-local-authoritative-final",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: finalPayloads, meta: {} });
    await flushMicrotasks();

    const chatPayloads = events
      .filter((event) => event.event === "chat")
      .map((event) => event.payload);

    expect(chatPayloads.at(-1)).toStrictEqual({
      runId: "run-local-authoritative-final",
      sessionKey: "agent:main:main",
      agentId: "main",
      state: "final",
      stopReason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: expectedText }],
        timestamp: embeddedEventTimestamp,
      },
    });
  });

  it("preserves generic relative media URLs in the authoritative final answer", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await sendMainChat(backend, "show the image", "run-local-relative-media");

    registeredListener?.({
      runId: "run-local-relative-media",
      stream: "assistant",
      data: {
        text: "MEDIA:./image.png",
        delta: "MEDIA:./image.png",
        mediaUrls: ["./image.png"],
      },
    });
    registeredListener?.({
      runId: "run-local-relative-media",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: [{ text: "MEDIA:./image.png" }], meta: {} });
    await flushMicrotasks();

    expect(
      events
        .filter((event) => event.event === "chat")
        .map((event) => event.payload)
        .at(-1),
    ).toStrictEqual({
      runId: "run-local-relative-media",
      sessionKey: "agent:main:main",
      agentId: "main",
      state: "final",
      stopReason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "MEDIA:./image.png" }],
        timestamp: embeddedEventTimestamp,
      },
    });
  });

  it("keeps final short replies like No after suppressing lead-fragment deltas", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await sendMainChat(backend, "answer shortly", "run-local-no");

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
      agentId: "main",
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
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await sendMainChat(backend, "replace", "run-local-replace");

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

  it("keeps internal context private when local deltas split its delimiters", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await sendMainChat(backend, "split internal context", "run-local-split-context");

    const deltas = [
      `Visible\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n`,
      "private runtime detail\n",
      `${INTERNAL_RUNTIME_CONTEXT_END}\nAfter`,
    ];
    deltas.forEach((delta) => {
      registeredListener?.({
        runId: "run-local-split-context",
        stream: "assistant",
        data: { delta },
      });
    });
    registeredListener?.({
      runId: "run-local-split-context",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });
    pending.resolve({ payloads: [{ text: "Visible\n\nAfter" }], meta: {} });
    await flushMicrotasks();

    const chatPayloads = events
      .filter((entry) => entry.event === "chat")
      .map((entry) => entry.payload);
    expect(JSON.stringify(chatPayloads)).not.toContain("private runtime detail");
    expect(chatPayloads.at(-1)).toMatchObject({
      state: "final",
      message: { content: [{ text: "Visible\n\nAfter" }] },
    });
  });

  it("keeps a fallback response deliverable after a retryable lifecycle error", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await sendMainChat(backend, "recover after timeout", "run-local-fallback");

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

  it.each([
    { failureCount: 1, streamedText: "recovered answer", finalText: "recovered answer" },
    { failureCount: 2, streamedText: "recovered answer", finalText: "recovered answer" },
    { failureCount: 1, streamedText: "outdated draft", finalText: "authoritative final answer" },
    { failureCount: 1, streamedText: undefined, finalText: "authoritative unstreamed answer" },
  ])(
    "replaces $failureCount expired attempt failures with authoritative result '$finalText'",
    async ({ failureCount, streamedText, finalText }) => {
      const pending = deferred<EmbeddedAgentResult>();
      agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);
      const backend = new EmbeddedTuiBackend();
      const events = captureBackendEvents(backend);
      const runId = `run-local-expired-retry-${failureCount}`;

      backend.start();
      await sendMainChat(backend, "recover after a slow retry", runId);
      for (let attempt = 0; attempt < failureCount; attempt += 1) {
        registeredListener?.({
          runId,
          stream: "lifecycle",
          data: { phase: "error", error: `retryable provider failure ${attempt + 1}` },
        });
        await vi.advanceTimersByTimeAsync(15_000);
      }

      expect(
        events
          .filter((entry) => entry.event === "chat")
          .map((entry) => (entry.payload as { state?: string }).state),
      ).toContain("error");

      if (streamedText) {
        registeredListener?.({
          runId,
          stream: "assistant",
          data: { text: streamedText, delta: streamedText },
        });
      }
      registeredListener?.({
        runId,
        stream: "lifecycle",
        data: { phase: "end", stopReason: "stop" },
      });
      pending.resolve({ payloads: [{ text: finalText }], meta: {} });
      await flushMicrotasks();

      const terminalEvents = events
        .filter((entry) => entry.event === "chat")
        .map((entry) => entry.payload as { state?: string; message?: { content?: unknown } })
        .filter((payload) => payload.state === "error" || payload.state === "final");
      expect(terminalEvents.map((payload) => payload.state)).toEqual(["error", "final"]);
      expect(terminalEvents.at(-1)).toMatchObject({
        message: { content: [{ text: finalText }] },
      });
    },
  );

  it("finalizes exhausted fallback failures without waiting for retry grace", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);
    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);
    const runId = "run-local-exhausted-fallback";

    backend.start();
    await sendMainChat(backend, "fail after all fallbacks", runId);
    registeredListener?.({
      runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "All fallback candidates failed",
        fallbackExhaustedFailure: true,
      },
    });
    expect(events.at(-1)).toMatchObject({
      event: "chat",
      payload: { state: "error", errorMessage: "All fallback candidates failed" },
    });

    pending.reject(new Error("All fallback candidates failed"));
    await flushMicrotasks();
  });

  it("emits side-result events for local /btw runs", async () => {
    loadSessionEntryMock.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "session-main",
          updatedAt: Date.now(),
        },
      },
      entry: {
        sessionId: "session-main",
        updatedAt: Date.now(),
      },
    });
    runBtwSideQuestionMock.mockResolvedValueOnce({ text: "nothing important" });

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/btw what changed?",
      runId: "run-btw-1",
      timeoutMs: 0,
    });
    await flushMicrotasks();

    await vi.waitFor(() => {
      expect(runBtwSideQuestionMock).toHaveBeenCalledTimes(1);
    });
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        question: "what changed?",
        sessionKey: "agent:main:main",
        opts: expect.objectContaining({
          timeoutOverrideSeconds: 0,
        }),
        isNewSession: false,
      }),
    );
    expect(events).toEqual([
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: "run-btw-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          question: "what changed?",
          text: "nothing important",
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-btw-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "final",
        },
      },
    ]);
  });

  it("emits side-result events for local /side alias runs", async () => {
    loadSessionEntryMock.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "session-main",
          updatedAt: Date.now(),
        },
      },
      entry: {
        sessionId: "session-main",
        updatedAt: Date.now(),
      },
    });
    runBtwSideQuestionMock.mockResolvedValueOnce({ text: "alias answer" });

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/side what changed?",
      runId: "run-side-1",
    });
    await flushMicrotasks();

    await vi.waitFor(() => {
      expect(runBtwSideQuestionMock).toHaveBeenCalledTimes(1);
    });
    expect(agentCommandFromIngressMock).not.toHaveBeenCalled();
    expect(runBtwSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "what changed?",
        sessionKey: "agent:main:main",
      }),
    );
    expect(events).toEqual([
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: "run-side-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          question: "what changed?",
          text: "alias answer",
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-side-1",
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "final",
        },
      },
    ]);
  });

  it("registers tool-first local runs before forwarding agent events", async () => {
    const pending = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events = captureBackendEvents(backend);

    backend.start();
    await sendMainChat(backend, "run tool first", "run-tool-first");

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
          agentId: "main",
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
          sessionKey: "agent:main:main",
          agentId: "main",
          stream: "tool",
          data: { phase: "start", toolCallId: "tc-tool-first", name: "exec" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-tool-first",
          sessionKey: "agent:main:main",
          agentId: "main",
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
    await sendMainChat(backend, "long task", "run-abort-1");

    const result = await backend.abortChat({
      sessionKey: "agent:main:main",
      runId: "run-abort-1",
    });
    await flushMicrotasks();

    expect(result).toEqual({ ok: true, aborted: true, runIds: ["run-abort-1"] });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("keeps local BTW runs alive during a session-scoped abort", async () => {
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: "agent:main:main",
      storePath: "/tmp/openclaw-sessions.json",
      store: {},
      entry: { sessionId: "session-main" },
    });
    const mainRun = deferred<{ payloads: Array<{ text: string }>; meta: { aborted?: boolean } }>();
    const btwRun = deferred<{ text: string }>();
    let mainSignal: AbortSignal | undefined;
    let btwSignal: AbortSignal | undefined;
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      mainSignal = opts.abortSignal;
      opts.abortSignal?.addEventListener(
        "abort",
        () => mainRun.resolve({ payloads: [], meta: { aborted: true } }),
        { once: true },
      );
      return mainRun.promise;
    });
    runBtwSideQuestionMock.mockImplementationOnce(
      (params: { opts?: { abortSignal?: AbortSignal } }) => {
        btwSignal = params.opts?.abortSignal;
        return btwRun.promise;
      },
    );

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await sendMainChat(backend, "long task", "run-main-abort");
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/btw what changed?",
      runId: "run-btw-survives",
    });
    await vi.waitFor(() => {
      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
      expect(runBtwSideQuestionMock).toHaveBeenCalledTimes(1);
    });

    const result = await backend.abortChat({ sessionKey: "agent:main:main" });

    expect(result).toEqual({ ok: true, aborted: true, runIds: ["run-main-abort"] });
    expect(mainSignal?.aborted).toBe(true);
    expect(btwSignal?.aborted).toBe(false);

    btwRun.resolve({ text: "still running" });
    await flushMicrotasks();
  });

  it("passes explicit chat timeouts to the agent command as seconds", async () => {
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
