// Inbound debounce policy tests cover channel message coalescing and delay decisions.
import { describe, expect, it, vi } from "vitest";
import { resolveInboundDebounceMs } from "../auto-reply/inbound-debounce.js";
import type { OpenClawConfig } from "../config/types.js";
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
  it.each([false, true])(
    "preserves snapshot timing unless an explicit reader is supplied (live: %s)",
    async (live) => {
      vi.useFakeTimers();
      try {
        const flushed: string[][] = [];
        let cfg: OpenClawConfig = {
          messages: {
            inbound: {
              debounceMs: 10,
              byChannel: {
                "demo-channel": 25,
              },
            },
          },
        };

        const { debounceMs, debouncer } = createChannelInboundDebouncer<{ id: string }>({
          cfg,
          channel: "demo-channel",
          buildKey: (item) => item.id,
          ...(live
            ? {
                resolveDebounceMs: () => resolveInboundDebounceMs({ cfg, channel: "demo-channel" }),
              }
            : {}),
          onFlush: (items) => {
            flushed.push(items.map((entry) => entry.id));
            const completion = Promise.resolve();
            return { admission: completion, completion };
          },
        });

        expect(debounceMs).toBe(25);

        await debouncer.enqueue({ id: "a" });
        await debouncer.enqueue({ id: "a" });
        await vi.advanceTimersByTimeAsync(30);

        expect(flushed).toEqual([["a", "a"]]);
        cfg = { messages: { inbound: { debounceMs: 0 } } };
        await debouncer.enqueue({ id: "b" });
        expect(debounceMs).toBe(25);
        expect(flushed).toEqual(live ? [["a", "a"], ["b"]] : [["a", "a"]]);
        await vi.advanceTimersByTimeAsync(25);
        expect(flushed).toEqual([["a", "a"], ["b"]]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
