// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getUsageCacheRefreshTitle, mergeUsageCacheStatus } from "./cache-status.ts";

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

describe("mergeUsageCacheStatus refreshedAt", () => {
  const base = { status: "fresh" as const, cachedFiles: 1, pendingFiles: 0, staleFiles: 0 };
  const refreshedAtCases: Array<
    [string, number | undefined, number | undefined, number | undefined]
  > = [
    ["both undefined", undefined, undefined, undefined],
    ["zero vs undefined", 0, undefined, undefined],
    ["undefined vs zero", undefined, 0, undefined],
    ["zero vs zero", 0, 0, undefined],
    ["positive vs undefined", 100, undefined, 100],
    ["undefined vs positive", undefined, 200, 200],
    ["positive vs zero", 100, 0, 100],
    ["zero vs positive", 0, 200, 200],
    ["smaller vs larger", 100, 200, 200],
    ["larger vs smaller", 300, 100, 300],
  ];

  it.each(refreshedAtCases)(
    "merges refreshedAt: %s",
    (_label, sessionsRefreshedAt, costRefreshedAt, expected) => {
      const sessionsStatus: typeof base & { refreshedAt?: number } = {
        ...base,
        ...(sessionsRefreshedAt !== undefined ? { refreshedAt: sessionsRefreshedAt } : {}),
      };
      const costStatus: typeof base & { refreshedAt?: number } = {
        ...base,
        ...(costRefreshedAt !== undefined ? { refreshedAt: costRefreshedAt } : {}),
      };
      const result = mergeUsageCacheStatus(sessionsStatus, costStatus);
      expect(result).toBeDefined();
      expect(result!.refreshedAt).toBe(expected);
    },
  );
});
