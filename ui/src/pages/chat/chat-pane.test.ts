/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type {
  TaskSuggestion,
  TaskSuggestionEvent,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import type { ChatPageHost } from "./chat-state.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";

type TestChatPane = HTMLElement & {
  active: boolean;
  context: ApplicationContext;
  state: ChatPageHost;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  createSession: () => Promise<boolean>;
  acceptTaskSuggestion: (suggestion: TaskSuggestion) => Promise<void>;
  handleDocumentKeydown: (event: KeyboardEvent) => void;
  handleTaskSuggestionEvent: (event: TaskSuggestionEvent) => void;
  refreshTaskSuggestions: () => Promise<void>;
  taskSuggestions: TaskSuggestion[];
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
};

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo",
  sessionKey: "agent:main:current",
  agentId: "main",
  createdAt: 1,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function dispatchSidebarShortcut(pane: TestChatPane, shiftKey = true) {
  const event = new KeyboardEvent("keydown", {
    cancelable: true,
    key: "b",
    metaKey: true,
    shiftKey,
  });
  pane.handleDocumentKeydown(event);
  return event;
}

function createSessionContext(
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): ApplicationContext {
  return {
    gateway: {
      snapshot: {
        client,
        connected: true,
        hello: { features: { methods: ["taskSuggestions.list"] } },
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
    chatLoading: false,
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
  } as unknown as ChatPageHost;
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return { pane, requestUpdate, state };
}

describe("chat pane keyboard shortcuts", () => {
  it("toggles only the active pane's session workspace", () => {
    const client = {} as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane, state } = createTestChatPane({ client, sessions });
    const canvasContent: SidebarContent = {
      kind: "canvas",
      docId: "canvas-1",
      entryUrl: "/__openclaw__/canvas/canvas-1/index.html",
    };
    pane.active = true;
    state.connected = false;
    state.sidebarContent = canvasContent;
    state.sidebarOpen = true;

    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);

    const expandEvent = dispatchSidebarShortcut(pane);

    expect(expandEvent.defaultPrevented).toBe(true);
    expect(createSessionWorkspaceProps(state).collapsed).toBe(false);
    expect(state.sidebarOpen).toBe(true);
    expect(state.sidebarContent).toBe(canvasContent);

    const collapseEvent = dispatchSidebarShortcut(pane);

    expect(collapseEvent.defaultPrevented).toBe(true);
    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);
    expect(state.sidebarOpen).toBe(true);
    expect(state.sidebarContent).toBe(canvasContent);

    const mainSidebarEvent = dispatchSidebarShortcut(pane, false);
    expect(mainSidebarEvent.defaultPrevented).toBe(false);

    pane.active = false;
    const inactivePaneEvent = dispatchSidebarShortcut(pane);
    expect(inactivePaneEvent.defaultPrevented).toBe(false);
    expect(createSessionWorkspaceProps(state).collapsed).toBe(true);
  });
});

describe("chat pane session creation lifecycle", () => {
  it("drops a created session after a same-client reconnect", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.createSession();
    state.connected = false;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.connected = true;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    created.resolve("agent:main:new");

    await expect(pending).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not publish a stale creation error after the context is replaced", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });
    const replacementSessions = {} as SessionCapability;

    const pending = pane.createSession();
    state.sessionsError = "stale sessions.create failure";
    pane.context = createSessionContext(client, replacementSessions);
    created.resolve(null);

    await expect(pending).resolves.toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("does not publish a stale creation error after the pane detaches", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });

    const pending = pane.createSession();
    state.sessionsError = "stale sessions.create failure";
    Object.defineProperty(pane, "isConnected", {
      configurable: true,
      value: false,
    });
    created.resolve(null);

    await expect(pending).resolves.toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});

describe("chat pane task suggestion lifecycle", () => {
  it("keeps accept ownership when the resolved event arrives before the response", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const client = {
      request: vi.fn((method: string) =>
        method === "taskSuggestions.accept"
          ? accepted.promise
          : Promise.resolve({ suggestions: [] } satisfies TaskSuggestionsListResult),
      ),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.acceptTaskSuggestion(suggestion);
    pane.handleTaskSuggestionEvent({
      action: "resolved",
      taskId: suggestion.id,
      resolution: "accepted",
    });
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });

    await pending;
    expect(navigate).toHaveBeenCalledWith("single", "agent:main:task");
  });

  it("drops an accept response after a same-client reconnect", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const client = {
      request: vi.fn(() => accepted.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.acceptTaskSuggestion(suggestion);
    pane.connectionGeneration += 1;
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:stale" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
  });

  it("drops a list response after a same-client reconnect", async () => {
    const listed = createDeferred<TaskSuggestionsListResult>();
    const client = {
      request: vi.fn(() => listed.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });

    const pending = pane.refreshTaskSuggestions();
    pane.connectionGeneration += 1;
    listed.resolve({ suggestions: [suggestion] });

    await pending;
    expect(pane.taskSuggestions).toEqual([]);
  });
});
