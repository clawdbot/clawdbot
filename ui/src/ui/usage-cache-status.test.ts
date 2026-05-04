// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getUsageCacheRefreshTitle } from "./usage-cache-status.ts";

describe("getUsageCacheRefreshTitle", () => {
  it("formats non-fresh cache states for the Usage loading badge", () => {
    expect(
      getUsageCacheRefreshTitle({
        status: "refreshing",
        cachedFiles: 4,
        pendingFiles: 2,
        staleFiles: 2,
      }),
    ).toBe("refreshing: 2 pending, 2 stale, 4 cached");
    expect(
      getUsageCacheRefreshTitle({
        status: "partial",
        cachedFiles: 4,
        pendingFiles: 1,
        staleFiles: 1,
      }),
    ).toBe("partial: 1 pending, 1 stale, 4 cached");
    expect(
      getUsageCacheRefreshTitle({
        status: "fresh",
        cachedFiles: 4,
        pendingFiles: 0,
        staleFiles: 0,
      }),
    ).toBeNull();
  });
});
