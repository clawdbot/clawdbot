import { describe, expect, it, vi } from "vitest";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";

function makeMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "c2c",
    senderId: "user-1",
    content: "hello",
    messageId: "msg-1",
    timestamp: "2026-04-25T00:00:00.000Z",
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("engine/gateway/message-queue", () => {
  it("derives peer ids by message surface", () => {
    const q = createMessageQueue({ accountId: "qq", isAborted: () => false });

    expect(q.getMessagePeerId(makeMessage({ type: "c2c", senderId: "alice" }))).toBe("dm:alice");
    expect(q.getMessagePeerId(makeMessage({ type: "dm", senderId: "alice" }))).toBe("dm:alice");
    expect(q.getMessagePeerId(makeMessage({ type: "guild", channelId: "chan" }))).toBe(
      "guild:chan",
    );
    expect(q.getMessagePeerId(makeMessage({ type: "group", groupOpenid: "group" }))).toBe(
      "group:group",
    );
  });

  it("serializes messages for the same peer and reports cleared pending messages", async () => {
    const first = deferred();
    const handled: string[] = [];
    const q = createMessageQueue({ accountId: "qq", isAborted: () => false });
    q.startProcessor(
      vi.fn(async (msg) => {
        handled.push(msg.messageId);
        if (msg.messageId === "msg-1") {
          await first.promise;
        }
      }),
    );

    q.enqueue(makeMessage({ messageId: "msg-1" }));
    q.enqueue(makeMessage({ messageId: "msg-2" }));
    q.enqueue(makeMessage({ messageId: "msg-3" }));

    expect(q.getSnapshot("dm:user-1")).toMatchObject({
      totalPending: 2,
      activeUsers: 1,
      senderPending: 2,
    });
    expect(q.clearUserQueue("dm:user-1")).toBe(2);
    expect(q.getSnapshot("dm:user-1")).toMatchObject({
      totalPending: 0,
      activeUsers: 1,
      senderPending: 0,
    });

    first.resolve();
    await Promise.resolve();
    expect(handled).toEqual(["msg-1"]);
  });

  it("logs processor errors and continues draining the peer queue", async () => {
    const log = { error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const handled: string[] = [];
    const q = createMessageQueue({ accountId: "qq", log, isAborted: () => false });
    q.startProcessor(
      vi.fn(async (msg) => {
        handled.push(msg.messageId);
        if (msg.messageId === "bad") {
          throw new Error("boom");
        }
      }),
    );

    q.enqueue(makeMessage({ messageId: "bad" }));
    q.enqueue(makeMessage({ messageId: "next" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(handled).toEqual(["bad", "next"]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Message processor error"));
  });
});
