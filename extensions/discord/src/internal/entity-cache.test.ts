import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordEntityCache } from "./entity-cache.js";
import type { RequestClient } from "./rest.js";
import type { StructureClient } from "./structures.js";

function makeCache(opts: { ttlMs?: number; maxEntries?: number; sweepIntervalMs?: number }) {
  let getCalls = 0;
  const rest = {
    get: async (route: string) => {
      getCalls += 1;
      const id = route.split("/").pop() ?? "x";
      return { id };
    },
  } as unknown as RequestClient;
  const client = {} as StructureClient;
  const cache = new DiscordEntityCache({ client, rest, ...opts });
  return { cache, getCalls: () => getCalls };
}

describe("DiscordEntityCache eviction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps entries by dropping oldest on insert past maxEntries", async () => {
    const { cache } = makeCache({ ttlMs: 60_000, maxEntries: 3 });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    await cache.fetchUser("u3");
    expect(cache.size).toBe(3);

    await cache.fetchUser("u4");
    expect(cache.size).toBe(3);
  });

  it("sweeps expired entries on insert when sweep interval has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { cache } = makeCache({ ttlMs: 1, sweepIntervalMs: 0, maxEntries: 1000 });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(5);

    await cache.fetchUser("u3");
    expect(cache.size).toBe(1);
  });

  it("does not sweep before sweep interval elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { cache } = makeCache({
      ttlMs: 1,
      sweepIntervalMs: 60_000,
      maxEntries: 1000,
    });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    vi.advanceTimersByTime(5);
    await cache.fetchUser("u3");

    expect(cache.size).toBe(3);
  });

  it("does not write when ttl is 0", async () => {
    const { cache } = makeCache({ ttlMs: 0 });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");

    expect(cache.size).toBe(0);
  });
});
