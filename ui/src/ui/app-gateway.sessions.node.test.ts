// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const loadSessionsMock = vi.fn();
const loadChatHistoryMock = vi.fn();
const applySessionsChangedEventMock = vi.fn();
const clearPendingQueueItemsForRunMock = vi.fn();
const flushChatQueueForEventMock = vi.fn();
const handleChatEventMock = vi.fn(() => "idle");
const handleSessionOperationEventMock = vi.fn();

vi.mock("./app-chat.ts", () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 10,
  CHAT_SESSIONS_REFRESH_LIMIT: 25,
  createChatSessionsLoadOverrides: () => ({ activeMinutes: 10, limit: 25 }),
  scopedAgentParamsForSession: (host: { assistantAgentId?: string | null }, sessionKey: string) =>
    sessionKey === "global" && host.assistantAgentId ? { agentId: host.assistantAgentId } : {},
  clearPendingQueueItemsForRun: clearPendingQueueItemsForRunMock,
  flushChatQueueForEvent: flushChatQueueForEventMock,
  refreshChatAvatar: vi.fn(),
}));
vi.mock("./app-settings.ts", () => ({
  applySettings: vi.fn(),
  loadCron: vi.fn(),
  refreshActiveTab: vi.fn(),
  setLastActiveSessionKey: vi.fn(),
}));
vi.mock("./app-tool-stream.ts", () => ({
  handleAgentEvent: vi.fn(),
  handleSessionOperationEvent: handleSessionOperationEventMock,
  resetToolStream: vi.fn(),
}));
vi.mock("./controllers/agents.ts", () => ({
  loadAgents: vi.fn(),
  loadToolsCatalog: vi.fn(),
}));
vi.mock("./controllers/assistant-identity.ts", () => ({
  loadAssistantIdentity: vi.fn(),
}));
vi.mock("./controllers/chat.ts", () => ({
  loadChatHistory: loadChatHistoryMock,
  handleChatEvent: handleChatEventMock,
}));
vi.mock("./controllers/devices.ts", () => ({
  loadDevices: vi.fn(),
}));
vi.mock("./controllers/exec-approval.ts", () => ({
  addExecApproval: vi.fn(),
  clearResolvedExecApprovalPrompt: vi.fn(),
  enqueueExecApprovalPrompt: vi.fn(),
  parseExecApprovalRequested: vi.fn(() => null),
  parseExecApprovalResolved: vi.fn(() => null),
  parsePluginApprovalRequested: vi.fn(() => null),
  pruneExecApprovalQueue: vi.fn((queue) => queue),
  removeExecApproval: vi.fn(),
}));
vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: vi.fn(),
}));
vi.mock("./controllers/sessions.ts", () => ({
  applySessionsChangedEvent: applySessionsChangedEventMock,
  loadSessions: loadSessionsMock,
  subscribeSessions: vi.fn(),
  syncSelectedSessionMessageSubscription: vi.fn(),
}));
vi.mock("./gateway.ts", () => ({
  GatewayBrowserClient: function GatewayBrowserClient() {},
  resolveGatewayErrorDetailCode: () => null,
}));

const { handleGatewayEvent } = await import("./app-gateway.ts");
const { addExecApproval } = await vi.importActual<typeof import("./controllers/exec-approval.ts")>(
  "./controllers/exec-approval.ts",
);

afterAll(() => {
  vi.doUnmock("./app-chat.ts");
  vi.doUnmock("./app-settings.ts");
  vi.doUnmock("./app-tool-stream.ts");
  vi.doUnmock("./controllers/agents.ts");
  vi.doUnmock("./controllers/assistant-identity.ts");
  vi.doUnmock("./controllers/chat.ts");
  vi.doUnmock("./controllers/devices.ts");
  vi.doUnmock("./controllers/exec-approval.ts");
  vi.doUnmock("./controllers/nodes.ts");
  vi.doUnmock("./controllers/sessions.ts");
  vi.doUnmock("./gateway.ts");
  vi.resetModules();
});

function createHost() {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 280,
      navGroupsCollapsed: {},
      borderRadius: 50,
    },
    password: "",
    clientInstanceId: "instance-test",
    client: {},
    connected: true,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    eventLogBuffer: [],
    eventLog: [],
    tab: "overview",
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    healthLoading: false,
    healthResult: null,
    healthError: null,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    debugHealth: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    sessionKey: "main",
    chatRunId: null,
    toolStreamOrder: [],
    refreshSessionsAfterChat: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
  } as unknown as Parameters<typeof handleGatewayEvent>[0];
}

describe("handleGatewayEvent sessions.changed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes the full chat session list after a completed chat run", () => {
    loadSessionsMock.mockReset();
    handleChatEventMock.mockReset().mockReturnValue("final");
    const host = createHost();
    host.sessionKey = "agent:ops:main";
    host.refreshSessionsAfterChat.add("run-1");

    handleGatewayEvent(host, {
      type: "event",
      event: "chat",
      payload: { state: "final", runId: "run-1", sessionKey: "agent:ops:main" },
      seq: 1,
    });

    expect(loadSessionsMock).toHaveBeenCalledWith(host, {
      activeMinutes: 10,
      limit: 25,
    });
  });

  it("scopes selected-global chat session refreshes after a completed run", () => {
    loadSessionsMock.mockReset();
    handleChatEventMock.mockReset().mockReturnValue("final");
    const host = createHost();
    host.sessionKey = "global";
    host.assistantAgentId = "work";
    host.refreshSessionsAfterChat.add("run-1");

    handleGatewayEvent(host, {
      type: "event",
      event: "chat",
      payload: { state: "final", runId: "run-1", sessionKey: "global", agentId: "work" },
      seq: 1,
    });

    expect(loadSessionsMock).toHaveBeenCalledWith(host, {
      activeMinutes: 10,
      limit: 25,
      agentId: "work",
    });
  });

  it("applies reliable session change snapshots without refetching the list", () => {
    loadSessionsMock.mockReset();
    handleChatEventMock.mockReset().mockReturnValue("idle");
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: true, change: "updated" });
    const host = createHost();
    const payload = {
      sessionKey: "agent:main:main",
      sessionId: "sess-main",
      kind: "direct",
      reason: "patch",
    };

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload,
      seq: 1,
    });

    expect(applySessionsChangedEventMock).toHaveBeenCalledWith(host, payload);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("flushes queued chat work when an applied session patch clears the active run", () => {
    loadSessionsMock.mockReset();
    clearPendingQueueItemsForRunMock.mockReset();
    flushChatQueueForEventMock.mockReset();
    applySessionsChangedEventMock
      .mockReset()
      .mockImplementation(
        (state: { chatRunId: string | null; sessionKey: string; chatRunStatus?: unknown }) => {
          const runId = state.chatRunId;
          const sessionKey = state.sessionKey;
          state.chatRunStatus = null;
          state.chatRunId = null;
          return {
            applied: true,
            change: "updated",
            clearedChatRun: true,
            clearedChatRunStatus: { phase: "done", runId, sessionKey },
          };
        },
      );
    const host = createHost();
    host.chatRunId = "run-1";
    const payload = {
      sessionKey: "agent:main:main",
      runId: "agent-run-1",
      clientRunId: "run-1",
      status: "done",
    };

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload,
      seq: 1,
    });

    expect(clearPendingQueueItemsForRunMock).toHaveBeenCalledWith(host, "run-1");
    expect(flushChatQueueForEventMock).toHaveBeenCalledWith(host);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("replays deferred history before flushing queued work after session completion", async () => {
    loadSessionsMock.mockReset();
    loadChatHistoryMock.mockReset();
    clearPendingQueueItemsForRunMock.mockReset();
    flushChatQueueForEventMock.mockReset();
    applySessionsChangedEventMock
      .mockReset()
      .mockImplementation((state: { chatRunId: string | null; sessionKey: string }) => {
        const runId = state.chatRunId;
        const sessionKey = state.sessionKey;
        state.chatRunId = null;
        return {
          applied: true,
          change: "updated",
          clearedChatRun: true,
          clearedChatRunStatus: { phase: "done", runId, sessionKey },
        };
      });
    let resolveHistory!: () => void;
    loadChatHistoryMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const host = createHost();
    host.sessionKey = "agent:main:main";
    host.chatRunId = "run-1";
    (
      host as typeof host & { pendingSessionMessageReloadSessionKey?: string | null }
    ).pendingSessionMessageReloadSessionKey = "agent:main:main";
    const payload = { sessionKey: "agent:main:main", status: "done" };

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload,
      seq: 1,
    });

    expect(clearPendingQueueItemsForRunMock).toHaveBeenCalledWith(host, "run-1");
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    expect(
      (host as typeof host & { pendingSessionMessageReloadSessionKey?: string | null })
        .pendingSessionMessageReloadSessionKey,
    ).toBeNull();
    expect(flushChatQueueForEventMock).not.toHaveBeenCalled();
    expect((host as typeof host & { chatRunStatus?: unknown }).chatRunStatus).toBeUndefined();

    resolveHistory();
    await Promise.resolve();

    expect((host as typeof host & { chatRunStatus?: unknown }).chatRunStatus).toMatchObject({
      phase: "done",
      runId: "run-1",
      sessionKey: "agent:main:main",
    });
    expect(flushChatQueueForEventMock).toHaveBeenCalledWith(host);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("does not flush a different session queue after deferred history resolves", async () => {
    loadSessionsMock.mockReset();
    loadChatHistoryMock.mockReset();
    clearPendingQueueItemsForRunMock.mockReset();
    flushChatQueueForEventMock.mockReset();
    applySessionsChangedEventMock
      .mockReset()
      .mockImplementation((state: { chatRunId: string | null; sessionKey: string }) => {
        const runId = state.chatRunId;
        const sessionKey = state.sessionKey;
        state.chatRunId = null;
        return {
          applied: true,
          change: "updated",
          clearedChatRun: true,
          clearedChatRunStatus: { phase: "done", runId, sessionKey },
        };
      });
    let resolveHistory!: () => void;
    loadChatHistoryMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const host = createHost();
    host.sessionKey = "agent:main:main";
    host.chatRunId = "run-1";
    (
      host as typeof host & { pendingSessionMessageReloadSessionKey?: string | null }
    ).pendingSessionMessageReloadSessionKey = "agent:main:main";

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", status: "done" },
      seq: 1,
    });

    host.sessionKey = "agent:other:main";
    resolveHistory();
    await Promise.resolve();

    expect(clearPendingQueueItemsForRunMock).toHaveBeenCalledWith(host, "run-1");
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    expect(flushChatQueueForEventMock).not.toHaveBeenCalled();
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("debounces session reloads when a change event cannot be applied locally", () => {
    vi.useFakeTimers();
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", reason: "cleanup" },
      seq: 1,
    });

    expect(loadSessionsMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_999);
    expect(loadSessionsMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(loadSessionsMock).toHaveBeenCalledWith(host);
  });

  it("coalesces unapplied session change reloads into one reconciliation", () => {
    vi.useFakeTimers();
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:a", reason: "cleanup" },
      seq: 1,
    });
    vi.advanceTimersByTime(2_500);
    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:b", reason: "cleanup" },
      seq: 2,
    });

    vi.advanceTimersByTime(4_999);
    expect(loadSessionsMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(loadSessionsMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).toHaveBeenCalledWith(host);
  });

  it("skips a delayed session reload after the user returns to chat", () => {
    vi.useFakeTimers();
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", reason: "cleanup" },
      seq: 1,
    });
    host.tab = "chat";
    vi.advanceTimersByTime(5_000);

    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("skips a delayed session reload after disconnect", () => {
    vi.useFakeTimers();
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", reason: "cleanup" },
      seq: 1,
    });
    host.connected = false;
    host.client = null;
    vi.advanceTimersByTime(5_000);

    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("does not reload sessions for applied message-phase session patches to existing rows", () => {
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: true, change: "updated" });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:main",
        phase: "message",
        updatedAt: 123,
        totalTokens: 456,
      },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("does not reload sessions when a message-phase event inserts a session row", () => {
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock
      .mockReset()
      .mockReturnValue({ applied: true, change: "inserted" });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:new",
        phase: "message",
        updatedAt: 123,
        totalTokens: 456,
      },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("does not reload sessions when a message-phase event cannot patch local state", () => {
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", phase: "message" },
      seq: 1,
    });

    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("does not reload sessions for chat lifecycle events", () => {
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: true, change: "updated" });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", phase: "start", runId: "run-1" },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("does not reload sessions for chat send acknowledgement events", () => {
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: true, change: "updated" });
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", reason: "send" },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });
});

describe("handleGatewayEvent session.message", () => {
  it("reloads chat history for the active session", () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();
    host.sessionKey = "agent:qa:main";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:qa:main" },
      seq: 1,
    });

    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
  });

  it("reloads chat history when the selected main session receives canonical session messages", () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();
    host.sessionKey = "main";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:main:main" },
      seq: 1,
    });

    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
  });

  it("reloads chat history for selected agent main aliases receiving canonical global messages", () => {
    loadChatHistoryMock.mockReset();
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();
    host.sessionKey = "agent:work:main";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "global", agentId: "work" },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("ignores canonical global messages for other agent main aliases", () => {
    loadChatHistoryMock.mockReset();
    loadSessionsMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    const host = createHost();
    host.sessionKey = "agent:work:main";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "global", agentId: "main" },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).not.toHaveBeenCalled();
    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("reloads history before flushing queue when session.message clears the run", async () => {
    loadChatHistoryMock.mockReset();
    clearPendingQueueItemsForRunMock.mockReset();
    flushChatQueueForEventMock.mockReset();
    applySessionsChangedEventMock
      .mockReset()
      .mockImplementation((state: { chatRunId: string | null; sessionKey: string }) => {
        const runId = state.chatRunId;
        const sessionKey = state.sessionKey;
        state.chatRunId = null;
        return {
          applied: true,
          change: "updated",
          clearedChatRun: true,
          clearedChatRunStatus: { phase: "done", runId, sessionKey },
        };
      });
    let resolveHistory!: () => void;
    loadChatHistoryMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHistory = resolve;
      }),
    );
    const host = createHost();
    host.sessionKey = "agent:qa:main";
    host.chatRunId = "run-1";
    (
      host as typeof host & { pendingSessionMessageReloadSessionKey?: string | null }
    ).pendingSessionMessageReloadSessionKey = null;

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:qa:main", status: "done" },
      seq: 1,
    });

    expect(clearPendingQueueItemsForRunMock).toHaveBeenCalledWith(host, "run-1");
    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    expect(flushChatQueueForEventMock).not.toHaveBeenCalled();
    expect((host as typeof host & { chatRunStatus?: unknown }).chatRunStatus).toBeUndefined();

    resolveHistory();
    await Promise.resolve();

    expect((host as typeof host & { chatRunStatus?: unknown }).chatRunStatus).toMatchObject({
      phase: "done",
      runId: "run-1",
      sessionKey: "agent:qa:main",
    });
    expect(flushChatQueueForEventMock).toHaveBeenCalledWith(host);
  });

  it("refreshes sessions instead of reloading history while a chat run is active", async () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    loadSessionsMock.mockReset().mockResolvedValue(undefined);
    const host = createHost();
    host.sessionKey = "agent:qa:main";
    host.chatRunId = "run-123";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:qa:main" },
      seq: 1,
    });

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(loadSessionsMock).toHaveBeenCalledWith(host, {
      activeMinutes: 10,
      limit: 25,
      publishChatRunStatus: false,
    });
    await Promise.resolve();
    expect(loadChatHistoryMock).not.toHaveBeenCalled();
  });

  it("scopes selected-global session.message refreshes while a chat run is active", async () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    loadSessionsMock.mockReset().mockResolvedValue(undefined);
    const host = createHost();
    host.sessionKey = "global";
    host.assistantAgentId = "work";
    host.chatRunId = "run-123";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "global", agentId: "work" },
      seq: 1,
    });

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(loadSessionsMock).toHaveBeenCalledWith(host, {
      activeMinutes: 10,
      limit: 25,
      agentId: "work",
      publishChatRunStatus: false,
    });
  });

  it("ignores selected-global session.message events from other agents", () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    loadSessionsMock.mockReset();
    const host = createHost();
    host.sessionKey = "global";
    host.assistantAgentId = "work";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "global", agentId: "main" },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).not.toHaveBeenCalled();
    expect(loadChatHistoryMock).not.toHaveBeenCalled();
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("uses hello default agent for unscoped global session.message events before agents load", () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    loadSessionsMock.mockReset();
    const host = createHost();
    host.sessionKey = "global";
    host.hello = {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: [] },
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "work",
        },
      },
    };

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "global" },
      seq: 1,
    });

    expect(applySessionsChangedEventMock).toHaveBeenCalled();
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("replays deferred history reload after session refresh clears a stale active run", async () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    clearPendingQueueItemsForRunMock.mockReset();
    flushChatQueueForEventMock.mockReset();
    loadSessionsMock.mockReset().mockImplementation(async (state) => {
      state.chatRunId = null;
      state.sessionsResult = {
        ts: 1,
        path: "(multiple)",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:qa:main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: false,
            status: "done",
          },
        ],
      };
    });
    const host = createHost();
    host.sessionKey = "agent:qa:main";
    host.chatRunId = "run-stale";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:qa:main" },
      seq: 1,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(host.chatRunId).toBeNull();
    expect((host as typeof host & { chatRunStatus?: unknown }).chatRunStatus).toMatchObject({
      phase: "done",
      runId: "run-stale",
      sessionKey: "agent:qa:main",
    });
    expect(clearPendingQueueItemsForRunMock).toHaveBeenCalledWith(host, "run-stale");
    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    expect(flushChatQueueForEventMock).toHaveBeenCalledWith(host);
  });

  it("waits for an in-flight sessions refresh before replaying deferred history", async () => {
    vi.useFakeTimers();
    try {
      loadChatHistoryMock.mockReset();
      applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
      loadSessionsMock.mockReset().mockResolvedValue(undefined);
      const host = createHost();
      host.sessionKey = "agent:qa:main";
      host.chatRunId = "run-stale";
      host.sessionsLoading = true;

      handleGatewayEvent(host, {
        type: "event",
        event: "session.message",
        payload: { sessionKey: "agent:qa:main" },
        seq: 1,
      });

      await Promise.resolve();
      expect(loadChatHistoryMock).not.toHaveBeenCalled();

      host.chatRunId = null;
      host.sessionsLoading = false;
      await vi.advanceTimersByTimeAsync(250);

      expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
      expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores transcript updates for other sessions", () => {
    loadChatHistoryMock.mockReset();
    applySessionsChangedEventMock.mockReset().mockReturnValue({ applied: false });
    loadSessionsMock.mockReset();
    const host = createHost();
    host.sessionKey = "agent:qa:main";

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload: { sessionKey: "agent:qa:other" },
      seq: 1,
    });

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
  });
});

describe("handleGatewayEvent session.operation", () => {
  it("routes session operation events to the tool stream state", () => {
    handleSessionOperationEventMock.mockReset();
    const host = createHost();
    const payload = {
      operationId: "operation-1",
      operation: "compact",
      phase: "start",
      sessionKey: "agent:main:main",
    };

    handleGatewayEvent(host, {
      type: "event",
      event: "session.operation",
      payload,
      seq: 1,
    });

    expect(handleSessionOperationEventMock).toHaveBeenCalledWith(host, payload);
  });
});

describe("addExecApproval", () => {
  it("keeps the newest approval at the front of the queue", () => {
    const queue = addExecApproval(
      [
        {
          id: "approval-old",
          kind: "exec",
          request: { command: "echo old" },
          createdAtMs: 1,
          expiresAtMs: Date.now() + 120_000,
        },
      ],
      {
        id: "approval-new",
        kind: "exec",
        request: { command: "echo new" },
        createdAtMs: 2,
        expiresAtMs: Date.now() + 120_000,
      },
    );

    expect(queue.map((entry) => entry.id)).toEqual(["approval-new", "approval-old"]);
  });
});
