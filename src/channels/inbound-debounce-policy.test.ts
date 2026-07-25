// Inbound debounce policy tests cover channel message coalescing and delay decisions.
import { describe, expect, it, vi } from "vitest";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "./inbound-debounce-policy.js";

describe("shouldDebounceTextInbound", () => {
  it("rejects blank text, media, and control commands", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];

    expect(shouldDebounceTextInbound({ text: "   ", cfg })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "hello", cfg, hasMedia: true })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "/status", cfg })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "/status plugins", cfg })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "stop", cfg })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "abort", cfg })).toBe(false);
  });

  it("accepts normal text when debounce is allowed", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];
    expect(shouldDebounceTextInbound({ text: "hello there", cfg })).toBe(true);
    expect(shouldDebounceTextInbound({ text: "wait", cfg })).toBe(true);
    expect(shouldDebounceTextInbound({ text: "hello there", cfg, allowDebounce: false })).toBe(
      false,
    );
  });
});

describe("createChannelInboundDebouncer", () => {
  it("resolves per-channel debounce and forwards callbacks", async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const cfg = {
        messages: {
          inbound: {
            debounceMs: 10,
            byChannel: {
              "demo-channel": 25,
            },
          },
        },
      } as Parameters<typeof createChannelInboundDebouncer<{ id: string }>>[0]["cfg"];

      const { debounceMs, debouncer } = createChannelInboundDebouncer<{ id: string }>({
        cfg,
        channel: "demo-channel",
        buildKey: (item) => item.id,
        onFlush: async (items) => {
          flushed.push(items.map((entry) => entry.id));
        },
      });

      expect(debounceMs).toBe(25);

      await debouncer.enqueue({ id: "a" });
      await debouncer.enqueue({ id: "a" });
      await vi.advanceTimersByTimeAsync(30);

      expect(flushed).toEqual([["a", "a"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
