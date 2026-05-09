import { describe, expect, it } from "vitest";
import { createSessionManagerCache } from "./session-manager-cache.js";

describe("session manager cache", () => {
  it("prunes expired entries during later cache activity even without revisiting them", () => {
    let now = 1_000;
    const cache = createSessionManagerCache({
      clock: () => now,
      ttlMs: 5_000,
    });

    cache.trackSessionManagerAccess("/tmp/stale-session.jsonl");
    expect(cache.keys()).toEqual(["/tmp/stale-session.jsonl"]);

    now = 7_000;

    cache.trackSessionManagerAccess("/tmp/fresh-session.jsonl");
    expect(cache.keys()).toEqual(["/tmp/fresh-session.jsonl"]);
  });

  it("can disable caching via the injected TTL resolver", () => {
    const cache = createSessionManagerCache({
      ttlMs: 0,
    });

    cache.trackSessionManagerAccess("/tmp/session.jsonl");

    expect(cache.isSessionManagerCached("/tmp/session.jsonl")).toBe(false);
    expect(cache.keys()).toStrictEqual([]);
  });
});
