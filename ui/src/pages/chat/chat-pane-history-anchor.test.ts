/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-history-anchor.test/"} */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { cancelPendingChatHistoryAnchor, loadChatHistory } from "./chat-history.ts";
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
    void loadChatHistory(state);
    expect(state.chatHistoryAnchorPending?.deferredRefresh).toBeDefined();

    resolveAnchor(historicalResponse);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state.chatMessages).toEqual(currentResponse.messages));

    expect(order).toEqual(["center", "consume", "request-current"]);
    expect(state.chatHistoryAnchorPending).toBeNull();
    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("does not retry a failed anchor while canonical recovery is pending", async () => {
    const currentResponse = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "current tail" }] }],
      sessionId: "session-current",
    };
    let resolveCurrent: (value: typeof currentResponse) => void = () => undefined;
    const current = new Promise<typeof currentResponse>((resolve) => {
      resolveCurrent = resolve;
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("anchor unavailable"))
      .mockReturnValueOnce(current);
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
    };
    anchorPane.active = true;
    anchorPane.historyAnchor = { sessionId: "session-history", messageId: "historical-hit" };
    anchorPane.onHistoryAnchorConsumed = vi.fn(() => {
      anchorPane.historyAnchor = undefined;
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    const deferredRefresh = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    anchorPane.loadHistoryAnchorIfNeeded();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(anchorPane.onHistoryAnchorConsumed).not.toHaveBeenCalled();

    resolveCurrent(currentResponse);
    await expect(deferredRefresh).resolves.toMatchObject({ sessionId: "session-current" });
    await vi.waitFor(() => expect(anchorPane.onHistoryAnchorConsumed).toHaveBeenCalledOnce());
    anchorPane.loadHistoryAnchorIfNeeded();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatHistoryAnchorFailedRequestKey).toBeUndefined();
    expect(state.chatMessages).toEqual(currentResponse.messages);
  });

  it("recovers current history when the initial anchor request fails", async () => {
    const currentResponse = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "current tail" }] }],
      sessionId: "session-current",
    };
    let resolveCurrent: (value: typeof currentResponse) => void = () => undefined;
    const current = new Promise<typeof currentResponse>((resolve) => {
      resolveCurrent = resolve;
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("anchor unavailable"))
      .mockReturnValueOnce(current);
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
    };
    anchorPane.active = true;
    anchorPane.historyAnchor = { sessionId: "session-history", messageId: "historical-hit" };
    anchorPane.onHistoryAnchorConsumed = vi.fn(() => {
      anchorPane.historyAnchor = undefined;
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    anchorPane.loadHistoryAnchorIfNeeded();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(anchorPane.onHistoryAnchorConsumed).not.toHaveBeenCalled();

    resolveCurrent(currentResponse);
    await vi.waitFor(() => expect(anchorPane.onHistoryAnchorConsumed).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatHistoryAnchorPending).toBeNull();
    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.chatMessages).toEqual(currentResponse.messages);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("restores current history and reports an unavailable anchor", async () => {
    const currentResponse = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "current visible message" }],
          __openclaw: { id: "current-message", seq: 2 },
        },
      ],
      sessionId: "session-current",
      sessionInfo: { key: "agent:main:current", kind: "direct", updatedAt: 2 },
    };
    let resolveCurrent: (value: typeof currentResponse) => void = () => undefined;
    const current = new Promise<typeof currentResponse>((resolve) => {
      resolveCurrent = resolve;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [],
        sessionId: "session-history",
        sessionInfo: { key: "agent:main:current", kind: "direct", updatedAt: 1 },
      })
      .mockReturnValueOnce(current);
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
      // The production route callback requests a render, which clears the
      // pane request key before the canonical fallback response arrives.
      anchorPane.loadHistoryAnchorIfNeeded();
    });
    vi.spyOn(anchorPane.transcript, "scrollToMessage").mockResolvedValue(false);
    Object.defineProperty(anchorPane, "updateComplete", {
      configurable: true,
      value: Promise.resolve(true),
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    const deferredRefresh = loadChatHistory(state);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(state.lastError).toBeNull();
    resolveCurrent(currentResponse);
    await vi.waitFor(() =>
      expect(state.lastError).toBe("That message is unavailable. Showing the current thread."),
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
    await expect(deferredRefresh).resolves.toMatchObject({ sessionId: "session-current" });
    toastHost.remove();
  });

  it("abandons an applied anchor when a destructive refresh takes ownership", async () => {
    const historicalResponse = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "historical target" }],
          __openclaw: { id: "historical-hit", seq: 1 },
        },
      ],
      sessionId: "session-history",
    };
    const currentResponse = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "current tail" }] }],
      sessionId: "session-current",
    };
    const request = vi.fn((_method: string, params?: Record<string, unknown>) =>
      Promise.resolve(params?.sessionId ? historicalResponse : currentResponse),
    );
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
      transcript: { scrollToMessage: (messageId: string) => Promise<boolean> };
    };
    let releaseUpdate: () => void = () => undefined;
    const heldUpdate = new Promise<boolean>((resolve) => {
      releaseUpdate = () => resolve(true);
    });
    anchorPane.active = true;
    anchorPane.historyAnchor = { sessionId: "session-history", messageId: "historical-hit" };
    anchorPane.onHistoryAnchorConsumed = vi.fn();
    const scrollToMessage = vi
      .spyOn(anchorPane.transcript, "scrollToMessage")
      .mockResolvedValue(true);
    Object.defineProperty(anchorPane, "updateComplete", {
      configurable: true,
      value: heldUpdate,
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    await vi.waitFor(() => expect(state.chatHistoryAnchorActive).toBe(true));
    cancelPendingChatHistoryAnchor(state);
    const destructiveRefresh = loadChatHistory(state);
    releaseUpdate();
    await expect(destructiveRefresh).resolves.toMatchObject({ sessionId: "session-current" });
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    expect(scrollToMessage).not.toHaveBeenCalled();
    expect(anchorPane.onHistoryAnchorConsumed).not.toHaveBeenCalled();
    expect(state.chatMessages).toEqual(currentResponse.messages);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("settles a parked refresh when the pane disconnects", async () => {
    const historicalResponse = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "historical target" }],
          __openclaw: { id: "historical-hit", seq: 1 },
        },
      ],
      sessionId: "session-history",
    };
    let resolveAnchor: (value: typeof historicalResponse) => void = () => undefined;
    const anchorResponse = new Promise<typeof historicalResponse>((resolve) => {
      resolveAnchor = resolve;
    });
    const request = vi.fn().mockReturnValue(anchorResponse);
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
      transcript: { scrollToMessage: (messageId: string) => Promise<boolean> };
    };
    anchorPane.active = true;
    anchorPane.historyAnchor = { sessionId: "session-history", messageId: "historical-hit" };
    anchorPane.onHistoryAnchorConsumed = vi.fn();
    const scrollToMessage = vi
      .spyOn(anchorPane.transcript, "scrollToMessage")
      .mockResolvedValue(true);

    anchorPane.loadHistoryAnchorIfNeeded();
    await vi.waitFor(() => expect(state.chatHistoryAnchorPending).not.toBeNull());
    const deferredRefresh = loadChatHistory(state);
    anchorPane.disconnectedCallback();

    await expect(deferredRefresh).resolves.toBeUndefined();
    resolveAnchor(historicalResponse);
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledOnce();
    expect(scrollToMessage).not.toHaveBeenCalled();
    expect(anchorPane.onHistoryAnchorConsumed).not.toHaveBeenCalled();
    expect(state.chatHistoryAnchorPending).toBeNull();
    expect(state.chatHistoryAnchorActive).toBe(false);
    expect(state.chatMessages).toEqual([]);
  });

  it("does not publish an old unavailable result after a second anchor takes ownership", async () => {
    const currentResponse = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "current tail" }] }],
      sessionId: "session-current",
    };
    let resolveCurrent: (value: typeof currentResponse) => void = () => undefined;
    const current = new Promise<typeof currentResponse>((resolve) => {
      resolveCurrent = resolve;
    });
    const request = vi.fn((_method: string, params?: Record<string, unknown>) => {
      if (params?.sessionId === "session-first") {
        return Promise.resolve({ messages: [], sessionId: "session-first" });
      }
      if (params?.sessionId === "session-second") {
        return Promise.resolve({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "second historical target" }],
              __openclaw: { id: "second-hit", seq: 2 },
            },
          ],
          sessionId: "session-second",
        });
      }
      return current;
    });
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
      transcript: { scrollToMessage: (messageId: string) => Promise<boolean> };
    };
    anchorPane.active = true;
    anchorPane.historyAnchor = { sessionId: "session-first", messageId: "first-missing" };
    anchorPane.onHistoryAnchorConsumed = vi.fn(() => {
      if (anchorPane.historyAnchor?.sessionId === "session-first") {
        anchorPane.historyAnchor = { sessionId: "session-second", messageId: "second-hit" };
        anchorPane.loadHistoryAnchorIfNeeded();
        return;
      }
      anchorPane.historyAnchor = undefined;
    });
    vi.spyOn(anchorPane.transcript, "scrollToMessage").mockImplementation(
      async (messageId) => messageId === "second-hit",
    );
    Object.defineProperty(anchorPane, "updateComplete", {
      configurable: true,
      value: Promise.resolve(true),
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    resolveCurrent(currentResponse);
    await vi.waitFor(() => expect(state.chatMessages).toEqual(currentResponse.messages));

    expect(anchorPane.onHistoryAnchorConsumed).toHaveBeenCalledTimes(2);
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("retries an anchor after the pane reactivates during update completion", async () => {
    const historicalResponse = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "historical target" }],
          __openclaw: { id: "historical-hit", seq: 1 },
        },
      ],
      sessionId: "session-history",
    };
    const currentResponse = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "current tail" }] }],
      sessionId: "session-current",
    };
    const request = vi.fn((_method: string, params?: Record<string, unknown>) =>
      Promise.resolve(params?.sessionId ? historicalResponse : currentResponse),
    );
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { setModelOverride: vi.fn() } as unknown as SessionCapability,
    });
    const anchorPane = pane as TestChatPane & {
      historyAnchor?: { messageId: string; sessionId: string };
      loadHistoryAnchorIfNeeded: () => void;
      onHistoryAnchorConsumed: () => void;
      transcript: { scrollToMessage: (messageId: string) => Promise<boolean> };
    };
    let releaseUpdate: () => void = () => undefined;
    const heldUpdate = new Promise<boolean>((resolve) => {
      releaseUpdate = () => resolve(true);
    });
    anchorPane.active = true;
    anchorPane.historyAnchor = { sessionId: "session-history", messageId: "historical-hit" };
    anchorPane.onHistoryAnchorConsumed = vi.fn(() => {
      anchorPane.historyAnchor = undefined;
    });
    vi.spyOn(anchorPane.transcript, "scrollToMessage").mockResolvedValue(true);
    Object.defineProperty(anchorPane, "updateComplete", {
      configurable: true,
      value: heldUpdate,
    });

    anchorPane.loadHistoryAnchorIfNeeded();
    await vi.waitFor(() => expect(state.chatHistoryAnchorActive).toBe(true));
    const deferredRefresh = loadChatHistory(state);
    anchorPane.active = false;
    releaseUpdate();
    await Promise.resolve();
    await Promise.resolve();

    anchorPane.active = true;
    anchorPane.loadHistoryAnchorIfNeeded();
    await expect(deferredRefresh).resolves.toMatchObject({ sessionId: "session-current" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(anchorPane.onHistoryAnchorConsumed).toHaveBeenCalledOnce();
    expect(state.chatMessages).toEqual(currentResponse.messages);
  });
});
