import { describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

describe("createSlackThreadTsResolver", () => {
  function makeThreadReplyMessage(ts: string): SlackMessageEvent {
    return {
      channel: "C1",
      parent_user_id: "U2",
      ts,
    } as SlackMessageEvent;
  }

  it("caches resolved thread_ts lookups", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as any,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });

    const message = makeThreadReplyMessage("1");

    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first.thread_ts).toBe("9");
    expect(second.thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("marks cached unresolved lookups as ambiguous thread replies", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as any,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });

    const message = makeThreadReplyMessage("1");

    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first["_ambiguousThreadReply"]).toBe(true);
    expect(second["_ambiguousThreadReply"]).toBe(true);
    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default ttl when cacheTtlMs is non-finite", async () => {
    vi.useFakeTimers();
    try {
      const historyMock = vi.fn().mockResolvedValue({
        messages: [{ ts: "1", thread_ts: "9" }],
      });
      const resolver = createSlackThreadTsResolver({
        client: { conversations: { history: historyMock } } as never,
        cacheTtlMs: Number.NaN,
        maxSize: 5,
      });
      const message = makeThreadReplyMessage("1");

      await resolver.resolve({ message, source: "message" });
      vi.advanceTimersByTime(60_001);
      await resolver.resolve({ message, source: "message" });

      expect(historyMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the default max size when maxSize is non-finite", async () => {
    const historyMock = vi.fn(async ({ latest }: { latest: string }) => ({
      messages: [{ ts: latest, thread_ts: `thread-${latest}` }],
    }));
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 60_000,
      maxSize: Number.NaN,
    });

    for (let i = 0; i <= 500; i++) {
      await resolver.resolve({ message: makeThreadReplyMessage(String(i)), source: "message" });
    }
    await resolver.resolve({ message: makeThreadReplyMessage("0"), source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(502);
  });
});
