/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession, subscribeChatOutboxProjection } from "./chat-queue.ts";
import { moveQueuedChatMessage } from "./chat-send-actions.ts";
import {
  listStoredChatOutboxes,
  updateStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItems,
} from "./composer-persistence.ts";

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

  it("commits a multi-row reorder as one durable write instead of a partial permutation", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    const originalSetItem = sessionStorage.setItem.bind(sessionStorage);
    let writes = 0;
    // Permits exactly one write to land, then fails every write after it. A
    // per-row write loop would apply the first changed row and get stuck mid
    // permutation; a single batch write either lands the whole reorder or none of it.
    vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes > 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      originalSetItem(key, value);
    });

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(writes).toBe(1);
    expect(storedOrder(host)).toEqual(["queued-3", "queued-1", "queued-2"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    expect(host.lastError).toBeNull();
    unsubscribe();
  });

  it("leaves the durable and visible order unchanged when the batch write fails", () => {
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    moveQueuedChatMessage(host as never, "queued-3", 0);

    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);
    expect(host.chatQueue.map((item) => item.id)).toEqual(storedOrder(host));
    expect(host.lastError).not.toBeNull();
    unsubscribe();
  });

  it("rejects a two-row batch instead of committing a mixed permutation when one row went stale", () => {
    // `moveQueuedChatMessage` always re-reads storage immediately before it
    // writes, so it can never observe a mid-flight race by itself. This test
    // exercises the batch CAS primitive directly with a snapshot captured
    // before a concurrent write lands, which is what a real cross-tab race
    // looks like: the caller's `expected` rows were read before the other
    // writer's commit, then presented to the write after it.
    const { host, unsubscribe } = queueHost([{}, {}, {}]);
    unsubscribe();

    const storedById = (id: string) =>
      listStoredChatOutboxes(host as never)
        .flatMap(({ queue }) => queue)
        .find((entry) => entry.id === id)!;
    // Snapshot taken "before" the concurrent write, matching what a caller
    // would have read prior to another writer's commit.
    const expectedQueued2 = storedById("queued-2");
    const expectedQueued3 = storedById("queued-3");

    // A second tab/writer lands a durable change to queued-2 (a retry attempt
    // bump) after that snapshot was taken.
    const concurrentWrite = updateStoredChatComposerQueueItem(
      host as never,
      SESSION_KEY,
      expectedQueued2,
      {
        ...expectedQueued2,
        sendAttempts: (expectedQueued2.sendAttempts ?? 0) + 1,
      },
    );
    expect(concurrentWrite).toBe(true);

    // The reorder permutation this batch represents: an adjacent swap that
    // changes exactly queued-2 and queued-3's orderKey and leaves queued-1
    // untouched, mirroring what `moveQueuedChatMessage("queued-3", 1)` computes.
    const applied = updateStoredChatComposerQueueItems(host as never, SESSION_KEY, [
      {
        expected: expectedQueued3,
        next: { ...expectedQueued3, orderKey: expectedQueued2.createdAt },
      },
      {
        expected: expectedQueued2,
        next: { ...expectedQueued2, orderKey: expectedQueued3.createdAt },
      },
    ]);

    // queued-3's own compare-and-set would have succeeded alone; the batch must
    // still reject in full because its sibling row, queued-2, went stale using
    // the pre-concurrent-write snapshot. Any stored order other than the
    // untouched original (aside from the concurrent writer's own sendAttempts
    // bump) would mean the batch committed part of the permutation.
    expect(applied).toBe(false);
    expect(storedOrder(host)).toEqual(["queued-1", "queued-2", "queued-3"]);
    expect(storedById("queued-3").orderKey).toBe(expectedQueued3.orderKey);
    expect(storedById("queued-2").sendAttempts).toBe((expectedQueued2.sendAttempts ?? 0) + 1);
  });
});
