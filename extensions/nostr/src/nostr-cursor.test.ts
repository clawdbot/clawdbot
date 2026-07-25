import type { Event } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { createNostrCursorStateWriter, createNostrDurableCursor } from "./nostr-cursor.js";

function event(createdAt: number): Event {
  return { created_at: createdAt } as Event;
}

describe("Nostr durable cursor", () => {
  it("waits for EOSE before persisting the largest durable timestamp", () => {
    const cursor = createNostrDurableCursor({
      since: 800,
      replayOverlapSec: 120,
      nowSec: () => 1_000,
    });

    expect(cursor.recordDurableAppend(event(900))).toBeUndefined();
    expect(cursor.recordDurableAppend(event(1_100))).toBeUndefined();

    expect(cursor.markBackfillComplete()).toBe(1_000);
  });

  it("caps progress so a transiently rejected event remains inside replay overlap", () => {
    const cursor = createNostrDurableCursor({
      since: 800,
      replayOverlapSec: 120,
      nowSec: () => 1_200,
    });

    cursor.recordDurableAppend(event(1_100));
    cursor.recordTransientRejection(event(900));
    expect(cursor.markBackfillComplete()).toBe(1_020);
    expect(cursor.recordTransientRejection(event(950))).toBeUndefined();
  });

  it("ignores rejected events older than the active relay filter", () => {
    const cursor = createNostrDurableCursor({
      since: 800,
      replayOverlapSec: 120,
      nowSec: () => 1_200,
    });

    cursor.recordDurableAppend(event(1_100));
    cursor.recordTransientRejection(event(700));
    expect(cursor.markBackfillComplete()).toBe(1_100);
  });

  it("serializes a safety rewind after an older in-flight progress write", async () => {
    let releaseHigh!: () => void;
    const highGate = new Promise<void>((resolve) => {
      releaseHigh = resolve;
    });
    const write = vi.fn(async (cursor: number) => {
      if (cursor === 2_000) {
        await highGate;
      }
    });
    const writer = createNostrCursorStateWriter({
      initialCursor: 1_000,
      minimumCursor: 1_000,
      debounceMs: 60_000,
      write,
    });

    writer.schedule(2_000);
    const highWrite = writer.flush();
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(2_000));
    const rewind = writer.persistNow(1_050);
    const stricterRewind = writer.persistNow(1_020);
    releaseHigh();
    await Promise.all([highWrite, rewind, stricterRewind]);

    expect(write.mock.calls.map(([cursor]) => cursor)).toEqual([2_000, 1_020]);
  });

  it("keeps a failed cursor write dirty for a later flush retry", async () => {
    const write = vi
      .fn<(cursor: number) => Promise<void>>()
      .mockRejectedValue(new Error("state unavailable"));
    const writer = createNostrCursorStateWriter({
      initialCursor: 1_000,
      minimumCursor: 1_000,
      debounceMs: 60_000,
      write,
    });

    writer.schedule(1_100);
    await expect(writer.flush()).rejects.toThrow("cursor state write failed");
    expect(write).toHaveBeenCalledTimes(3);

    write.mockResolvedValue(undefined);
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("keeps retrying a failed safety write until it is durable", async () => {
    const write = vi
      .fn<(cursor: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockResolvedValue(undefined);
    const writer = createNostrCursorStateWriter({
      initialCursor: 1_000,
      minimumCursor: 1_000,
      debounceMs: 60_000,
      recoveryRetryMs: 0,
      write,
    });

    writer.schedule(1_020);
    await expect(writer.flushUntilSuccess()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(4);
    expect(write).toHaveBeenLastCalledWith(1_020);
  });
});
