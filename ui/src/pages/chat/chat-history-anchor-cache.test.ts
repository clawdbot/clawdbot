// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadChatHistory, type ChatState } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

describe("chat history anchor cache", () => {
  it("loads an exact anchor without replacing the current-tail send identity", async () => {
    const currentTail = {
      role: "assistant",
      content: [{ type: "text", text: "current tail" }],
      __openclaw: { id: "current-tail", seq: 9 },
    };
    const historical = {
      role: "user",
      content: [{ type: "text", text: "historical match" }],
      __openclaw: { id: "historical-hit", seq: 1 },
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [historical],
          sessionId: "session-history",
          sessionInfo: { key: "main", kind: "direct", updatedAt: 1 },
        },
      },
      sessionKey: "main",
    });
    const state = host as ChatState & { request: typeof host.request };
    state.connectionEpoch = 1;
    state.chatMessagesBySession = new Map();
    state.chatMessages = [currentTail];
    state.currentSessionId = "session-current";
    cacheChatSessionSnapshot(
      state.chatMessagesBySession,
      state,
      { sessionKey: state.sessionKey },
      {
        messages: [currentTail],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "session-current",
      },
    );

    await loadChatHistory(state, {
      startup: true,
      historyAnchor: { sessionId: "session-history", messageId: "historical-hit" },
    });

    expect(state.request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      sessionId: "session-history",
      messageId: "historical-hit",
      limit: expect.any(Number),
    });
    expect(state.chatMessages).toEqual([historical]);
    expect(state.currentSessionId).toBe("session-current");
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession, state, { sessionKey: "main" }),
    ).toEqual([currentTail]);

    state.request.mockResolvedValueOnce({ status: "started", runId: "send-run" });
    await requestChatSend(state, { message: "continue", runId: "send-run" });

    expect(state.request).toHaveBeenLastCalledWith(
      "chat.send",
      expect.objectContaining({ sessionId: "session-current" }),
    );
  });
});
