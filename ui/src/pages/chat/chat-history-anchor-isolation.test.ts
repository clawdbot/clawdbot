import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  cancelPendingChatHistoryAnchor,
  completeChatHistoryAnchorVisibility,
  deferPendingChatHistoryAnchorTerminalRefresh,
  loadChatHistory,
  loadOlderChatHistoryPage,
  type ChatHistoryResult,
  type ChatState,
} from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

function message(role: "assistant" | "user", text: string, id: string, seq: number) {
  return {
    role,
    content: [{ type: "text", text }],
    __openclaw: { id, seq },
  };
}

function createHistoryState(request: ReturnType<typeof vi.fn>): ChatState {
  return {
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    sessionKey: "main",
    currentSessionId: "session-current",
    chatLoading: false,
    chatMessages: [],
    chatMessagesBySession: new Map(),
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    hello: null,
  };
}

describe("historical transcript anchor isolation", () => {
  it("keeps a pending anchor through same-session invalidations", async () => {
    const historical = message("user", "historical hit", "historical-hit", 1);
    let resolveAnchor: (result: ChatHistoryResult) => void = () => undefined;
    const anchorResult = new Promise<ChatHistoryResult>((resolve) => {
      resolveAnchor = resolve;
    });
    const request = vi.fn((method: string) =>
      method === "chat.history" ? anchorResult : Promise.resolve(undefined),
    );
    const state = createHistoryState(request) as ChatPageHost;
    state.sessions = {
      reconcileChanged: vi.fn().mockReturnValue({ applied: false }),
      refresh: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatPageHost["sessions"];
    state.requestUpdate = vi.fn();

    const load = loadChatHistory(state, {
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    expect(state.chatHistoryAnchorPending).toMatchObject({
      sessionId: "session-history",
      messageId: "historical-hit",
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: "main",
        message: message("user", "new live prompt", "live-user", 10),
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "main", agentId: "main", phase: "message" },
    });
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    resolveAnchor({ messages: [historical], sessionId: "session-history" });
    await load;

    expect(state.chatHistoryAnchorPending).toMatchObject({
      sessionId: "session-history",
      messageId: "historical-hit",
    });
    expect(state.chatHistoryAnchorActive).toBe(true);
    expect(state.chatMessages).toEqual([historical]);
  });

  it("replays a terminal refresh only after the matching anchor is visibly complete", async () => {
    const current = message("user", "current tail", "current-tail", 9);
    const historical = message("user", "historical hit", "historical-hit", 1);
    const final = message("assistant", "new live reply", "live-final", 10);
    let resolveAnchor: (result: ChatHistoryResult) => void = () => undefined;
    const anchorResult = new Promise<ChatHistoryResult>((resolve) => {
      resolveAnchor = resolve;
    });
    let resolveOrdinary: (result: ChatHistoryResult) => void = () => undefined;
    const ordinaryResult = new Promise<ChatHistoryResult>((resolve) => {
      resolveOrdinary = resolve;
    });
    let historyRequest = 0;
    const request = vi.fn((method: string) => {
      if (method !== "chat.history") {
        return Promise.resolve(undefined);
      }
      historyRequest += 1;
      return historyRequest === 1 ? anchorResult : ordinaryResult;
    });
    const state = createHistoryState(request) as ChatPageHost;
    state.requestUpdate = vi.fn();
    state.chatMessages = [current];
    cacheChatSessionSnapshot(
      state.chatMessagesBySession ?? new Map(),
      state,
      { sessionKey: state.sessionKey },
      {
        messages: [current],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "session-current",
      },
    );

    const load = loadChatHistory(state, {
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "main",
        runId: "live-run",
        state: "final",
        message: final,
      },
    });
    expect(historyRequest).toBe(1);

    resolveAnchor({ messages: [historical], sessionId: "session-history" });
    await load;
    await Promise.resolve();
    expect(historyRequest).toBe(1);
    expect(state.chatHistoryAnchorActive).toBe(true);
    expect(state.chatMessages).toEqual([historical]);

    const completion = completeChatHistoryAnchorVisibility(state, {
      sessionId: "session-history",
      messageId: "historical-hit",
    });
    expect(completion?.shouldRefresh).toBe(true);
    const refresh = completion?.shouldRefresh ? loadChatHistory(state) : Promise.resolve(undefined);
    await vi.waitFor(() => expect(historyRequest).toBe(2));

    resolveOrdinary({ messages: [current, final], sessionId: "session-current" });
    const refreshed = await refresh;
    completion?.completeRefresh(refreshed);

    expect(historyRequest).toBe(2);
    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.chatMessages).toEqual([current, final]);
  });

  it.each([
    {
      name: "terminal session.message",
      prepare: (state: ChatPageHost) => {
        state.chatRunId = "terminal-session-message-run";
        state.chatStream = "in flight";
        vi.spyOn(state.sessions, "reconcileChanged").mockReturnValue({
          applied: true,
          result: null,
          row: {
            key: state.sessionKey,
            kind: "direct",
            hasActiveRun: false,
            status: "done",
            updatedAt: 2,
          },
        });
      },
      event: (state: ChatPageHost) => ({
        type: "event" as const,
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          agentId: "main",
          runId: "terminal-session-message-run",
          hasActiveRun: false,
          status: "done",
        },
      }),
      duplicate: true,
    },
    {
      name: "cursorless terminal sessions.changed",
      prepare: (state: ChatPageHost) => {
        state.chatRunId = "terminal-sessions-changed-run";
        state.chatStream = "in flight";
        vi.spyOn(state.sessions, "reconcileChanged").mockReturnValue({
          applied: true,
          result: null,
          row: {
            key: state.sessionKey,
            kind: "direct",
            hasActiveRun: false,
            status: "done",
            updatedAt: 2,
          },
        });
      },
      event: (state: ChatPageHost) => ({
        type: "event" as const,
        event: "sessions.changed",
        payload: {
          sessionKey: state.sessionKey,
          agentId: "main",
          phase: "message",
          runId: "terminal-sessions-changed-run",
          hasActiveRun: false,
          status: "done",
        },
      }),
      duplicate: true,
    },
    {
      name: "sessions.changed reset",
      event: (state: ChatPageHost) => ({
        type: "event" as const,
        event: "sessions.changed",
        payload: {
          sessionKey: state.sessionKey,
          agentId: "main",
          reason: "reset",
        },
      }),
      reset: true,
    },
  ])(
    "holds $name refresh until the pending anchor is visibly complete",
    async ({ prepare, event, duplicate, reset }) => {
      const historical = message("user", "historical hit", "historical-hit", 1);
      const current = message("assistant", "current tail", "current-tail", 9);
      let resolveAnchor: (result: ChatHistoryResult) => void = () => undefined;
      const anchorResult = new Promise<ChatHistoryResult>((resolve) => {
        resolveAnchor = resolve;
      });
      let resolveOrdinary: (result: ChatHistoryResult) => void = () => undefined;
      const ordinaryResult = new Promise<ChatHistoryResult>((resolve) => {
        resolveOrdinary = resolve;
      });
      let historyRequest = 0;
      const state = makeChatHost({
        sessionKey: "agent:main:main",
        requestHandlers: {
          "chat.history": () => {
            historyRequest += 1;
            return historyRequest === 1 ? anchorResult : ordinaryResult;
          },
        },
      }) as unknown as ChatPageHost;
      state.connectionEpoch = 1;
      state.currentSessionId = "session-current";
      state.chatMessagesBySession = new Map();
      state.chatMessages = [current];
      state.requestUpdate = vi.fn();
      cacheChatSessionSnapshot(
        state.chatMessagesBySession,
        state,
        { sessionKey: state.sessionKey },
        {
          messages: [current],
          pagination: { hasMore: false, completeSnapshot: true },
          sessionId: "session-current",
        },
      );
      prepare?.(state);

      const load = loadChatHistory(state, {
        historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
      });
      handlePageGatewayEvent(state, event(state));
      if (duplicate) {
        handlePageGatewayEvent(state, event(state));
      }
      await Promise.resolve();

      expect(historyRequest).toBe(1);
      expect(state.chatMessages).toEqual([current]);
      expect(state.chatHistoryAnchorPending).toMatchObject({
        sessionId: "session-history",
        messageId: "historical-hit",
        terminalRefreshPending: true,
      });
      if (prepare) {
        expect(state.chatHistoryAnchorPending?.deferredRefresh?.promise).toEqual(
          expect.any(Promise),
        );
        expect(state.pendingSessionMessageReloadSessionKey ?? null).toBeNull();
      }
      if (reset) {
        expect(
          readChatMessagesFromCache(state.chatMessagesBySession, state, {
            sessionKey: state.sessionKey,
          }),
        ).toEqual([]);
      }

      resolveAnchor({ messages: [historical], sessionId: "session-history" });
      await load;
      expect(historyRequest).toBe(1);
      expect(state.chatMessages).toEqual([historical]);

      const completion = completeChatHistoryAnchorVisibility(state, {
        sessionId: "session-history",
        messageId: "historical-hit",
      });
      expect(completion?.shouldRefresh).toBe(true);
      const refresh = loadChatHistory(state);
      await vi.waitFor(() => expect(historyRequest).toBe(2));

      resolveOrdinary({ messages: [current], sessionId: "session-current" });
      const refreshed = await refresh;
      completion?.completeRefresh(refreshed);
      await Promise.resolve();
      await Promise.resolve();
      expect(historyRequest).toBe(2);
      expect(state.chatMessages).toEqual([current]);
    },
  );

  it("recovers one canonical refresh and one completion when an anchored request fails", async () => {
    const current = message("assistant", "current tail", "current-tail", 9);
    let historyRequest = 0;
    const request = vi.fn((method: string) => {
      if (method !== "chat.history") {
        return Promise.resolve(undefined);
      }
      historyRequest += 1;
      return historyRequest === 1
        ? Promise.reject(new Error("anchor unavailable"))
        : Promise.resolve({ messages: [current], sessionId: "session-current" });
    });
    const state = createHistoryState(request);
    const load = loadChatHistory(state, {
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    expect(deferPendingChatHistoryAnchorTerminalRefresh(state)).toBe(true);
    const deferred = loadChatHistory(state);
    const duplicate = loadChatHistory(state);
    const settled = vi.fn();
    void deferred.then(settled);
    await load;

    await vi.waitFor(() => expect(historyRequest).toBe(2));
    const [result, duplicateResult] = await Promise.all([deferred, duplicate]);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ sessionId: "session-current" });
    expect(duplicateResult).toBe(result);
    expect(state.chatHistoryAnchorPending).toBeNull();
    expect(state.chatMessages).toEqual([current]);
  });

  it("coalesces ordinary owner calls without superseding a pending anchor", async () => {
    const historical = message("user", "historical hit", "historical-hit", 1);
    const current = message("assistant", "current tail", "current-tail", 9);
    let resolveAnchor: (result: ChatHistoryResult) => void = () => undefined;
    const anchorResult = new Promise<ChatHistoryResult>((resolve) => {
      resolveAnchor = resolve;
    });
    let resolveOrdinary: (result: ChatHistoryResult) => void = () => undefined;
    const ordinaryResult = new Promise<ChatHistoryResult>((resolve) => {
      resolveOrdinary = resolve;
    });
    const methods: string[] = [];
    const request = vi.fn((method: string) => {
      methods.push(method);
      return method === "chat.history" ? anchorResult : ordinaryResult;
    });
    const state = createHistoryState(request);

    const anchorLoad = loadChatHistory(state, {
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    const ordinary = loadChatHistory(state);
    const startup = loadChatHistory(state, { startup: true, deferBranches: true });
    await expect(loadOlderChatHistoryPage(state, 0)).resolves.toBeUndefined();
    expect(methods).toEqual(["chat.history"]);

    resolveAnchor({ messages: [historical], sessionId: "session-history" });
    await anchorLoad;
    const completion = completeChatHistoryAnchorVisibility(state, {
      sessionId: "session-history",
      messageId: "historical-hit",
    });
    expect(completion).toMatchObject({
      shouldRefresh: true,
      refreshOptions: { startup: true, deferBranches: false },
    });

    const refresh = loadChatHistory(state, completion?.refreshOptions);
    expect(methods).toEqual(["chat.history", "chat.startup"]);
    resolveOrdinary({ messages: [current], sessionId: "session-current" });
    const refreshed = await refresh;
    completion?.completeRefresh(refreshed);

    const [ordinaryResultValue, startupResultValue] = await Promise.all([ordinary, startup]);
    expect(ordinaryResultValue).toBe(refreshed);
    expect(startupResultValue).toBe(refreshed);
    expect(methods).toEqual(["chat.history", "chat.startup"]);
  });

  it("settles parked owner calls when the pending anchor is cancelled", async () => {
    let resolveAnchor: (result: ChatHistoryResult) => void = () => undefined;
    const anchorResult = new Promise<ChatHistoryResult>((resolve) => {
      resolveAnchor = resolve;
    });
    const request = vi.fn().mockReturnValue(anchorResult);
    const state = createHistoryState(request);
    const anchorLoad = loadChatHistory(state, {
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    const deferred = loadChatHistory(state);

    cancelPendingChatHistoryAnchor(state);
    await expect(deferred).resolves.toBeUndefined();
    resolveAnchor({ messages: [], sessionId: "session-history" });
    await anchorLoad;

    expect(request).toHaveBeenCalledOnce();
    expect(state.chatHistoryAnchorPending).toBeNull();
  });

  it("settles parked owner calls on a missing-scope anchor failure", async () => {
    const error = Object.assign(new Error("permission denied"), {
      name: "GatewayRequestError",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    });
    const request = vi.fn().mockRejectedValue(error);
    const state = createHistoryState(request);
    const anchorLoad = loadChatHistory(state, {
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    const deferred = loadChatHistory(state);

    await anchorLoad;
    await expect(deferred).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(state.chatHistoryAnchorPending).toBeNull();
  });

  it("ignores a runless cursorless sessions.changed event while an anchor is pending", async () => {
    const historical = message("user", "historical hit", "historical-hit", 1);
    const request = vi.fn().mockResolvedValue({
      messages: [historical],
      sessionId: "session-history",
    });
    const state = createHistoryState(request) as ChatPageHost;
    state.sessions = {
      reconcileChanged: vi.fn().mockReturnValue({ applied: false }),
      refresh: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatPageHost["sessions"];
    state.requestUpdate = vi.fn();

    await loadChatHistory(state, {
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "main", agentId: "main", phase: "message" },
    });
    await Promise.resolve();

    expect(request).toHaveBeenCalledOnce();
    expect(state.chatHistoryAnchorPending).toMatchObject({
      sessionId: "session-history",
      messageId: "historical-hit",
    });
    expect(state.chatHistoryAnchorPending?.terminalRefreshPending).toBeUndefined();
    expect(state.chatMessages).toEqual([historical]);
  });

  it("keeps page events anchored until a terminal chat event restores ordinary history", async () => {
    const current = message("user", "current tail", "current-tail", 9);
    const historical = message("user", "historical hit", "historical-hit", 1);
    const final = message("assistant", "new live reply", "live-final", 10);
    let resolveOrdinary: (result: ChatHistoryResult) => void = () => undefined;
    const ordinary = new Promise<ChatHistoryResult>((resolve) => {
      resolveOrdinary = resolve;
    });
    let historyRequest = 0;
    const request = vi.fn((method: string) => {
      if (method !== "chat.history") {
        return Promise.resolve(undefined);
      }
      historyRequest += 1;
      return historyRequest === 1
        ? Promise.resolve({ messages: [historical], sessionId: "session-history" })
        : ordinary;
    });
    const state = createHistoryState(request) as ChatPageHost;
    state.sessions = {
      reconcileChanged: vi.fn().mockReturnValue({ applied: false }),
      refresh: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatPageHost["sessions"];
    state.requestUpdate = vi.fn();
    state.chatMessages = [current];
    cacheChatSessionSnapshot(
      state.chatMessagesBySession ?? new Map(),
      state,
      { sessionKey: state.sessionKey },
      {
        messages: [current],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "session-current",
      },
    );

    await loadChatHistory(state, {
      startup: true,
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });
    expect(state.chatHistoryAnchorActive).toBe(true);
    expect(state.chatMessages).toEqual([historical]);
    expect(
      completeChatHistoryAnchorVisibility(state, {
        sessionId: "session-history",
        messageId: "historical-hit",
      })?.shouldRefresh,
    ).toBe(false);

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: "main",
        message: message("user", "new live prompt", "live-user", 10),
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "main",
        runId: "live-run",
        state: "delta",
        deltaText: "streaming",
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "main",
        agentId: "main",
        phase: "message",
      },
    });
    await Promise.resolve();

    expect(historyRequest).toBe(1);
    expect(state.chatHistoryAnchorActive).toBe(true);
    expect(state.chatMessages).toEqual([historical]);

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "main",
        runId: "live-run",
        state: "final",
        message: final,
      },
    });
    expect(state.chatMessages).toEqual([historical]);
    expect(state.chatStream).toBeNull();
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: "main",
      }),
    ).toEqual([current, final]);

    await vi.waitFor(() => expect(historyRequest).toBe(2));
    expect(state.chatHistoryAnchorActive).toBe(true);
    resolveOrdinary({ messages: [current, final], sessionId: "session-current" });
    await vi.waitFor(() => expect(state.chatHistoryAnchorActive).toBe(false));

    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.chatMessages).toEqual([current, final]);
  });
});
