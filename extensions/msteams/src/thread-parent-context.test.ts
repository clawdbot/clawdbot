import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphThreadMessage } from "./graph-thread.js";
import {
  _resetThreadParentContextCachesForTest,
  fetchParentMessageCached,
  formatParentContextEvent,
  markParentContextInjected,
  shouldInjectParentContext,
  summarizeParentMessage,
} from "./thread-parent-context.js";

describe("summarizeParentMessage", () => {
  it("returns undefined for missing message", () => {
    expect(summarizeParentMessage(undefined)).toBeUndefined();
  });

  it("returns undefined when body is blank", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      from: { user: { displayName: "Alice" } },
      body: { content: "   ", contentType: "text" },
    };
    expect(summarizeParentMessage(msg)).toBeUndefined();
  });

  it("extracts sender + plain text", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      from: { user: { displayName: "Alice" } },
      body: { content: "Hello world", contentType: "text" },
    };
    expect(summarizeParentMessage(msg)).toEqual({ sender: "Alice", text: "Hello world" });
  });

  it("strips HTML for html contentType", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      from: { user: { displayName: "Bob" } },
      body: { content: "<p>Hi <b>there</b></p>", contentType: "html" },
    };
    expect(summarizeParentMessage(msg)).toEqual({ sender: "Bob", text: "Hi there" });
  });

  it("collapses whitespace in text contentType", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      from: { user: { displayName: "Carol" } },
      body: { content: "line one\n  line two\t\ttrailing", contentType: "text" },
    };
    expect(summarizeParentMessage(msg)).toEqual({
      sender: "Carol",
      text: "line one line two trailing",
    });
  });

  it("falls back to application displayName", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      from: { application: { displayName: "BotApp" } },
      body: { content: "heads up", contentType: "text" },
    };
    expect(summarizeParentMessage(msg)).toEqual({ sender: "BotApp", text: "heads up" });
  });

  it("falls back to unknown when sender is missing", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      body: { content: "orphan", contentType: "text" },
    };
    expect(summarizeParentMessage(msg)).toEqual({ sender: "unknown", text: "orphan" });
  });

  it("truncates overly long parent text", () => {
    const msg: GraphThreadMessage = {
      id: "p1",
      from: { user: { displayName: "Dana" } },
      body: { content: "x".repeat(1000), contentType: "text" },
    };
    const summary = summarizeParentMessage(msg);
    expect(summary?.text.length).toBeLessThanOrEqual(400);
    expect(summary?.text.endsWith("…")).toBe(true);
  });
});

describe("formatParentContextEvent", () => {
  it("formats as Replying to @sender: body", () => {
    expect(formatParentContextEvent({ sender: "Alice", text: "hello there" })).toBe(
      "Replying to @Alice: hello there",
    );
  });
});

describe("fetchParentMessageCached", () => {
  beforeEach(() => {
    _resetThreadParentContextCachesForTest();
  });

  it("invokes the fetcher on first call", async () => {
    const mockMsg: GraphThreadMessage = {
      id: "p1",
      body: { content: "hi", contentType: "text" },
    };
    const fetcher = vi.fn(async () => mockMsg);

    const result = await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);

    expect(result).toEqual(mockMsg);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("tok", "g1", "c1", "p1");
  });

  it("returns cached value on repeat fetch without invoking fetcher", async () => {
    const mockMsg: GraphThreadMessage = {
      id: "p1",
      body: { content: "hi", contentType: "text" },
    };
    const fetcher = vi.fn(async () => mockMsg);

    await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);
    await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);
    const third = await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(third).toEqual(mockMsg);
  });

  it("caches undefined (Graph error) so failures do not re-fetch on burst", async () => {
    const fetcher = vi.fn(async () => undefined);

    const first = await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);
    const second = await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("scopes cache by groupId/channelId/parentId", async () => {
    const fetcher = vi.fn(async (_tok, _g, _c, parentId) => ({
      id: parentId,
      body: { content: `content-${parentId}`, contentType: "text" },
    }));

    await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);
    await fetchParentMessageCached("tok", "g1", "c1", "p2", fetcher);
    await fetchParentMessageCached("tok", "g2", "c1", "p1", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("re-fetches after TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => ({
        id: "p1",
        body: { content: "hi", contentType: "text" },
      }));

      await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);
      // 5 min TTL: advance just beyond.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);

      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts oldest entries when exceeding the 100-entry cap", async () => {
    const fetcher = vi.fn(async (_tok, _g, _c, parentId) => ({
      id: String(parentId),
      body: { content: `v-${parentId}`, contentType: "text" },
    }));

    // Fill cache with 100 distinct parents.
    for (let i = 0; i < 100; i += 1) {
      await fetchParentMessageCached("tok", "g1", "c1", `p${i}`, fetcher);
    }
    expect(fetcher).toHaveBeenCalledTimes(100);

    // First entry should still be cached (no evictions yet).
    await fetchParentMessageCached("tok", "g1", "c1", "p0", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(100);

    // Push one more distinct parent to trigger an eviction.
    // The just-touched p0 is now the newest; the next-oldest (p1) should be evicted.
    await fetchParentMessageCached("tok", "g1", "c1", "p100", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(101);

    // Fetching p1 again should miss the cache.
    await fetchParentMessageCached("tok", "g1", "c1", "p1", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(102);

    // p0 is still cached because we refreshed it.
    await fetchParentMessageCached("tok", "g1", "c1", "p0", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(102);
  });
});

describe("shouldInjectParentContext / markParentContextInjected", () => {
  beforeEach(() => {
    _resetThreadParentContextCachesForTest();
  });

  it("returns true for first observation", () => {
    expect(shouldInjectParentContext("session-1", "parent-1")).toBe(true);
  });

  it("returns false after marking the same parent", () => {
    markParentContextInjected("session-1", "parent-1");
    expect(shouldInjectParentContext("session-1", "parent-1")).toBe(false);
  });

  it("returns true again when a different parent appears in the session", () => {
    markParentContextInjected("session-1", "parent-1");
    expect(shouldInjectParentContext("session-1", "parent-2")).toBe(true);
  });

  it("dedupe is scoped per session key", () => {
    markParentContextInjected("session-1", "parent-1");
    expect(shouldInjectParentContext("session-2", "parent-1")).toBe(true);
  });
});
