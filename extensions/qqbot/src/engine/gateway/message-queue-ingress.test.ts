// QQBot queue ingress tests cover merged lifecycle fan-out and shutdown release.
import { describe, expect, it, vi } from "vitest";
import { buildQQBotMergedIngressLifecycle } from "./message-queue-ingress.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import type { QQBotIngressLifecycle } from "./types.js";

function groupMessage(messageId: string, lifecycle?: QQBotIngressLifecycle): QueuedMessage {
  return {
    type: "group",
    senderId: "member-1",
    content: messageId,
    messageId,
    timestamp: "2026-07-18T12:00:00Z",
    groupOpenid: "group-1",
    ...(lifecycle ? { turnAdoptionLifecycle: lifecycle } : {}),
  };
}

function testLifecycle() {
  const adopted = vi.fn(async () => {});
  const abandoned = vi.fn(async () => {});
  return {
    adopted,
    abandoned,
    lifecycle: {
      abortSignal: new AbortController().signal,
      onAdopted: adopted,
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: abandoned,
    } satisfies QQBotIngressLifecycle,
  };
}

describe("QQBot message queue ingress lifecycle", () => {
  it("fans merged-turn adoption out to every constituent claim", async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const first = testLifecycle();
    const second = testLifecycle();
    const handler = vi.fn(async (message: QueuedMessage) => {
      if (message.messageId === "blocker") {
        await blocker;
        return;
      }
      await message.turnAdoptionLifecycle?.onAdopted();
    });
    const queue = createMessageQueue({ accountId: "default", isAborted: () => false });
    queue.startProcessor(handler);
    queue.enqueue(groupMessage("blocker"));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    queue.enqueue(groupMessage("first", first.lifecycle));
    queue.enqueue(groupMessage("second", second.lifecycle));

    releaseBlocker();
    await vi.waitFor(() => {
      expect(first.adopted).toHaveBeenCalledTimes(1);
      expect(second.adopted).toHaveBeenCalledTimes(1);
    });
    await queue.stop();
  });

  it("settles every merged claim when one adoption callback fails", async () => {
    const adoptionError = new Error("first adoption failed");
    const first = testLifecycle();
    const second = testLifecycle();
    first.adopted.mockRejectedValueOnce(adoptionError);
    const lifecycle = buildQQBotMergedIngressLifecycle([
      groupMessage("first", first.lifecycle),
      groupMessage("second", second.lifecycle),
    ]);

    await expect(lifecycle?.onAdopted()).rejects.toBe(adoptionError);
    expect(first.adopted).toHaveBeenCalledTimes(1);
    expect(second.adopted).toHaveBeenCalledTimes(1);
  });

  it("settles every merged claim when one abandonment callback fails", async () => {
    const abandonmentError = new Error("first abandonment failed");
    const first = testLifecycle();
    const second = testLifecycle();
    first.abandoned.mockRejectedValueOnce(abandonmentError);
    const lifecycle = buildQQBotMergedIngressLifecycle([
      groupMessage("first", first.lifecycle),
      groupMessage("second", second.lifecycle),
    ]);

    await expect(lifecycle?.onAbandoned()).rejects.toBe(abandonmentError);
    expect(first.abandoned).toHaveBeenCalledTimes(1);
    expect(second.abandoned).toHaveBeenCalledTimes(1);
  });

  it("tombstones deferred permanent auth failures instead of releasing them", async () => {
    const tracked = testLifecycle();
    const queue = createMessageQueue({ accountId: "default", isAborted: () => false });
    queue.startProcessor(async () => {
      throw Object.assign(new Error("unauthorized"), { httpStatus: 401 });
    });
    queue.enqueue(groupMessage("auth-failure", tracked.lifecycle));

    await vi.waitFor(() => expect(tracked.adopted).toHaveBeenCalledTimes(1));
    expect(tracked.abandoned).not.toHaveBeenCalled();
    await queue.stop();
  });

  it("releases buffered claims as retryable when shutdown stops the queue", async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const queued = testLifecycle();
    const queue = createMessageQueue({ accountId: "default", isAborted: () => false });
    queue.startProcessor(async (message) => {
      if (message.messageId === "blocker") {
        await blocker;
      }
    });
    queue.enqueue(groupMessage("blocker"));
    queue.enqueue(groupMessage("queued", queued.lifecycle));

    const stopping = queue.stop();
    releaseBlocker();
    await stopping;
    expect(queued.abandoned).toHaveBeenCalledTimes(1);
    expect(queued.adopted).not.toHaveBeenCalled();
  });
});
