import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import type { ChatPageHost } from "./chat-state.ts";

type TestChatPane = HTMLElement & {
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  forkFromMessage: (entryId: string) => Promise<void>;
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
  state: ChatPageHost;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createSessionContext(
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: { features: { methods: [] } },
      },
    },
    agents: { state: { agentsList: null } },
    sessions,
  } as unknown as ApplicationContext;
}

function createTestChatPane(params: { client: GatewayBrowserClient; sessions: SessionCapability }) {
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  Object.defineProperty(pane, "isConnected", {
    configurable: true,
    value: true,
  });
  const requestUpdate = vi.fn();
  const state = {
    agentsList: null,
    assistantAgentId: null,
    chatError: null,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    client: params.client,
    connected: true,
    connectionEpoch: 4,
    hello: null,
    lastError: null,
    requestUpdate,
    sessionKey: "agent:main:current",
    sessions: params.sessions,
    sessionsError: null,
    sessionsLoading: false,
    sidebarContent: null,
    sidebarOpen: false,
    // Minimal scroll host so scheduleChatScroll is a no-op instead of throwing.
    chatScrollGeneration: 0,
    chatScrollCommitCleanup: null,
    handleChatScroll: vi.fn(),
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
  } as unknown as ChatPageHost;
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return { pane, state };
}

describe("chat pane message cuts", () => {
  it("keeps a newer global agent selection when a message fork finishes late", async () => {
    const forked = createDeferred<{ sessionKey: string; editorText?: string }>();
    const sessions = {
      forkAtMessage: vi.fn(() => forked.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    state.sessionKey = "global";
    state.assistantAgentId = "main";

    const pending = pane.forkFromMessage("user-entry");
    state.assistantAgentId = "work";
    forked.resolve({ sessionKey: "agent:main:forked", editorText: "edit me" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(state.sessionKey).toBe("global");
    expect(state.assistantAgentId).toBe("work");
  });
});
