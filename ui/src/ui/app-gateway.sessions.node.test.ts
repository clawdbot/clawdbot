// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const loadSessionsMock = vi.fn();
const loadChatHistoryMock = vi.fn();
const applySessionsChangedEventMock = vi.fn();
const handleChatEventMock = vi.fn(() => "idle");

vi.mock("./app-chat.ts", () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 10,
  CHAT_SESSIONS_REFRESH_LIMIT: 25,
  clearPendingQueueItemsForRun: vi.fn(),
  flushChatQueueForEvent: vi.fn(),
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
  parseExecApprovalRequested: vi.fn(() => null),
  parseExecApprovalResolved: vi.fn(() => null),
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

  it("scopes post-chat final session refreshes to the run's agent", () => {
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
      agentId: "ops",
      limit: 25,
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

  it("skips history reload while a chat run is active", () => {
    loadChatHistoryMock.mockReset();
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
  });

  it("ignores transcript updates for other sessions", () => {
    loadChatHistoryMock.mockReset();
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
