import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatState } from "./chat-history.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

function message(role: "assistant" | "user", text: string, id: string, seq: number) {
  return {
    role,
    content: [{ type: "text", text }],
    __openclaw: { id, seq },
  };
}

function createHistoryState(): ChatState {
  return {
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
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

describe("historical transcript anchor steer retirement", () => {
  it("retires an acknowledged steer into the canonical tail while history stays anchored", () => {
    const current = message("user", "current tail", "current-tail", 9);
    const historical = message("user", "historical hit", "historical-hit", 1);
    const final = message("assistant", "new live reply", "live-final", 10);
    const state = createHistoryState();
    state.chatMessages = [historical];
    state.chatHistoryAnchorActive = true;
    state.chatHistoryAnchorPending = {
      sessionId: "session-history",
      messageId: "historical-hit",
      requestKey: "pending-anchor",
    };
    state.chatRunId = "live-run";
    state.chatQueue = [
      {
        id: "steer-chip",
        text: "Include the attached context",
        createdAt: 9.5,
        kind: "steered",
        pendingRunId: "live-run",
        sendRunId: "steer-send",
        sessionKey: state.sessionKey,
        attachments: [
          {
            id: "steer-attachment",
            mimeType: "image/png",
            fileName: "context.png",
            dataUrl: "data:image/png;base64,c3RlZXI=",
          },
        ],
      },
    ];
    cacheChatSessionSnapshot(state.chatMessagesBySession ?? new Map(), state, state, {
      messages: [current],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "session-current",
    });

    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "live-run",
      state: "final",
      message: final,
    });

    expect(state.chatQueue).toEqual([]);
    expect(state.chatMessages).toEqual([historical]);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, state),
    ).toEqual([
      current,
      expect.objectContaining({
        role: "user",
        content: [
          { type: "text", text: "Include the attached context" },
          { type: "text", text: "Attached image: context.png" },
        ],
        __openclaw: { idempotencyKey: "steer-send:user" },
      }),
      final,
    ]);
  });
});
