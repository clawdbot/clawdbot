// Whatsapp inbound debounce tests cover per-message window selection.
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppInboundMessageDebouncer } from "./message-debounce.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

describe("createWhatsAppInboundMessageDebouncer", () => {
  it("flushes a zero-window conversation immediately without pending timer work", async () => {
    const onMessage = vi.fn(async () => {});
    const onPendingWorkChanged = vi.fn();
    const debouncer = createWhatsAppInboundMessageDebouncer({
      debounceMs: 1000,
      resolveDebounceMs: () => 0,
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
