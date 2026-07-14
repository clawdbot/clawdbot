/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
  TaskSuggestion,
  TaskSuggestionEvent,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatPageHost } from "./chat-state.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import type { SidebarContent } from "./components/chat-sidebar.ts";

type TestChatPane = HTMLElement & {
  active: boolean;
  chatState: { attach: (state: ChatPageHost) => void };
  context: ApplicationContext;
  state: ChatPageHost;
  connectedClient: GatewayBrowserClient | null;
  connectedCallback: () => void;
  connectionGeneration: number;
  createSession: () => Promise<boolean>;
  disconnectedCallback: () => void;
  acceptTaskSuggestion: (suggestion: TaskSuggestion) => Promise<void>;
  handleDocumentKeydown: (event: KeyboardEvent) => void;
  handleTaskSuggestionEvent: (event: TaskSuggestionEvent) => void;
  refreshTaskSuggestions: () => Promise<void>;
  taskSuggestions: TaskSuggestion[];
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
  sessionKey: string;
  catalogSession: SessionCatalogSession | null;
  catalogItemMessage: (
    item: SessionCatalogTranscriptItem,
    index: number,
  ) => Record<string, unknown> | null;
  handleTranscriptScroll: (event: Event) => void;
  historyAutoLoadBlocked: boolean;
  syncHistoryObserver: () => void;
  loadCatalogSession: (key: CatalogSessionKey, older: boolean) => Promise<boolean>;
  prependUniqueNativeMessages: (messages: unknown[], current: unknown[]) => unknown[];
  loadOlderMessages: () => Promise<void>;
  hasOlderMessages: () => boolean;
  restoreHistoryAnchor: () => void;
  pendingHistoryAnchor: { sessionKey: string; scrollHeight: number; scrollTop: number } | null;
  loadingOlder: boolean;
  catalogCursor: string | undefined;
  olderCursorsSeen: Set<string>;
  olderOffsetsSeen: Set<number>;
  nativeHistoryExpanded: boolean;
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
  return { pane, requestUpdate, state };
}

function nativeHistoryMessage(seq: number, text = `message ${seq}`) {
  return {
    role: seq % 2 === 0 ? "assistant" : "user",
    content: [{ type: "text", text }],
    __openclaw: { seq },
  };
}

function nativeHistorySeq(message: unknown): number | undefined {
  const metadata = (message as Record<string, unknown>)["__openclaw"] as
    | Record<string, unknown>
    | undefined;
  return typeof metadata?.seq === "number" ? metadata.seq : undefined;
}

describe("chat pane initialization", () => {
  it("sets the pane route before attaching outbox projection", () => {
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    const targetSessionKey = "agent:main:pane-b";
    pane.sessionKey = targetSessionKey;
    pane.context = {
      basePath: "",
      gateway: { snapshot: { hello: null } },
      config: {
        current: {
          assistantIdentity: {
            agentId: null,
            name: "Assistant",
            avatar: null,
            avatarSource: null,
            avatarStatus: null,
            avatarReason: null,
          },
          serverVersion: null,
          localMediaPreviewRoots: [],
          embedSandboxMode: "strict",
          allowExternalEmbedUrls: false,
          chatMessageMaxWidth: null,
          terminalEnabled: false,
        },
      },
      agentSelection: { state: { selectedId: "main" } },
      agents: { state: { agentsList: null } },
      sessions: {},
    } as unknown as ApplicationContext;
    const stopAfterAttach = new Error("stop after attach");
    let attachedSessionKey: string | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedSessionKey = state.sessionKey;
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      expect(attachedSessionKey).toBe(targetSessionKey);
    } finally {
      pane.disconnectedCallback();
    }
  });
});

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

describe("chat pane catalog session lifecycle", () => {
  it("finds continuation metadata on a later catalog page", async () => {
    const key = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-101",
    } satisfies CatalogSessionKey;
    const selectedSession: SessionCatalogSession = {
      threadId: key.threadId,
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
    };
    const firstPage: SessionsCatalogListResult = {
      catalogs: [
        {
          id: key.catalogId,
          label: "Codex",
          capabilities: { continueSession: true, archive: true },
          hosts: [
            {
              hostId: key.hostId,
              label: "Gateway",
              kind: "gateway",
              connected: true,
              sessions: [],
              nextCursor: "page-2",
            },
          ],
        },
      ],
    };
    const secondPage: SessionsCatalogListResult = {
      catalogs: [
        {
          ...firstPage.catalogs[0]!,
          hosts: [{ ...firstPage.catalogs[0]!.hosts[0]!, sessions: [selectedSession] }],
        },
      ],
    };
    const transcript: SessionsCatalogReadResult = {
      hostId: key.hostId,
      threadId: key.threadId,
      items: [],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(transcript);
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    pane.sessionKey = buildCatalogSessionKey(key);

    await pane.loadCatalogSession(key, false);

    expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
      catalogId: key.catalogId,
      hostIds: [key.hostId],
      limitPerHost: 100,
      cursors: { [key.hostId]: "page-2" },
    });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.catalog.read", {
      catalogId: key.catalogId,
      hostId: key.hostId,
      threadId: key.threadId,
      limit: 50,
    });
    expect(pane.catalogSession).toEqual(selectedSession);
  });

  it.each([
    {
      name: "uses a raw command for an empty tool call",
      item: { type: "toolCall", raw: { command: "git status --short" } },
      expected: "Tool call\n\ngit status --short",
    },
    {
      name: "uses aggregated output for an empty tool result",
      item: { type: "toolResult", raw: { aggregatedOutput: "working tree clean" } },
      expected: "Tool result\n\nworking tree clean",
    },
    {
      name: "renders an empty reasoning item as its label alone",
      item: { type: "reasoning" },
      expected: "Thinking",
    },
  ])("$name", ({ item, expected }) => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    const message = pane.catalogItemMessage(item as SessionCatalogTranscriptItem, 0) as {
      content: Array<{ text: string }>;
    };

    expect(message.content[0]?.text).toBe(expected);
    expect(message.content[0]?.text).not.toContain("Unsupported external session item");
  });

  it("clamps oversized aggregated tool output before rendering", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    const message = pane.catalogItemMessage(
      {
        type: "toolResult",
        raw: { aggregatedOutput: "x".repeat(5000) },
      } as SessionCatalogTranscriptItem,
      0,
    ) as { content: Array<{ text: string }> };

    // The 500-char preview cap keeps a single huge tool result from injecting
    // megabytes into one chat message; the "Tool result\n\n" prefix adds a bit.
    expect(message.content[0]?.text.length).toBeLessThan(600);
    expect(message.content[0]?.text.startsWith("Tool result")).toBe(true);
  });

  it("skips an empty unknown catalog item", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });

    expect(pane.catalogItemMessage({ type: "other" }, 0)).toBeNull();
  });

  it("exhausts pagination when an older read does not advance the cursor", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "u1", type: "userMessage", text: "hi" }],
      // Same cursor the request was made with: a stale provider that would loop.
      nextCursor: "cursor-1",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-1";

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(false);
    // Cursor cleared → hasOlderMessages() is false, so the observer will not refire.
    expect(pane.catalogCursor).toBeUndefined();
  });

  it("keeps paging when an advancing older page renders nothing new", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      // A page of only unsupported/empty items renders nothing but still advances
      // the cursor: older renderable history may sit behind it, so paging continues.
      items: [{ id: "x1", type: "other" }],
      nextCursor: "cursor-2",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-1";

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(true);
    expect(pane.catalogCursor).toBe("cursor-2");
  });

  it("exhausts pagination when an older read cycles back to a visited cursor", async () => {
    const readPage: SessionsCatalogReadResult = {
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "x1", type: "other" }],
      // Cursor points back to one already visited this session: a c1 -> c2 -> c1
      // cycle that would otherwise loop forever on empty pages.
      nextCursor: "cursor-1",
    };
    const client = {
      request: vi.fn(async () => readPage),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "cursor-2";
    pane.olderCursorsSeen.add("cursor-1");

    const progressed = await pane.loadCatalogSession(
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      true,
    );

    expect(progressed).toBe(false);
    expect(pane.catalogCursor).toBeUndefined();
  });

  it("re-arms a failed older-page load only after another user scroll", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.handleChatScroll = vi.fn();
    pane.historyAutoLoadBlocked = true;
    pane.syncHistoryObserver = vi.fn();
    const event = new Event("scroll");

    pane.handleTranscriptScroll(event);

    expect(pane.historyAutoLoadBlocked).toBe(false);
    expect(pane.syncHistoryObserver).toHaveBeenCalledOnce();
    expect(state.handleChatScroll).toHaveBeenCalledWith(event);
  });

  it("re-arms a blocked auto-load when the manual fallback is clicked", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    // A short (non-scrollable) thread cannot emit a scroll event, so a blocked
    // auto-load must be recoverable through the fallback's loadOlderMessages call.
    state.sessionKey = "catalog:claude:gateway%3Alocal:thread-1";
    pane.historyAutoLoadBlocked = true;
    pane.loadCatalogSession = vi.fn(async () => false);
    pane.hasOlderMessages = vi.fn(() => true);

    await pane.loadOlderMessages();

    // loadOlderMessages clears the block on entry, so the retry is not stranded.
    expect(pane.loadCatalogSession).toHaveBeenCalledOnce();
    expect(pane.historyAutoLoadBlocked).toBe(true);
  });
});

describe("chat pane native history pagination", () => {
  it("renders every row from a complete imported snapshot", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatHistoryPagination = {
      hasMore: false,
      totalMessages: 107,
      completeSnapshot: true,
    };

    expect(pane.hasOlderMessages()).toBe(false);
    expect(pane.nativeHistoryExpanded).toBe(true);
  });

  it("auto-loads a visible sentinel when the initial tail is not scrollable", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    Object.defineProperty(thread, "scrollHeight", { value: 100 });
    Object.defineProperty(thread, "clientHeight", { value: 200 });
    const sentinel = document.createElement("div");
    sentinel.className = "chat-history-sentinel";
    thread.append(sentinel);
    pane.append(thread);
    const observe = vi.fn();
    class FakeIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      disconnect() {}
      observe(target: Element) {
        observe(target);
        this.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    try {
      pane.syncHistoryObserver();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(observe).toHaveBeenCalledWith(sentinel);
      await vi.waitFor(() =>
        expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps multiple projected messages from the same transcript sequence", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const projected = [
      nativeHistoryMessage(1, "tool call"),
      nativeHistoryMessage(1, "visible tool reply"),
    ];

    expect(pane.prependUniqueNativeMessages(projected, [nativeHistoryMessage(2)])).toEqual([
      ...projected,
      nativeHistoryMessage(2),
    ]);
    expect(pane.prependUniqueNativeMessages(projected, projected)).toEqual(projected);
    expect(
      pane.prependUniqueNativeMessages(projected, [projected[1], nativeHistoryMessage(2)]),
    ).toEqual([projected[0], projected[1], nativeHistoryMessage(2)]);
  });

  it("prepends a strictly older page, preserves the viewport, and exhausts", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    let scrollHeight = 600;
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    thread.scrollTop = 40;
    Object.defineProperty(thread, "scrollHeight", { get: () => scrollHeight });
    pane.append(thread);

    await pane.loadOlderMessages();

    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: state.sessionKey,
      limit: 100,
      offset: 2,
    });
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.chatHistoryPagination).toEqual({ hasMore: false, totalMessages: 4 });
    expect(pane.pendingHistoryAnchor).toEqual({
      sessionKey: state.sessionKey,
      scrollHeight: 600,
      scrollTop: 40,
    });
    scrollHeight = 900;
    pane.restoreHistoryAnchor();
    expect(thread.scrollTop).toBe(340);
    expect(pane.hasOlderMessages()).toBe(false);

    await pane.loadOlderMessages();
    expect(request).toHaveBeenCalledOnce();
  });

  it("allows only one native older-page request in flight", async () => {
    const deferred = createDeferred<{
      messages: unknown[];
      hasMore: boolean;
      totalMessages: number;
    }>();
    const request = vi.fn(() => deferred.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };

    const first = pane.loadOlderMessages();
    const second = pane.loadOlderMessages();
    expect(pane.loadingOlder).toBe(true);
    expect(state.requestUpdate).toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();

    deferred.resolve({ messages: [], hasMore: false, totalMessages: 4 });
    await Promise.all([first, second]);
    expect(pane.loadingOlder).toBe(false);
  });

  it("refreshes the tail instead of mixing an older page from a replacement session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
        hasMore: false,
        totalMessages: 2,
        sessionInfo: { sessionId: "session-new" },
      })
      .mockResolvedValueOnce({
        messages: [nativeHistoryMessage(7), nativeHistoryMessage(8)],
        hasMore: false,
        totalMessages: 2,
        sessionInfo: { sessionId: "session-new" },
      });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.currentSessionId = "session-old";
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };

    await pane.loadOlderMessages();

    expect(request).toHaveBeenNthCalledWith(1, "chat.history", {
      sessionKey: state.sessionKey,
      limit: 100,
      offset: 2,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "chat.history",
      expect.objectContaining({ sessionKey: state.sessionKey, limit: 100 }),
    );
    expect(state.currentSessionId).toBe("session-new");
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([7, 8]);
  });

  it("resets loaded depth when chat history refreshes to the tail", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 4,
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [
      nativeHistoryMessage(1),
      nativeHistoryMessage(2),
      nativeHistoryMessage(3),
      nativeHistoryMessage(4),
    ];
    state.chatHistoryPagination = { hasMore: false, totalMessages: 4 };
    pane.olderOffsetsSeen.add(2);
    pane.olderOffsetsSeen.add(4);

    await loadChatHistory(state);

    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4]);
    expect(state.chatHistoryPagination).toEqual({
      hasMore: true,
      nextOffset: 2,
      totalMessages: 4,
    });
    expect(pane.hasOlderMessages()).toBe(true);
    expect(pane.olderOffsetsSeen).toEqual(new Set());
  });

  it("preserves the older-page cursor when a tail refresh fails", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error("gateway unavailable");
      }),
    } as unknown as GatewayBrowserClient;
    const { state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const pagination = { hasMore: true as const, nextOffset: 2, totalMessages: 4 };
    state.chatHistoryPagination = pagination;

    await loadChatHistory(state);

    expect(state.chatHistoryPagination).toBe(pagination);
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
