/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey, type CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { AfterCommitEffect } from "./render-lifecycle.ts";
import type { ChatSessionScrollPosition } from "./scroll.ts";

type TestChatPane = HTMLElement & {
  catalogMessages: unknown[];
  context: ApplicationContext;
  state: ChatPageHost;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  continueCatalogSession: (key: CatalogSessionKey) => Promise<void>;
  catalogLoadGeneration: number;
  catalogSession: SessionCatalogSession | null;
  sessionKey: string;
  switchPaneSession: (nextSessionKey: string) => void;
  onPaneSessionChange?: (paneId: string, sessionKey: string) => void;
  catalogItemMessage: (item: SessionCatalogTranscriptItem) => Record<string, unknown> | null;
  handleTranscriptScroll: (event: Event) => void;
  historyAutoLoadBlocked: boolean;
  historyObserverArmed: boolean;
  syncHistoryObserver: () => void;
  prependUniqueNativeMessages: (messages: unknown[], current: unknown[]) => unknown[];
  prependUniqueCatalogMessages: (messages: unknown[]) => unknown[];
  loadOlderMessages: () => Promise<void>;
  hasOlderMessages: () => boolean;
  loadingOlder: boolean;
  olderOffsetsSeen: Set<number>;
  resetOlderMessagesViewport: (nextSessionKey?: string) => ChatSessionScrollPosition | null;
  restoreOlderMessagesViewport: (sessionKey: string, scrollTop: number) => void;
  transcriptScrollTop: number | null;
  transcript: {
    activeSessionKey: string | null;
    pendingScrollOffsetFor: (sessionKey: string) => number | null;
  };
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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
    chatSendingScopeKey: null,
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
    sidebarLayout: { columns: [] },
    chatScrollGeneration: 0,
    chatScrollCommitCleanup: null,
    chatScrollFrame: null,
    chatScrollGuardFrame: null,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: false,
    chatProgrammaticScrollTarget: 0,
    handleChatScroll: vi.fn(),
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
  } as unknown as ChatPageHost;
  pane.context = createSessionContext(params.client, params.sessions);
  pane.state = state;
  pane.connectedClient = params.client;
  pane.connectionGeneration = 4;
  return { pane, state, requestUpdate };
}

function createCatalogContinuationPane(request: ReturnType<typeof vi.fn>) {
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = {} as SessionCapability;
  const { pane, requestUpdate, state } = createTestChatPane({ client, sessions });
  const key = {
    catalogId: "codex",
    hostId: "gateway:local",
    threadId: "thread-101",
  } satisfies CatalogSessionKey;
  const sourceSessionKey = buildCatalogSessionKey(key);
  state.sessionKey = sourceSessionKey;
  pane.sessionKey = sourceSessionKey;
  state.chatMessage = "Continue the original catalog conversation";
  state.handleChatDraftChange = vi.fn((draft: string) => {
    state.chatMessage = draft;
  });
  state.handleSendChat = vi.fn(async () => undefined);
  pane.catalogSession = {
    threadId: key.threadId,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
  };
  pane.onPaneSessionChange = vi.fn();
  pane.switchPaneSession = vi.fn((nextSessionKey: string) => {
    state.sessionKey = nextSessionKey;
    pane.sessionKey = nextSessionKey;
    pane.catalogLoadGeneration += 1;
  });
  return { client, key, pane, requestUpdate, sessions, sourceSessionKey, state };
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

describe("chat pane native history pagination", () => {
  it("restores a saved per-session viewport while first visits keep the end anchor", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 2_600 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 500 });
    thread.scrollTop = 420;
    pane.append(thread);
    pane.transcript.activeSessionKey = state.sessionKey;

    expect(pane.resetOlderMessagesViewport("agent:main:session-b")).toBeNull();
    state.sessionKey = "agent:main:session-b";
    pane.transcript.activeSessionKey = state.sessionKey;
    thread.scrollTop = 80;
    expect(pane.resetOlderMessagesViewport("agent:main:current")).toEqual({
      scrollTop: 420,
      anchorToEnd: false,
    });

    state.sessionKey = "agent:main:current";
    pane.transcript.activeSessionKey = state.sessionKey;
    let commitEffect: AfterCommitEffect | undefined;
    state.renderLifecycle.afterCommit = vi.fn((effect: AfterCommitEffect) => {
      commitEffect = effect;
      return vi.fn();
    });
    pane.restoreOlderMessagesViewport(state.sessionKey, 420);
    commitEffect?.(vi.fn());

    expect(thread.scrollTop).toBe(420);
    expect(pane.transcriptScrollTop).toBe(420);
    expect(state.chatHasAutoScrolled).toBe(true);
    expect(state.chatFollowLocked).toBe(true);
    expect(state.chatNewMessagesBelow).toBe(true);

    // A rapid second switch sees a transient DOM top of zero while the
    // logical restore is still pending; it must retain the logical 420px.
    thread.scrollTop = 0;
    const pendingScrollOffset = vi
      .spyOn(pane.transcript, "pendingScrollOffsetFor")
      .mockReturnValue(420);
    expect(pane.resetOlderMessagesViewport("agent:main:session-b")).toEqual({
      scrollTop: 80,
      anchorToEnd: false,
    });
    pendingScrollOffset.mockRestore();
    state.sessionKey = "agent:main:session-b";
    pane.transcript.activeSessionKey = state.sessionKey;
    expect(pane.resetOlderMessagesViewport("agent:main:current")).toEqual({
      scrollTop: 420,
      anchorToEnd: false,
    });
  });

  it("restores through equivalent default-main session keys", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.sessionKey = "agent:main:main";
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 2_600 });
    Object.defineProperty(thread, "clientHeight", { configurable: true, value: 500 });
    pane.append(thread);
    let commitEffect: AfterCommitEffect | undefined;
    state.renderLifecycle.afterCommit = vi.fn((effect: AfterCommitEffect) => {
      commitEffect = effect;
      return vi.fn();
    });

    pane.restoreOlderMessagesViewport("main", 420);
    commitEffect?.(vi.fn());

    expect(thread.scrollTop).toBe(420);
    expect(pane.transcriptScrollTop).toBe(420);
  });

  it("does not request older rows from a complete imported snapshot", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatHistoryPagination = {
      hasMore: false,
      totalMessages: 107,
      completeSnapshot: true,
    };

    expect(pane.hasOlderMessages()).toBe(false);
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

  it("does not consume bootstrap history while disconnected", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.connected = false;
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    const construct = vi.fn();
    class FakeIntersectionObserver {
      constructor() {
        construct();
      }
      disconnect() {}
      observe() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    pane.syncHistoryObserver();

    expect(construct).not.toHaveBeenCalled();
    expect(pane.historyAutoLoadBlocked).toBe(false);
  });

  it("stops non-scrollable bootstrap after one older page", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
      hasMore: true,
      nextOffset: 4,
      totalMessages: 6,
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(5), nativeHistoryMessage(6)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 6 };
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    Object.defineProperty(thread, "scrollHeight", { value: 100 });
    Object.defineProperty(thread, "clientHeight", { value: 200 });
    const sentinel = document.createElement("div");
    sentinel.className = "chat-history-sentinel";
    thread.append(sentinel);
    pane.append(thread);
    class FakeIntersectionObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      disconnect() {}
      observe() {
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
      await vi.waitFor(() =>
        expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4, 5, 6]),
      );

      pane.syncHistoryObserver();

      expect(request).toHaveBeenCalledOnce();
      expect(pane.historyAutoLoadBlocked).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reuses an unchanged armed history observer across pane updates", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    pane.historyObserverArmed = true;
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    Object.defineProperty(thread, "scrollHeight", { value: 400 });
    Object.defineProperty(thread, "clientHeight", { value: 200 });
    const sentinel = document.createElement("div");
    sentinel.className = "chat-history-sentinel";
    thread.append(sentinel);
    pane.append(thread);
    const observe = vi.fn();
    const disconnect = vi.fn();
    const construct = vi.fn();
    class FakeIntersectionObserver {
      constructor() {
        construct();
      }
      disconnect() {
        disconnect();
      }
      observe(target: Element) {
        observe(target);
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    try {
      pane.syncHistoryObserver();
      pane.syncHistoryObserver();

      expect(construct).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledWith(sentinel);
      expect(disconnect).not.toHaveBeenCalled();
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

  it("deduplicates projected catalog transcript records by catalog message id", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const current = pane.catalogItemMessage({
      id: "catalog-item-1",
      type: "userMessage",
      text: "newer projection",
    });
    const overlapping = pane.catalogItemMessage({
      id: "catalog-item-1",
      type: "userMessage",
      text: "older projection",
    });
    if (!current || !overlapping) {
      throw new Error("expected catalog transcript projections");
    }
    pane.catalogMessages = [current];

    expect(pane.prependUniqueCatalogMessages([overlapping])).toEqual([current]);
  });

  it("prepends a strictly older page and exhausts", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    await pane.loadOlderMessages();

    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: state.sessionKey,
      limit: 100,
      offset: 2,
    });
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.chatHistoryPagination).toEqual({ hasMore: false, totalMessages: 4 });
    expect(state.lastError).toBeNull();
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

  it("revalidates the tail without discarding loaded depth for the same backing session", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 4,
      sessionInfo: { sessionId: "session-current" },
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.currentSessionId = "session-current";
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

    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.chatHistoryPagination).toEqual({
      hasMore: false,
      totalMessages: 4,
    });
    expect(pane.hasOlderMessages()).toBe(false);
    expect(pane.olderOffsetsSeen).toEqual(new Set());
  });

  it("keeps projected siblings while replacing the overlapping tail", async () => {
    const firstProjection = nativeHistoryMessage(3, "first projection");
    const secondProjection = nativeHistoryMessage(3, "second projection");
    const request = vi.fn(async () => ({
      messages: [firstProjection, secondProjection, nativeHistoryMessage(4)],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 4,
      sessionInfo: { sessionId: "session-current" },
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.currentSessionId = "session-current";
    state.chatMessages = [
      nativeHistoryMessage(1),
      nativeHistoryMessage(2),
      nativeHistoryMessage(3, "stale projection"),
      nativeHistoryMessage(4, "stale latest"),
    ];
    state.chatHistoryPagination = { hasMore: false, totalMessages: 4 };

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([
      nativeHistoryMessage(1),
      nativeHistoryMessage(2),
      firstProjection,
      secondProjection,
      nativeHistoryMessage(4),
    ]);
  });

  it("replaces the tail when the refreshed raw range does not overlap loaded history", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(7), nativeHistoryMessage(8)],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 8,
      sessionInfo: { sessionId: "session-current" },
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.currentSessionId = "session-current";
    state.chatMessages = [
      nativeHistoryMessage(1),
      nativeHistoryMessage(2),
      nativeHistoryMessage(3),
      nativeHistoryMessage(4),
    ];
    state.chatHistoryPagination = { hasMore: false, totalMessages: 4 };

    await loadChatHistory(state);

    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([7, 8]);
    expect(state.chatHistoryPagination).toEqual({
      hasMore: true,
      nextOffset: 2,
      totalMessages: 8,
    });
  });

  it("preserves loaded visible rows when an adjacent refreshed page projects empty", async () => {
    const request = vi.fn(async () => ({
      messages: [],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 6,
      sessionInfo: { sessionId: "session-current" },
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.currentSessionId = "session-current";
    state.chatMessages = [
      nativeHistoryMessage(1),
      nativeHistoryMessage(2),
      nativeHistoryMessage(3),
      nativeHistoryMessage(4),
    ];
    state.chatHistoryPagination = { hasMore: false, totalMessages: 4 };

    await loadChatHistory(state);

    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.chatHistoryPagination).toEqual({
      hasMore: false,
      totalMessages: 6,
    });
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

describe("chat pane catalog continuation lifecycle", () => {
  it("continues and sends a catalog draft while its original connection remains current", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:continued" });
    const { key, pane, state } = createCatalogContinuationPane(request);

    await pane.continueCatalogSession(key);

    expect(request).toHaveBeenCalledWith("sessions.catalog.continue", key);
    const onPaneSessionChange = expectDefined(
      pane.onPaneSessionChange,
      "catalog continuation navigation callback",
    );
    expect(onPaneSessionChange).toHaveBeenCalledWith("single", "agent:main:continued");
    expect(pane.switchPaneSession).toHaveBeenCalledWith("agent:main:continued");
    expect(
      expectDefined(
        vi.mocked(pane.switchPaneSession).mock.invocationCallOrder[0],
        "catalog continuation session switch order",
      ),
    ).toBeLessThan(
      expectDefined(
        vi.mocked(onPaneSessionChange).mock.invocationCallOrder[0],
        "catalog continuation navigation order",
      ),
    );
    expect(state.handleChatDraftChange).toHaveBeenCalledWith(
      "Continue the original catalog conversation",
    );
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  });

  it("does not send a stale catalog draft after the user switches conversations", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    state.sessionKey = "agent:main:different-conversation";
    pane.sessionKey = state.sessionKey;
    pane.catalogLoadGeneration += 1;
    state.chatMessage = "Draft belonging to the selected conversation";
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(pane.switchPaneSession).not.toHaveBeenCalled();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.sessionKey).toBe("agent:main:different-conversation");
    expect(state.chatMessage).toBe("Draft belonging to the selected conversation");
    expect(state.chatSending).toBe(false);
  });

  it("does not send a stale catalog draft after reconnecting the same Gateway client", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.chatMessage = "Draft from the reconnected conversation";
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(pane.switchPaneSession).not.toHaveBeenCalled();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatMessage).toBe("Draft from the reconnected conversation");
    expect(state.chatSending).toBe(false);
  });

  it("does not apply an old catalog continuation after replacing the Gateway client", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, sessions, state } = createCatalogContinuationPane(request);
    const replacementClient = { request: vi.fn() } as unknown as GatewayBrowserClient;

    const pending = pane.continueCatalogSession(key);
    state.client = replacementClient;
    pane.connectedClient = replacementClient;
    pane.context = createSessionContext(replacementClient, sessions);
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.chatMessage = "Draft from the replacement Gateway";
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
    expect(pane.switchPaneSession).not.toHaveBeenCalled();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.client).toBe(replacementClient);
    expect(state.chatMessage).toBe("Draft from the replacement Gateway");
    expect(state.chatSending).toBe(false);
  });

  it("does not clear a newer scoped send when a stale catalog continuation resolves", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    state.sessionKey = "agent:main:different-conversation";
    pane.sessionKey = state.sessionKey;
    pane.catalogLoadGeneration += 1;
    state.chatSendingScopeKey = "newer-conversation-send";
    state.chatSending = true;
    continued.resolve({ sessionKey: "agent:main:stale-continuation" });
    await pending;

    expect(pane.switchPaneSession).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSendingScopeKey).toBe("newer-conversation-send");
    expect(state.chatSending).toBe(true);
  });

  it("allows only the latest overlapping catalog continuation to adopt and send", async () => {
    const first = createDeferred<{ sessionKey: string }>();
    const second = createDeferred<{ sessionKey: string }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { key, pane, state } = createCatalogContinuationPane(request);

    const staleContinuation = pane.continueCatalogSession(key);
    state.chatMessage = "Only send the latest catalog draft";
    const currentContinuation = pane.continueCatalogSession(key);
    first.resolve({ sessionKey: "agent:main:stale-continuation" });
    await staleContinuation;

    expect(pane.switchPaneSession).not.toHaveBeenCalled();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(state.chatSending).toBe(true);

    second.resolve({ sessionKey: "agent:main:latest-continuation" });
    await currentContinuation;

    expect(pane.switchPaneSession).toHaveBeenCalledOnce();
    expect(pane.switchPaneSession).toHaveBeenCalledWith("agent:main:latest-continuation");
    expect(state.handleChatDraftChange).toHaveBeenCalledWith("Only send the latest catalog draft");
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  });

  it("does not display a rejected catalog continuation in a different conversation", async () => {
    const continued = createDeferred<{ sessionKey: string }>();
    const request = vi.fn(() => continued.promise);
    const { key, pane, requestUpdate, state } = createCatalogContinuationPane(request);

    const pending = pane.continueCatalogSession(key);
    state.sessionKey = "agent:main:different-conversation";
    pane.sessionKey = state.sessionKey;
    pane.catalogLoadGeneration += 1;
    state.lastError = "Current conversation error";
    state.chatMessage = "Draft belonging to the selected conversation";
    const updatesBeforeReject = requestUpdate.mock.calls.length;
    continued.reject(new Error("Stale catalog continuation failed"));
    await pending;

    expect(state.lastError).toBe("Current conversation error");
    expect(state.chatSending).toBe(false);
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(requestUpdate).toHaveBeenCalledTimes(updatesBeforeReject + 1);
  });

  it("reports a catalog continuation failure in the original conversation", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Catalog continuation failed"));
    const { key, pane, state } = createCatalogContinuationPane(request);

    await pane.continueCatalogSession(key);

    expect(state.lastError).toBe("Catalog continuation failed");
    expect(state.chatSending).toBe(false);
    expect(state.handleSendChat).not.toHaveBeenCalled();
  });

  it("reports a send failure in the newly adopted catalog conversation", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:continued" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    state.handleSendChat = vi.fn(async () => {
      throw new Error("Could not send the continued draft");
    });

    await pane.continueCatalogSession(key);

    expect(state.sessionKey).toBe("agent:main:continued");
    expect(state.lastError).toBe("Could not send the continued draft");
    expect(state.chatSending).toBe(false);
  });

  it("does not display an adopted send failure after returning to the source conversation", async () => {
    const sent = createDeferred<void>();
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:continued" });
    const { key, pane, sourceSessionKey, state } = createCatalogContinuationPane(request);
    state.handleSendChat = vi.fn(() => sent.promise);

    const pending = pane.continueCatalogSession(key);
    await vi.waitFor(() => expect(state.handleSendChat).toHaveBeenCalledOnce());
    state.sessionKey = sourceSessionKey;
    pane.sessionKey = sourceSessionKey;
    pane.catalogLoadGeneration += 1;
    state.lastError = "Current catalog conversation error";
    state.chatSending = false;
    sent.reject(new Error("Stale adopted conversation send failed"));
    await pending;

    expect(state.sessionKey).toBe(sourceSessionKey);
    expect(state.lastError).toBe("Current catalog conversation error");
    expect(state.chatSending).toBe(false);
  });

  it("reports an error when adopting the current catalog conversation fails", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:continued" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    pane.switchPaneSession = vi.fn(() => {
      throw new Error("Could not open the adopted conversation");
    });

    await pane.continueCatalogSession(key);

    expect(state.lastError).toBe("Could not open the adopted conversation");
    expect(state.chatSending).toBe(false);
    expect(state.handleSendChat).not.toHaveBeenCalled();
  });

  it("reports an adoption failure after the session transition has already started", async () => {
    const request = vi.fn().mockResolvedValue({ sessionKey: "agent:main:continued" });
    const { key, pane, state } = createCatalogContinuationPane(request);
    pane.switchPaneSession = vi.fn((nextSessionKey: string) => {
      state.sessionKey = nextSessionKey;
      pane.sessionKey = nextSessionKey;
      pane.catalogLoadGeneration += 1;
      throw new Error("Could not finish opening the adopted conversation");
    });

    await pane.continueCatalogSession(key);

    expect(state.sessionKey).toBe("agent:main:continued");
    expect(state.lastError).toBe("Could not finish opening the adopted conversation");
    expect(state.chatSending).toBe(false);
    expect(state.handleSendChat).not.toHaveBeenCalled();
  });
});
