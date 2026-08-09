/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-history-anchor.test/"} */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { deferPendingChatHistoryAnchorTerminalRefresh } from "./chat-history.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";

describe("chat pane history anchor", () => {
  it("cancels pending tail scroll work before consuming a history anchor", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "historical match" }],
          __openclaw: { id: "historical-hit", seq: 1 },
        },
      ],
      sessionId: "session-history",
      sessionInfo: { key: "agent:main:current", kind: "direct", updatedAt: 1 },
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
      transcript: { scrollToMessage: (messageId: string) => Promise<boolean> };
    };
    const order: string[] = [];
    const cancelCommit = vi.fn(() => order.push("cancel"));
    const scrollToMessage = vi
      .spyOn(anchorPane.transcript, "scrollToMessage")
      .mockImplementation(async () => {
        order.push("anchor");
        return true;
      });
    anchorPane.active = true;
    anchorPane.historyAnchor = {
      sessionId: "session-history",
      messageId: "historical-hit",
    };
    anchorPane.onHistoryAnchorConsumed = vi.fn(() => order.push("consume"));
    Object.defineProperty(anchorPane, "updateComplete", {
      configurable: true,
      value: Promise.resolve(true),
    });
    state.chatScrollCommitCleanup = cancelCommit;

    anchorPane.loadHistoryAnchorIfNeeded();

    await vi.waitFor(() => expect(anchorPane.onHistoryAnchorConsumed).toHaveBeenCalledOnce());
    expect(cancelCommit).toHaveBeenCalledOnce();
    expect(scrollToMessage).toHaveBeenCalledWith("historical-hit");
    expect(order).toEqual(["cancel", "anchor", "consume"]);
  });

  it("keeps historical messages visible until centering before a deferred refresh", async () => {
    const historicalResponse = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "historical match" }],
          __openclaw: { id: "historical-hit", seq: 1 },
        },
      ],
      sessionId: "session-history",
      sessionInfo: { key: "agent:main:current", kind: "direct", updatedAt: 1 },
    };
    const currentResponse = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "current visible message" }],
          __openclaw: { id: "current-message", seq: 2 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "new live reply" }],
          __openclaw: { id: "live-final", seq: 3 },
        },
      ],
      sessionId: "session-current",
      sessionInfo: { key: "agent:main:current", kind: "direct", updatedAt: 2 },
    };
    let resolveAnchor: (value: typeof historicalResponse) => void = () => undefined;
    const anchorResponse = new Promise<typeof historicalResponse>((resolve) => {
      resolveAnchor = resolve;
    });
    const order: string[] = [];
    const request = vi.fn((_method: string, params?: Record<string, unknown>) => {
      if (params?.sessionId === "session-history") {
        return anchorResponse;
      }
      order.push("request-current");
      return Promise.resolve(currentResponse);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
      transcript: { scrollToMessage: (messageId: string) => Promise<boolean> };
    };
    anchorPane.active = true;
    anchorPane.historyAnchor = {
      sessionId: "session-history",
      messageId: "historical-hit",
    };
    anchorPane.onHistoryAnchorConsumed = vi.fn(() => {
      order.push("consume");
      anchorPane.historyAnchor = undefined;
    });
    vi.spyOn(anchorPane.transcript, "scrollToMessage").mockImplementation(async () => {
      expect(state.chatMessages).toEqual(historicalResponse.messages);
      order.push("center");
      return true;
    });
    Object.defineProperty(anchorPane, "updateComplete", {
      configurable: true,
      value: Promise.resolve(true),
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    await vi.waitFor(() => expect(state.chatHistoryAnchorPending).not.toBeNull());
    expect(deferPendingChatHistoryAnchorTerminalRefresh(state)).toBe(true);

    resolveAnchor(historicalResponse);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.chatMessages).toEqual(currentResponse.messages));

    expect(order).toEqual(["center", "consume", "request-current"]);
    expect(state.chatHistoryAnchorPending).toBeNull();
    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("restores current history and reports an unavailable anchor", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [],
        sessionId: "session-history",
        sessionInfo: { key: "agent:main:current", kind: "direct", updatedAt: 1 },
      })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "current visible message" }],
            __openclaw: { id: "current-message", seq: 2 },
          },
        ],
        sessionId: "session-current",
        sessionInfo: { key: "agent:main:current", kind: "direct", updatedAt: 2 },
      });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
      transcript: { scrollToMessage: (messageId: string) => Promise<boolean> };
    };
    anchorPane.active = true;
    anchorPane.historyAnchor = {
      sessionId: "session-history",
      messageId: "missing-message",
    };
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    anchorPane.onHistoryAnchorConsumed = vi.fn(() => {
      anchorPane.historyAnchor = undefined;
    });
    vi.spyOn(anchorPane.transcript, "scrollToMessage").mockResolvedValue(false);
    Object.defineProperty(anchorPane, "updateComplete", {
      configurable: true,
      value: Promise.resolve(true),
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    expect(deferPendingChatHistoryAnchorTerminalRefresh(state)).toBe(true);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(state.lastError).toBe(
        "The selected transcript message is no longer available. Showing the current thread.",
      ),
    );
    expect(anchorPane.onHistoryAnchorConsumed).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      sessionId: "session-history",
      messageId: "missing-message",
    });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("sessionId");
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("messageId");
    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.chatMessages).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "current visible message" }],
      }),
    ]);
    expect(state.chatError).toBe(state.lastError);
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toBe(state.lastError);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    toastHost.remove();
  });
});
