// Whatsapp plugin module test: debounce merge window and flush ordering.
import { describe, expect, it } from "vitest";
import {
  createWhatsAppInboundMessageDebouncer,
  type WhatsAppQueuedInboundMessage,
} from "./message-debounce.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

function queuedMessage(overrides: {
  id: string;
  body: string;
  timestamp?: number;
  receiveOrder?: number;
}): WhatsAppQueuedInboundMessage {
  const base = createTestWebInboundMessage({
    event: { id: overrides.id, timestamp: overrides.timestamp },
    payload: { body: overrides.body },
  });
  return { ...base, receiveOrder: overrides.receiveOrder };
}

describe("createWhatsAppInboundMessageDebouncer", () => {
  it("merges two same-lane messages that arrive inside one debounce window into a single flush", async () => {
    const flushed: WhatsAppQueuedInboundMessage[] = [];
    const debouncer = createWhatsAppInboundMessageDebouncer({
      debounceMs: 50,
      onMessage: async (msg) => {
        flushed.push(msg as WhatsAppQueuedInboundMessage);
      },
      markRead: async () => {},
      onPendingWorkChanged: () => {},
      onError: (err) => {
        throw err;
      },
    });

    // Both messages arrive back-to-back, well inside the 50ms debounce window.
    await debouncer.enqueue(
      queuedMessage({ id: "msg-1", body: "hello", timestamp: 100, receiveOrder: 0 }),
    );
    await debouncer.enqueue(
      queuedMessage({ id: "msg-2", body: "world", timestamp: 100, receiveOrder: 1 }),
    );
    await debouncer.drain();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.payload.body).toBe("hello\nworld");
    expect(flushed[0]?.event.isBatched).toBe(true);
  });

  it("orders a merged flush by timestamp first, then receiveOrder as the tiebreaker", async () => {
    const flushed: WhatsAppQueuedInboundMessage[] = [];
    const debouncer = createWhatsAppInboundMessageDebouncer({
      debounceMs: 50,
      onMessage: async (msg) => {
        flushed.push(msg as WhatsAppQueuedInboundMessage);
      },
      markRead: async () => {},
      onPendingWorkChanged: () => {},
      onError: (err) => {
        throw err;
      },
    });

    // Arrival order is reversed relative to timestamp order; the flush must
    // still combine bodies in timestamp order, not arrival order.
    await debouncer.enqueue(
      queuedMessage({ id: "msg-later", body: "second", timestamp: 200, receiveOrder: 5 }),
    );
    await debouncer.enqueue(
      queuedMessage({ id: "msg-earlier", body: "first", timestamp: 100, receiveOrder: 4 }),
    );
    // Same timestamp as msg-earlier; receiveOrder breaks the tie.
    await debouncer.enqueue(
      queuedMessage({ id: "msg-tiebreak", body: "middle", timestamp: 100, receiveOrder: 6 }),
    );
    await debouncer.drain();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.payload.body).toBe("first\nmiddle\nsecond");
  });
});
