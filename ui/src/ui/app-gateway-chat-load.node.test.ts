// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectGateway } from "./app-gateway.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";

const refreshActiveTabMock = vi.hoisted(() => vi.fn(async () => undefined));
const refreshChatAvatarMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadControlUiBootstrapConfigMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAssistantIdentityMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadDevicesMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadHealthStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadNodesMock = vi.hoisted(() => vi.fn(async () => undefined));
const subscribeSessionsMock = vi.hoisted(() => vi.fn(async () => undefined));
const verifyPushMock = vi.hoisted(() => vi.fn(async () => undefined));

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitHello: (hello?: GatewayHelloOk) => void;
};

const gatewayClients: GatewayClientMock[] = [];

vi.mock("./gateway.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.ts")>();

  class GatewayBrowserClient {
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly request = vi.fn(async () => ({}));

    constructor(private opts: { onHello?: (hello: GatewayHelloOk) => void }) {
      gatewayClients.push({
        start: this.start,
        stop: this.stop,
        emitHello: (hello) => {
          this.opts.onHello?.(
            hello ?? {
              type: "hello-ok",
              protocol: 3,
              snapshot: {},
              auth: { role: "operator", scopes: [] },
            },
          );
        },
      });
    }
  }

  return {
    ...actual,
    GatewayBrowserClient,
    resolveGatewayErrorDetailCode: () => null,
  };
});

vi.mock("./app-chat.ts", () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 60,
  clearPendingQueueItemsForRun: vi.fn(),
  flushChatQueueForEvent: vi.fn(),
  refreshChatAvatar: refreshChatAvatarMock,
}));

vi.mock("./app-settings.ts", () => ({
  applySettings: vi.fn(),
  loadCron: vi.fn(),
  refreshActiveTab: refreshActiveTabMock,
  setLastActiveSessionKey: vi.fn(),
}));

vi.mock("./controllers/agents.ts", () => ({
  loadAgents: loadAgentsMock,
}));

vi.mock("./controllers/assistant-identity.ts", () => ({
  loadAssistantIdentity: loadAssistantIdentityMock,
}));

vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: loadControlUiBootstrapConfigMock,
}));

vi.mock("./controllers/devices.ts", () => ({
  loadDevices: loadDevicesMock,
}));

vi.mock("./controllers/exec-approval.ts", () => ({
  addExecApproval: vi.fn((queue, entry) => [...queue, entry]),
  parseExecApprovalRequested: vi.fn(() => null),
  parseExecApprovalResolved: vi.fn(() => null),
  parsePluginApprovalRequested: vi.fn(() => null),
  pruneExecApprovalQueue: vi.fn((queue) => queue),
  removeExecApproval: vi.fn((queue) => queue),
}));

vi.mock("./controllers/health.ts", () => ({
  loadHealthState: loadHealthStateMock,
}));

vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: loadNodesMock,
}));

vi.mock("./controllers/sessions.ts", () => ({
  applySessionsChangedEvent: vi.fn(() => ({ applied: false })),
  loadSessions: vi.fn(async () => undefined),
  subscribeSessions: subscribeSessionsMock,
}));

function createHost(tab: Tab) {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
    },
    password: "",
    clientInstanceId: "control-ui-test",
    client: null,
    connected: false,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    eventLogBuffer: [],
    eventLog: [],
    tab,
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    healthLoading: false,
    healthResult: null,
    healthError: null,
    debugHealth: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    pendingUpdateExpectedVersion: null,
    updateStatusBanner: null,
    sessionKey: "main",
    chatRunId: null,
    chatStream: null,
    chatStreamSegments: [],
    chatStreamStartedAt: null,
    chatToolMessages: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    pendingAbort: null,
    refreshSessionsAfterChat: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
    reconcileWebPushState: verifyPushMock,
  } as unknown as Parameters<typeof connectGateway>[0];
}

function connectHost(tab: Tab) {
  const host = createHost(tab);
  connectGateway(host);
  const client = gatewayClients[0];
  expect(client).toBeDefined();
  return { host, client };
}

beforeEach(() => {
  gatewayClients.length = 0;
  refreshActiveTabMock.mockClear();
  refreshChatAvatarMock.mockClear();
  loadControlUiBootstrapConfigMock.mockClear();
  loadAgentsMock.mockClear();
  loadAssistantIdentityMock.mockClear();
  loadDevicesMock.mockClear();
  loadHealthStateMock.mockClear();
  loadNodesMock.mockClear();
  subscribeSessionsMock.mockClear();
  verifyPushMock.mockClear();
});

describe("connectGateway chat load startup work", () => {
  it("lets the active chat refresh own avatar loading on initial chat hello", () => {
    const { host, client } = connectHost("chat");

    client.emitHello();

    expect(refreshActiveTabMock).toHaveBeenCalledWith(host);
    expect(refreshChatAvatarMock).not.toHaveBeenCalled();
  });

  it("still preloads the chat avatar when connecting outside the chat tab", () => {
    const { host, client } = connectHost("overview");

    client.emitHello();

    expect(refreshActiveTabMock).toHaveBeenCalledWith(host);
    expect(refreshChatAvatarMock).toHaveBeenCalledWith(host);
  });
});
