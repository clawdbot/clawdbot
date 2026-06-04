// Covers stale lock-file owner decisions.
import { describe, expect, it } from "vitest";
import { shouldRemoveDeadOwnerOrExpiredLock } from "./stale-lock-file.js";

describe("stale lock file ownership", () => {
  it("keeps expired locks when a pid owner is not definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
        },
        staleMs: 10,
        nowMs: Date.parse("2026-05-23T00:00:11.000Z"),
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(false);
  });

  it("removes locks when the owner pid starttime changed", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
          starttime: 111,
        },
        staleMs: 60_000,
        nowMs: Date.parse("2026-05-23T00:00:10.000Z"),
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => 222,
      }),
    ).toBe(true);
  });

  it("does not remove locks when the owner pid starttime still matches", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
          starttime: 111,
        },
        staleMs: 10,
        nowMs: Date.parse("2026-05-23T00:00:11.000Z"),
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => 111,
      }),
    ).toBe(false);
  });

  it("only removes pid-owned locks when the owner is definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
        staleMs: 10,
        isPidDefinitelyDead: () => true,
      }),
    ).toBe(true);
  });

  it("removes expired pidless locks", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          createdAt: "2026-05-23T00:00:00.000Z",
        },
        staleMs: 10,
        nowMs: Date.parse("2026-05-23T00:00:11.000Z"),
      }),
    ).toBe(true);
  });
});
