/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession, subscribeChatOutboxProjection } from "./chat-queue.ts";
import { moveQueuedChatMessage } from "./chat-send-actions.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

const SESSION_KEY = "agent:main";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function queueHost(items: readonly Partial<ChatQueueItem>[]) {
  const host = makeChatHost({ sessionKey: SESSION_KEY, connected: false });
  const unsubscribe = subscribeChatOutboxProjection(host as never);
  items.forEach((item, index) => {
    const admitted = admitQueuedMessageForSession(host as never, SESSION_KEY, {
      id: `queued-${index + 1}`,
      text: `message ${index + 1}`,
      createdAt: 1_000 + index,
      sendState: "waiting-reconnect",
      sessionKey: SESSION_KEY,
      ...item,
    });
    expect(admitted).toBe(true);
  });
  return { host, unsubscribe };
}

/** The drain reads the stored outbox, so this is the delivery order, not a view. */
function storedOrder(host: unknown): string[] {
  return listStoredChatOutboxes(host as never).flatMap(({ queue }) => queue.map((item) => item.id));
}

describe("queued message reorder", () => {
  it("moves a row to the head of both the visible queue and the stored outbox", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    expect(host.lastError).toBeNull();
    unsubscribe();
  });

  it("survives a reload, because the position is stored with the message", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    moveQueuedChatMessage(host as never, "queued-3", 0);
    unsubscribe();

    const reloaded = makeChatHost({ sessionKey: SESSION_KEY, connected: false });

    expect(storedOrder(reloaded)).toEqual(["queued-3", "queued-1", "queued-2"]);
  });

  it("leaves a row that already joined a run where it is", () => {
    const { host, unsubscribe } = queueHost([{ sendState: "unconfirmed" }, {}, {}]);

    moveQueuedChatMessage(host as never, "queued-1", 2);
    moveQueuedChatMessage(host as never, "queued-3", 0);

    // The unconfirmed row keeps the head; only the two movable rows swap.
    expect(storedOrder(host)).toEqual(["queued-1", "queued-3", "queued-2"]);
    unsubscribe();
  });

  it("moves a row that shares its arrival millisecond with the whole queue", () => {
    // Equal arrivals would otherwise share one position value and swallow the
    // move, leaving the drain on its old head while the list looked reordered.
    const { host, unsubscribe } = queueHost([
      { createdAt: 1_000 },
      { createdAt: 1_000 },
      { createdAt: 1_000 },
    ]);

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    unsubscribe();
  });

  it("refuses to deliver a row ahead of a locked row in the middle", () => {
    const { host, unsubscribe } = queueHost([{}, { sendState: "unconfirmed" }, {}, {}]);

    // The drain stops on the locked head, so reaching index 0 from behind it
    // would send a message the operator queued later than pending delivery.
    moveQueuedChatMessage(host as never, "queued-4", 0);

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-4", "queued-3"]);
    expect(host.lastError).toBeNull();
    unsubscribe();
  });
});
