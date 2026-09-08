import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createSessionPullRequestCache } from "./control-ui-session-pr-cache.js";

describe("session PR cache retention", () => {
  it("retains watched entries beyond the unobserved bound and releases them on retirement", () => {
    const cache = createSessionPullRequestCache<number>();
    const watchers = Array.from({ length: 300 }, () => new AbortController());
    for (const [index, watcher] of watchers.entries()) {
      cache.set(String(index), index, watcher.signal);
    }
    for (const [index, watcher] of watchers.entries()) {
      expect(cache.get(String(index))).toBe(index);
      expect(getEventListeners(watcher.signal, "abort")).toHaveLength(1);
      watcher.abort();
      expect(getEventListeners(watcher.signal, "abort")).toHaveLength(0);
    }
    expect(
      Array.from({ length: 300 }, (_, index) => cache.get(String(index))).filter(
        (entry) => entry !== undefined,
      ),
    ).toHaveLength(100);
  });

  it("shares refreshed entries while releasing only the departing watcher's pin", () => {
    const cache = createSessionPullRequestCache<number>();
    const first = new AbortController();
    const second = new AbortController();
    cache.set("shared", 1, first.signal);
    expect(cache.get("shared", second.signal)).toBe(1);
    cache.set("shared", 2, first.signal);
    first.abort();
    for (let index = 0; index < 101; index++) {
      cache.set(String(index), index);
    }
    expect(cache.get("shared", second.signal)).toBe(2);
    expect(getEventListeners(second.signal, "abort")).toHaveLength(1);
    second.abort();
    expect(cache.get("shared")).toBeUndefined();
  });

  it("releases replaced keys and cannot repin after abort or accumulate listeners", () => {
    const cache = createSessionPullRequestCache<number>();
    const watcher = new AbortController();
    for (let index = 0; index < 300; index++) {
      cache.get(String(index), watcher.signal);
      cache.set(String(index), index, watcher.signal);
      expect(getEventListeners(watcher.signal, "abort")).toHaveLength(1);
    }
    expect(cache.get("0")).toBeUndefined();
    cache.release(watcher.signal);
    expect(getEventListeners(watcher.signal, "abort")).toHaveLength(0);
    watcher.abort();
    cache.set("late", 1, watcher.signal);
    for (let index = 0; index < 101; index++) {
      cache.set(String(index), index, watcher.signal);
    }
    expect(cache.get("late", watcher.signal)).toBeUndefined();
    expect(getEventListeners(watcher.signal, "abort")).toHaveLength(0);
  });
});
