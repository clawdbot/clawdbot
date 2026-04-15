import { describe, expect, it, vi } from "vitest";
import { createSelfChatCache } from "./self-chat-cache.js";

describe("createSelfChatCache", () => {
  const directLookup = {
    accountId: "default",
    sender: "+15555550123",
    isGroup: false,
  } as const;

  it("matches repeated lookups for the same scope, timestamp, and text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    cache.remember({
      ...directLookup,
      text: "  hello\r\nworld  ",
      createdAt: 123,
    });

    expect(
      cache.has({
        ...directLookup,
        text: "hello\nworld",
        createdAt: 123,
      }),
    ).toBe(true);
  });

  it("expires entries after the ttl window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    cache.remember({ ...directLookup, text: "hello", createdAt: 123 });

    vi.advanceTimersByTime(11_001);

    expect(cache.has({ ...directLookup, text: "hello", createdAt: 123 })).toBe(false);
  });

  it("evicts older entries when the cache exceeds its cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    for (let i = 0; i < 513; i += 1) {
      cache.remember({
        ...directLookup,
        text: `message-${i}`,
        createdAt: i,
      });
      vi.advanceTimersByTime(1_001);
    }

    expect(cache.has({ ...directLookup, text: "message-0", createdAt: 0 })).toBe(false);
    expect(cache.has({ ...directLookup, text: "message-512", createdAt: 512 })).toBe(true);
  });

  it("does not collide long texts that differ only in the middle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    const prefix = "a".repeat(256);
    const suffix = "b".repeat(256);
    const longTextA = `${prefix}${"x".repeat(300)}${suffix}`;
    const longTextB = `${prefix}${"y".repeat(300)}${suffix}`;

    cache.remember({ ...directLookup, text: longTextA, createdAt: 123 });

    expect(cache.has({ ...directLookup, text: longTextA, createdAt: 123 })).toBe(true);
    expect(cache.has({ ...directLookup, text: longTextB, createdAt: 123 })).toBe(false);
  });
});
