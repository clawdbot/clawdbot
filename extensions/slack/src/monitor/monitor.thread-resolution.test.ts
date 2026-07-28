// Slack tests cover monitor.thread resolution plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

type SlackThreadClient = Parameters<typeof createSlackThreadTsResolver>[0]["client"];

function createThreadClient(history: ReturnType<typeof vi.fn>): SlackThreadClient {
  return { conversations: { history } } as unknown as SlackThreadClient;
}

describe("createSlackThreadTsResolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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
      client: createThreadClient(historyMock),
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
      client: createThreadClient(historyMock),
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
  });

  it("drops cached thread_ts lookups when the current clock is not a valid date timestamp", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await resolver.resolve({ message, source: "message" });
    nowSpy.mockReturnValue(Number.NaN);
    await resolver.resolve({ message, source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache thread_ts lookups when the expiry timestamp would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await resolver.resolve({ message, source: "message" });
    await resolver.resolve({ message, source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(2);
  });

  it("preserves cacheTtlMs zero as a non-expiring cache entry", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      client: { conversations: { history: historyMock } } as never,
      cacheTtlMs: 0,
      maxSize: 5,
    });
    const message = makeThreadReplyMessage("1");

    await resolver.resolve({ message, source: "message" });
    await resolver.resolve({ message, source: "message" });

    expect(historyMock).toHaveBeenCalledTimes(1);
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
