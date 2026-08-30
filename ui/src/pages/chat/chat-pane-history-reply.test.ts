/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";

describe("chat pane reply-source history navigation", () => {
  it("resolves an unloaded reply preview through chat.message.get", async () => {
    const message = {
      role: "assistant",
      content: "Original answer",
      __openclaw: { id: "source-message" },
    };
    const request = vi.fn().mockResolvedValue({ ok: true, message });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.assistantAgentId = "main";

    pane.requestReplyMessage("source-message");

    await vi.waitFor(() => expect(pane.readReplyMessage("source-message")).toBe(message));
    expect(request).toHaveBeenCalledWith("chat.message.get", {
      sessionKey: state.sessionKey,
      messageId: "source-message",
      maxChars: 500,
    });
  });

  it.each(["reconnect", "replacement client"] as const)(
    "retires a resolved reply preview after %s",
    async (transition) => {
      const oldMessage = { role: "assistant", content: "Previous connection's answer" };
      const newMessage = { role: "assistant", content: "Current connection's answer" };
      const request = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, message: oldMessage })
        .mockResolvedValueOnce({ ok: true, message: newMessage });
      const client = { request } as unknown as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });

      pane.requestReplyMessage("source-message");
      await vi.waitFor(() => expect(pane.readReplyMessage("source-message")).toBe(oldMessage));
      if (transition === "reconnect") {
        pane.connectionGeneration += 1;
        state.connectionEpoch = pane.connectionGeneration;
      } else {
        const replacement = { request } as unknown as GatewayBrowserClient;
        state.client = replacement;
        pane.connectedClient = replacement;
        pane.context.gateway.snapshot.client = replacement;
      }

      expect(pane.readReplyMessage("source-message")).toBeUndefined();
      pane.requestReplyMessage("source-message");
      await vi.waitFor(() => expect(pane.readReplyMessage("source-message")).toBe(newMessage));
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["success", "failure"] as const)(
    "ignores an obsolete reply lookup %s while a reconnected lookup is pending",
    async (outcome) => {
      const stale = createDeferred<{ ok: true; message: unknown }>();
      const fresh = createDeferred<{ ok: true; message: unknown }>();
      const currentMessage = { role: "assistant", content: "Current answer" };
      const request = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });

      pane.requestReplyMessage("source-message");
      pane.connectionGeneration += 1;
      state.connectionEpoch = pane.connectionGeneration;
      pane.requestReplyMessage("source-message");
      expect(request).toHaveBeenCalledTimes(2);
      if (outcome === "success") {
        stale.resolve({ ok: true, message: { role: "assistant", content: "Obsolete answer" } });
      } else {
        stale.reject(new Error("Previous connection unavailable"));
      }
      await stale.promise.catch(() => {});
      expect(pane.readReplyMessage("source-message")).toBeUndefined();
      fresh.resolve({ ok: true, message: currentMessage });
      await vi.waitFor(() => expect(pane.readReplyMessage("source-message")).toBe(currentMessage));
      pane.requestReplyMessage("source-message");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("retries a previously unavailable reply source after reconnect", async () => {
    const message = { role: "assistant", content: "Source is available again" };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, unavailableReason: "not_found" })
      .mockResolvedValueOnce({ ok: true, message });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });

    pane.requestReplyMessage("source-message");
    await Promise.resolve();
    pane.requestReplyMessage("source-message");
    expect(request).toHaveBeenCalledOnce();
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    pane.requestReplyMessage("source-message");

    await vi.waitFor(() => expect(pane.readReplyMessage("source-message")).toBe(message));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("pages backward until a clicked reply target is loaded, then reveals it", async () => {
    const target = {
      ...nativeHistoryMessage(1, "Original answer"),
      __openclaw: { id: "source-message", seq: 1 },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
        hasMore: true,
        nextOffset: 4,
        totalMessages: 6,
      })
      .mockResolvedValueOnce({
        messages: [target, nativeHistoryMessage(2)],
        hasMore: false,
        totalMessages: 6,
      });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(5), nativeHistoryMessage(6)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 6 };
    vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
    const revealMessage = vi.spyOn(pane.transcript, "revealMessage").mockReturnValue(true);

    pane.openReplyMessage("source-message");

    expect(pane.currentReplyNavigationId(state.sessionKey)).toBe("source-message");
    await vi.waitFor(() => expect(revealMessage).toHaveBeenCalledWith("source-message"));
    expect(request).toHaveBeenNthCalledWith(1, "chat.history", {
      sessionKey: state.sessionKey,
      limit: 400,
      offset: 2,
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: state.sessionKey,
      limit: 400,
      offset: 4,
    });
    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  });

  it("abandons reply navigation when the pane switches sessions", async () => {
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
    const revealMessage = vi.spyOn(pane.transcript, "revealMessage");

    pane.openReplyMessage("source-message");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    state.sessionKey = "agent:main:other";
    pane.resetOlderMessagesViewport();
    deferred.resolve({ messages: [], hasMore: false, totalMessages: 4 });
    await deferred.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
    expect(revealMessage).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("reports an unavailable reply after history is exhausted", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [nativeHistoryMessage(1), nativeHistoryMessage(2)],
      hasMore: false,
      totalMessages: 4,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatMessages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };

    pane.openReplyMessage("missing-message");

    await vi.waitFor(() => expect(state.lastError).toBe("The original message is unavailable."));
    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  });
});
