// Whatsapp inbound debounce tests cover per-message window selection.
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppInboundMessageDebouncer } from "./message-debounce.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

describe("createWhatsAppInboundMessageDebouncer", () => {
  it("flushes a zero-window conversation immediately without pending timer work", async () => {
    const onMessage = vi.fn(async () => {});
    const onPendingWorkChanged = vi.fn();
    const resolveDebounceMs = vi.fn(() => 0);
    const debouncer = createWhatsAppInboundMessageDebouncer({
      debounceMs: 1000,
      resolveDebounceMs,
      onMessage,
      markRead: async () => {},
      onPendingWorkChanged,
      onError: (error) => {
        throw error;
      },
    });

    await debouncer.enqueue(createTestWebInboundMessage());

    expect(onMessage).toHaveBeenCalledOnce();
    expect(debouncer.hasPendingWork()).toBe(false);
    expect(debouncer.pendingWorkCount()).toBe(0);
    expect(onPendingWorkChanged).toHaveBeenCalledTimes(2);
    expect(resolveDebounceMs).toHaveBeenCalledOnce();

    await debouncer.drain();
  });

  it("serializes zero-window messages for the same conversation", async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const debouncer = createWhatsAppInboundMessageDebouncer({
      debounceMs: 1000,
      resolveDebounceMs: () => 0,
      onMessage: async (msg) => {
        started.push(msg.event.id);
        if (msg.event.id === "msg-1") {
          await firstGate;
        }
      },
      markRead: async () => {},
      onPendingWorkChanged: () => {},
      onError: (error) => {
        throw error;
      },
    });

    const first = debouncer.enqueue(createTestWebInboundMessage({ event: { id: "msg-1" } }));
    await Promise.resolve();
    const second = debouncer.enqueue(createTestWebInboundMessage({ event: { id: "msg-2" } }));
    await Promise.resolve();

    expect(started).toEqual(["msg-1"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["msg-1", "msg-2"]);

    await debouncer.drain();
  });

  it("uses a positive per-message window instead of the channel default", async () => {
    vi.useFakeTimers();
    try {
      const onMessage = vi.fn(async () => {});
      const debouncer = createWhatsAppInboundMessageDebouncer({
        debounceMs: 10_000,
        resolveDebounceMs: () => 100,
        onMessage,
        markRead: async () => {},
        onPendingWorkChanged: () => {},
        onError: (error) => {
          throw error;
        },
      });

      await debouncer.enqueue(createTestWebInboundMessage());
      expect(onMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(99);
      expect(onMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await debouncer.drain();
      expect(onMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
