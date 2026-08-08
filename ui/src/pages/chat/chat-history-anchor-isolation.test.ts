import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadChatHistory, type ChatHistoryResult, type ChatState } from "./chat-history.ts";
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
