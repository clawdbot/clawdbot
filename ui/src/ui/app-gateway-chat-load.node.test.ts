// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const syncUrlWithSessionKeyMock = vi.hoisted(() => vi.fn());
const verifyPushMock = vi.hoisted(() => vi.fn(async () => undefined));

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitHello: (hello?: GatewayHelloOk) => void;
};

const gatewayClients: GatewayClientMock[] = [];

function createDeferred() {
  let resolve: () => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<undefined>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, reject, resolve };
}

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
              protocol: 4,
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
  CHAT_SESSIONS_REFRESH_LIMIT: 50,
  createChatSessionsLoadOverrides: () => ({ activeMinutes: 60, limit: 50 }),
  scopedAgentListParamsForSession: (_host: unknown, sessionKey: string) => {
    const [, agentId] = sessionKey.split(":");
    return sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
  scopedAgentListParamsForRefreshTarget: (
    _host: unknown,
    target: { sessionKey: string; agentId?: string },
  ) => {
    if (target.agentId) {
      return { agentId: target.agentId };
    }
    const [, agentId] = target.sessionKey.split(":");
    return target.sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
  clearPendingQueueItemsForRun: vi.fn(),
  flushChatQueueForEvent: vi.fn(),
  hasReconnectableQueuedChatSends: vi.fn(() => false),
  markQueuedChatSendsWaitingForReconnect: vi.fn(),
  retryReconnectableQueuedChatSends: vi.fn(async () => undefined),
  refreshChatAvatar: refreshChatAvatarMock,
}));

vi.mock("./app-settings.ts", () => ({
  applySettings: vi.fn(),
  loadCron: vi.fn(),
  refreshActiveTab: refreshActiveTabMock,
  setLastActiveSessionKey: vi.fn(),
  syncUrlWithSessionKey: syncUrlWithSessionKeyMock,
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
  clearResolvedExecApprovalPrompt: vi.fn(),
  enqueueExecApprovalPrompt: vi.fn(),
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
  syncSelectedSessionMessageSubscription: vi.fn(),
}));

afterAll(() => {
  vi.doUnmock("./gateway.ts");
  vi.doUnmock("./app-chat.ts");
  vi.doUnmock("./app-settings.ts");
  vi.doUnmock("./controllers/agents.ts");
  vi.doUnmock("./controllers/assistant-identity.ts");
  vi.doUnmock("./controllers/control-ui-bootstrap.ts");
  vi.doUnmock("./controllers/devices.ts");
  vi.doUnmock("./controllers/exec-approval.ts");
  vi.doUnmock("./controllers/health.ts");
  vi.doUnmock("./controllers/nodes.ts");
  vi.doUnmock("./controllers/sessions.ts");
  vi.resetModules();
});

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
    refreshSessionsAfterChat: new Map(),
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
  if (!client) {
    throw new Error("Expected gateway client instance");
  }
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
  syncUrlWithSessionKeyMock.mockClear();
  verifyPushMock.mockClear();
});

describe("connectGateway chat load startup work", () => {
  it("starts the active chat refresh before agents.list finishes", async () => {
    const agentsList = createDeferred();
    loadAgentsMock.mockReturnValueOnce(agentsList.promise);
    const { host, client } = connectHost("chat");

    client.emitHello();

    await vi.waitFor(() => expect(refreshActiveTabMock).toHaveBeenCalledWith(host));
    expect(loadAgentsMock).toHaveBeenCalledWith(host);
    expect(refreshActiveTabMock).toHaveBeenCalledTimes(1);

    agentsList.resolve();
    await agentsList.promise;
    await Promise.resolve();
    expect(refreshActiveTabMock).toHaveBeenCalledTimes(1);
  });

  it("starts literal global chat refresh before agents.list when hello names the default agent", async () => {
    const agentsList = createDeferred();
    loadAgentsMock.mockReturnValueOnce(agentsList.promise);
    const { host, client } = connectHost("chat");
    host.sessionKey = "global";

    client.emitHello({
      type: "hello-ok",
      protocol: 4,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "ops",
          mainKey: "main",
          mainSessionKey: "agent:ops:main",
        },
      },
      auth: { role: "operator", scopes: [] },
    });

    await vi.waitFor(() => expect(refreshActiveTabMock).toHaveBeenCalledWith(host));
    expect(loadAgentsMock).toHaveBeenCalledWith(host);
    expect(refreshActiveTabMock).toHaveBeenCalledTimes(1);

    agentsList.resolve();
    await agentsList.promise;
    await Promise.resolve();
    expect(refreshActiveTabMock).toHaveBeenCalledTimes(1);
  });

  it("waits for agents.list when a stale agent session may need fallback", async () => {
    const agentsList = createDeferred();
    const { host, client } = connectHost("chat");
    loadAgentsMock.mockImplementationOnce(async () => {
      await agentsList.promise;
      host.agentsList = {
        defaultId: "new-default",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "new-default" }],
      };
    });
    host.sessionKey = "agent:old-default:main";
    host.agentsList = {
      defaultId: "old-default",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "old-default" }],
    };

    client.emitHello({
      type: "hello-ok",
      protocol: 4,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "new-default",
          mainKey: "main",
          mainSessionKey: "agent:new-default:main",
        },
      },
      auth: { role: "operator", scopes: [] },
    });

    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));
    expect(refreshActiveTabMock).not.toHaveBeenCalled();

    agentsList.resolve();
    await vi.waitFor(() => expect(refreshActiveTabMock).toHaveBeenCalledWith(host));
    expect(host.sessionKey).toBe("agent:new-default:main");
    expect(refreshActiveTabMock).toHaveBeenCalledTimes(1);
  });

  it("waits for agents.list before refreshing selected-global chat", async () => {
    const agentsList = createDeferred();
    const { host, client } = connectHost("chat");
    loadAgentsMock.mockImplementationOnce(async () => {
      await agentsList.promise;
      host.agentsList = {
        defaultId: "new-default",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "new-default" }],
      };
    });
    host.sessionKey = "global";
    host.assistantAgentId = "old-default";
    host.agentsList = {
      defaultId: "old-default",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "old-default" }],
    };

    client.emitHello({
      type: "hello-ok",
      protocol: 4,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "new-default",
          mainKey: "main",
          mainSessionKey: "agent:new-default:main",
        },
      },
      auth: { role: "operator", scopes: [] },
    });

    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));
    expect(refreshActiveTabMock).not.toHaveBeenCalled();

    agentsList.resolve();
    await vi.waitFor(() => expect(refreshActiveTabMock).toHaveBeenCalledWith(host));
    expect(host.sessionKey).toBe("global");
    expect(refreshActiveTabMock).toHaveBeenCalledTimes(1);
  });

  it("lets the active chat refresh own avatar loading on initial chat hello", async () => {
    const { host, client } = connectHost("chat");

    client.emitHello();

    await vi.waitFor(() => expect(refreshActiveTabMock).toHaveBeenCalledWith(host));
    expect(refreshChatAvatarMock).not.toHaveBeenCalled();
  });

  it("still preloads the chat avatar when connecting outside the chat tab", async () => {
    const { host, client } = connectHost("overview");

    client.emitHello();

    await vi.waitFor(() => expect(refreshActiveTabMock).toHaveBeenCalledWith(host));
    expect(refreshChatAvatarMock).toHaveBeenCalledWith(host);
  });

  it("lets the active tab refresh own node and device loading after hello", async () => {
    const { host, client } = connectHost("overview");

    client.emitHello();

    await vi.waitFor(() => expect(refreshActiveTabMock).toHaveBeenCalledWith(host));
    expect(loadNodesMock).not.toHaveBeenCalled();
    expect(loadDevicesMock).not.toHaveBeenCalled();
  });
});
