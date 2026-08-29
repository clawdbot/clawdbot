/* @vitest-environment jsdom */

import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import "./chat-pane.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory, type ChatHistoryResult } from "./chat-history.ts";
import {
  appendChatThread,
  createNativeShowEarlierPane,
  createStagedPrefetchPane,
  createTestChatPane,
  nativeHistoryMessage,
  nativeHistorySeq,
  stagedPagesRequest,
} from "./chat-pane-history.test-support.ts";
import { ChatPane } from "./chat-pane-render.ts";
import { nativeHistoryMessageIdentity } from "./chat-pane-shared.ts";
import {
  createInitializationContext,
  createSessionCapabilityFixture,
} from "./chat-pane.test-support.ts";
import { createPageState } from "./chat-state-page.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import type { ChatProps } from "./chat-view.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

describe("chat pane native history pagination", () => {
  class RefreshChatPane extends ChatPane {
    chatProps: ChatProps | undefined;

    initialize(context: ApplicationContext) {
      this.context = context;
      this.state = createPageState(
        context,
        { afterCommit: () => () => {}, invalidate: () => {} },
        this,
      );
      return this.state;
    }

    protected override renderChatPaneLayout(params: { chatProps: ChatProps }) {
      this.chatProps = params.chatProps;
      return html``;
    }
  }
  customElements.define("openclaw-chat-refresh-regression", RefreshChatPane);

  it("passes only a proven profile viewer identity to transcript rendering", () => {
    const pane = document.createElement("openclaw-chat-refresh-regression") as RefreshChatPane;
    const context: ApplicationContext = {
      ...createInitializationContext(),
      sessions: createSessionCapabilityFixture({
        state: { result: null, agentId: "main", modelOverrides: {} },
        think: () => undefined,
        reconcile: vi.fn(),
      }),
    };
    pane.initialize(context);
    const user = { id: "collision", name: "Viewer", avatarUrl: "/api/users/collision/avatar" };
    context.gateway.snapshot.selfUser = user;
    pane.render();
    expect(pane.chatProps?.userId).toBeNull();
    context.gateway.snapshot.selfUser = { ...user, identity: { type: "profile", id: "collision" } };
    pane.render();
    expect(pane.chatProps?.userId).toBe("collision");
    expect(pane.chatProps?.userAvatar).toBe(user.avatarUrl);
  });

  it("preserves the steer split through the refresh callback and later cumulative deltas", async () => {
    const pane = document.createElement("openclaw-chat-refresh-regression") as RefreshChatPane;
    const history = createDeferred<ChatHistoryResult>();
    const request = vi.fn(() => history.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const context: ApplicationContext = {
      ...createInitializationContext(),
      sessions: createSessionCapabilityFixture({
        state: { result: null, agentId: "main", modelOverrides: {} },
        think: () => undefined,
        reconcile: vi.fn(),
      }),
    };
    context.gateway.snapshot.client = client;
    context.gateway.snapshot.phase = "connected";
    const state = pane.initialize(context);
    state.client = client;
    state.connected = true;
    state.sessionKey = "agent:main:refresh";
    state.chatRunId = "run-refresh";
    const original = {
      role: "user",
      content: "Start working.",
      __openclaw: { id: "original-refresh", idempotencyKey: "run-refresh:user", seq: 1 },
    };
    const steer = {
      role: "user",
      content: "Also check the result.",
      __openclaw: {
        id: "steer-refresh",
        idempotencyKey: "steer-refresh:user",
        steerTargetRunId: "run-refresh",
        seq: 3,
      },
    };
    state.chatMessages = [original];
    const delta = (text: string) =>
      handleChatGatewayEvent(state, {
        state: "delta",
        runId: "run-refresh",
        sessionKey: state.sessionKey,
        message: { role: "assistant", content: text },
      });
    const renderedText = () =>
      buildChatItems({
        paneId: "refresh-regression",
        sessionKey: state.sessionKey,
        runId: state.chatRunId,
        messages: state.chatMessages,
        toolMessages: state.chatToolMessages,
        streamSegments: state.chatStreamSegments,
        stream: state.chatStream,
        streamStartedAt: state.chatStreamStartedAt,
        showToolCalls: true,
      }).flatMap((item) =>
        item.kind === "group"
          ? item.messages.map(({ message }) => extractText(message)?.trim())
          : item.kind === "stream"
            ? [item.text.trim()]
            : [],
      );
    delta("Saved opening.");
    applySessionMessagePayload(state, { message: steer }, true, {
      kind: "live",
      activeRunId: "run-refresh",
    });
    delta("Saved opening. Still working.");
    const expected = [
      "Start working.",
      "Saved opening.",
      "Also check the result.",
      "Still working.",
    ];

    try {
      expect(renderedText()).toEqual(expected);
      pane.render();
      expect(pane.chatProps).toBeDefined();
      pane.chatProps!.onRefresh();
      expect(renderedText()).toEqual(expected);
      history.resolve({
        messages: [
          original,
          {
            role: "assistant",
            content: "Saved opening.",
            __openclaw: { id: "saved-refresh", idempotencyKey: "run-refresh", seq: 2 },
          },
          steer,
        ],
        sessionInfo: {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: 4,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["run-refresh"],
        },
        inFlightRun: { runId: "run-refresh", text: "Saved opening. Still working." },
      });
      await vi.waitFor(() => expect(state.chatLoading).toBe(false));
      expect(renderedText()).toEqual(expected);
      delta("Saved opening. Still working. More progress.");
      expect(renderedText()).toEqual([...expected.slice(0, -1), "Still working. More progress."]);
    } finally {
      state.connected = false;
      history.resolve({ messages: [] });
    }
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

  it("loads at the top through the canonical path and reveals the prepended window", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: true,
      nextOffset: 4,
      totalMessages: 6,
    }));
    const { pane, scrollToOffset, state } = createNativeShowEarlierPane(request);

    await pane.showEarlierMessages();

    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: state.sessionKey,
      limit: 400,
      offset: 2,
    });
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(scrollToOffset).toHaveBeenCalledWith(0);
    expect(pane.transcriptScrollTop).toBe(0);
    expect(pane.historyObserverArmed).toBe(false);
    expect(pane.historyAutoLoadBlocked).toBe(true);
  });

  it("publishes prepended history to the shared session snapshot", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      sessionId: "session-id",
      totalMessages: 4,
    }));
    const { pane, state } = createNativeShowEarlierPane(request);
    state.chatMessagesBySession = new Map();
    state.currentSessionId = "session-id";
    cacheChatSessionSnapshot(
      state.chatMessagesBySession,
      state,
      { sessionKey: state.sessionKey },
      {
        deltaCursor: "delta-cursor",
        messages: state.chatMessages,
        pagination: state.chatHistoryPagination,
        sessionId: "session-id",
      },
    );

    await pane.loadOlderMessages();

    expect(
      readChatSessionSnapshot(state.chatMessagesBySession, state, {
        sessionKey: state.sessionKey,
      }),
    ).toMatchObject({
      deltaCursor: "delta-cursor",
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination,
      sessionId: "session-id",
    });
  });

  it("reveals a final catalog page even when its cursor is exhausted", async () => {
    const request = vi.fn(async () => ({
      hostId: "gateway:local",
      threadId: "thread-1",
      items: [{ id: "u1", type: "userMessage", text: "oldest catalog message" }],
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const key = "catalog:claude:gateway%3Alocal:thread-1";
    state.sessionKey = key;
    pane.sessionKey = key;
    pane.catalogCursor = "final-page";
    appendChatThread(pane);
    vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
    const scrollToOffset = vi.spyOn(pane.transcript, "scrollToOffset");

    await pane.showEarlierMessages();

    expect(request).toHaveBeenCalledWith(
      "sessions.catalog.read",
      expect.objectContaining({ cursor: "final-page" }),
    );
    expect(pane.catalogMessages).toHaveLength(1);
    expect(pane.catalogCursor).toBeUndefined();
    expect(scrollToOffset).toHaveBeenCalledWith(0);
  });

  it("keeps the viewport and pagination retryable when the older load fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("history unavailable");
    });
    const { pane, scrollToOffset, state, thread } = createNativeShowEarlierPane(request);

    await pane.showEarlierMessages();

    expect(thread.scrollTop).toBe(0);
    expect(state.chatHistoryPagination).toMatchObject({ hasMore: true });
    expect(state.lastError).toBe("history unavailable");
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it("keeps a failed older load blocked across a layout-induced scroll", async () => {
    const request = vi.fn(async () => {
      throw new Error("history unavailable");
    });
    const { pane, thread } = createNativeShowEarlierPane(request);
    pane.transcriptScrollTop = 500;

    await pane.showEarlierMessages();
    pane.handleTranscriptScroll({ currentTarget: thread, target: thread } as unknown as Event);

    expect(pane.historyAutoLoadBlocked).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it("joins an in-flight canonical load before revealing its earlier window", async () => {
    const deferred = createDeferred<{
      messages: unknown[];
      hasMore: boolean;
      totalMessages: number;
    }>();
    const request = vi.fn(() => deferred.promise);
    const { pane, scrollToOffset } = createNativeShowEarlierPane(request);

    const automaticLoad = pane.loadOlderMessages();
    const manualNavigation = pane.showEarlierMessages();
    deferred.resolve({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    });
    await Promise.all([automaticLoad, manualNavigation]);

    expect(request).toHaveBeenCalledOnce();
    expect(scrollToOffset).toHaveBeenCalledOnce();
    expect(scrollToOffset).toHaveBeenCalledWith(0);
  });

  it("does not navigate a replacement session after an older load settles", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2 };
    appendChatThread(pane);
    const loaded = createDeferred<boolean>();
    const committed = createDeferred<boolean>();
    vi.spyOn(pane, "loadOlderMessages").mockReturnValue(loaded.promise);
    vi.spyOn(pane, "updateComplete", "get").mockReturnValue(committed.promise);
    const scrollToOffset = vi.spyOn(pane.transcript, "scrollToOffset");

    const navigation = pane.showEarlierMessages();
    loaded.resolve(true);
    await Promise.resolve();
    state.sessionKey = "agent:main:replacement";
    committed.resolve(true);
    await navigation;

    expect(scrollToOffset).not.toHaveBeenCalled();
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
    vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
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

  it("prefetches older history from upward intent well before the top edge", async () => {
    const request = vi.fn(async () => ({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.handleChatScroll = vi.fn();
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    Object.defineProperty(thread, "scrollHeight", { value: 4_000 });
    Object.defineProperty(thread, "clientHeight", { value: 600 });
    const sentinel = document.createElement("div");
    sentinel.className = "chat-history-sentinel";
    thread.append(sentinel);
    pane.append(thread);
    vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
    let observedRootMargin: string | undefined;
    class FakeIntersectionObserver {
      constructor(
        private readonly callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        observedRootMargin = options?.rootMargin;
      }
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
      // Upward scroll far beyond the former 300px edge must already arm the
      // prefetch; the observer then requests the page before the wall.
      pane.transcriptScrollTop = 900;
      thread.scrollTop = 800;
      const event = new Event("scroll");
      Object.defineProperty(event, "target", { value: thread });
      pane.handleTranscriptScroll(event);

      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request).toHaveBeenCalledWith("chat.history", {
        sessionKey: state.sessionKey,
        limit: 400,
        offset: 2,
      });
      expect(observedRootMargin).toBe("1200px 0px 0px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stages the next older page and consumes it without entering the loading state", async () => {
    const request = stagedPagesRequest();
    const { pane, state } = createStagedPrefetchPane(request);

    await pane.loadOlderMessages();

    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([5, 6, 7, 8]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: state.sessionKey,
      limit: 400,
      offset: 4,
    });
    await vi.waitFor(() => expect(pane.stagedOlderPage).not.toBeNull());

    const loadingDuringRender: boolean[] = [];
    (state.requestUpdate as ReturnType<typeof vi.fn>).mockImplementation(() => {
      loadingDuringRender.push(pane.loadingOlder);
    });
    await expect(pane.loadOlderMessages()).resolves.toBe(true);

    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4, 5, 6, 7, 8]);
    // The staged page applies without a round trip or a loading-state render.
    expect(loadingDuringRender).not.toContain(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(3, "chat.history", {
      sessionKey: state.sessionKey,
      limit: 400,
      offset: 6,
    });
  });

  it("joins an in-flight prefetch instead of duplicating the request", async () => {
    const deferred = createDeferred<unknown>();
    const request = stagedPagesRequest({ 4: () => deferred.promise });
    const { pane, state } = createStagedPrefetchPane(request);

    await pane.loadOlderMessages();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    const joined = pane.loadOlderMessages();
    deferred.resolve({
      messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
      hasMore: false,
      totalMessages: 8,
    });
    await expect(joined).resolves.toBe(true);

    const offsetFourCalls = request.mock.calls.filter(
      ([, params]) => (params as { offset?: number }).offset === 4,
    );
    expect(offsetFourCalls).toHaveLength(1);
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("discards a staged page when the pagination cursor moves", async () => {
    const request = stagedPagesRequest({
      5: () => ({
        messages: [nativeHistoryMessage(31), nativeHistoryMessage(32)],
        hasMore: false,
        totalMessages: 9,
      }),
    });
    const { pane, state } = createStagedPrefetchPane(request);

    await pane.loadOlderMessages();
    await vi.waitFor(() => expect(pane.stagedOlderPage).not.toBeNull());

    // A tail reload rebased the cursor beneath the staged page.
    state.chatHistoryPagination = { hasMore: true, nextOffset: 5, totalMessages: 9 };
    await expect(pane.loadOlderMessages()).resolves.toBe(true);

    expect(request).toHaveBeenLastCalledWith("chat.history", {
      sessionKey: state.sessionKey,
      limit: 400,
      offset: 5,
    });
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([31, 32, 5, 6, 7, 8]);
  });

  it("clears the staged page on viewport reset", async () => {
    const request = stagedPagesRequest();
    const { pane } = createStagedPrefetchPane(request);

    await pane.loadOlderMessages();
    await vi.waitFor(() => expect(pane.stagedOlderPage).not.toBeNull());

    pane.resetOlderMessagesViewport();
    expect(pane.stagedOlderPage).toBeNull();
    expect(pane.stagedOlderLoad).toBeNull();

    await expect(pane.loadOlderMessages()).resolves.toBe(true);
    const offsetFourCalls = request.mock.calls.filter(
      ([, params]) => (params as { offset?: number }).offset === 4,
    );
    expect(offsetFourCalls).toHaveLength(2);
  });

  it("keeps prefetch failures silent and retries reactively", async () => {
    let offsetFourCalls = 0;
    const request = stagedPagesRequest({
      4: () => {
        offsetFourCalls += 1;
        if (offsetFourCalls === 1) {
          throw new Error("prefetch boom");
        }
        return {
          messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
          hasMore: false,
          totalMessages: 8,
        };
      },
    });
    const { pane, state } = createStagedPrefetchPane(request);

    await pane.loadOlderMessages();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(pane.stagedOlderLoad).toBeNull());

    expect(state.lastError).toBeNull();
    await expect(pane.loadOlderMessages()).resolves.toBe(true);
    expect(offsetFourCalls).toBe(2);
    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([3, 4, 5, 6, 7, 8]);
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
    vi.spyOn(pane.transcript, "scrollElement", "get").mockReturnValue(thread);
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
      {
        ...nativeHistoryMessage(1, "Same routed send"),
        openclawMessageToolMirror: { toolName: "message", toolCallId: "call-a" },
      },
      {
        ...nativeHistoryMessage(1, "Same routed send"),
        openclawMessageToolMirror: { toolName: "message", toolCallId: "call-b" },
      },
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

  it("deduplicates byte-different live-event and history projections of one transcript row", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const liveEventProjection = {
      role: "assistant",
      content: [{ type: "text", text: "One stored reply" }],
      __openclaw: {
        id: "assistant-message-42",
        idempotencyKey: "run-42",
        seq: 42,
      },
    };
    const historyProjection = {
      role: "assistant",
      content: [{ type: "text", text: "One stored reply" }],
      __openclaw: {
        id: "assistant-message-42",
        idempotencyKey: "run-42",
        recordTimestampMs: 1_786_000_000_000,
        seq: 42,
      },
    };

    expect(nativeHistoryMessageIdentity(liveEventProjection)).toBe(
      nativeHistoryMessageIdentity(historyProjection),
    );
    expect(pane.prependUniqueNativeMessages([historyProjection], [liveEventProjection])).toEqual([
      liveEventProjection,
    ]);
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
      limit: 400,
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
      limit: 400,
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
    await loadChatHistory(state);

    expect(state.chatMessages.map(nativeHistorySeq)).toEqual([1, 2, 3, 4]);
    expect(state.chatHistoryPagination).toEqual({
      hasMore: false,
      totalMessages: 4,
    });
    expect(pane.hasOlderMessages()).toBe(false);
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
