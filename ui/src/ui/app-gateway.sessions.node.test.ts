import { describe, expect, it, vi } from "vitest";

const loadSessionsMock = vi.fn();
const loadChatHistoryMock = vi.fn();

vi.mock("./app-chat.ts", () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 10,
  flushChatQueueForEvent: vi.fn(),
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
  handleChatEvent: vi.fn(() => "idle"),
}));
vi.mock("./controllers/devices.ts", () => ({
  loadDevices: vi.fn(),
}));
vi.mock("./controllers/exec-approval.ts", () => ({
  addExecApproval: vi.fn(),
  parseExecApprovalRequested: vi.fn(() => null),
  parseExecApprovalResolved: vi.fn(() => null),
  removeExecApproval: vi.fn(),
}));
vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: vi.fn(),
}));
vi.mock("./controllers/sessions.ts", () => ({
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
    client: null,
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
    refreshSessionsAfterChat: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
  } as unknown as Parameters<typeof handleGatewayEvent>[0];
}

describe("handleGatewayEvent sessions.changed", () => {
  it("reloads sessions when the gateway pushes a sessions.changed event", () => {
    loadSessionsMock.mockReset();
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", reason: "patch" },
      seq: 1,
    });

    expect(loadSessionsMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).toHaveBeenCalledWith(host);
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
