// Covers stale lock-file owner decisions.
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  isLockOwnerDefinitelyStale,
  shouldRemoveDeadOwnerOrExpiredLock,
} from "./stale-lock-file.js";

describe("stale lock file ownership", () => {
  it("keeps expired locks when a pid owner is not definitely dead", () => {
    expect(
      isLockOwnerDefinitelyStale({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
        },
        isPidDefinitelyDead: () => false,
      }),
    ).toBe(false);
  });

  it("classifies locks when the owner pid starttime changed", () => {
    expect(
      isLockOwnerDefinitelyStale({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
          starttime: 111,
        },
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => 222,
      }),
    ).toBe(true);
  });

  it("keeps locks when the owner pid starttime still matches", () => {
    expect(
      isLockOwnerDefinitelyStale({
        payload: {
          pid: 123,
          createdAt: "2026-05-23T00:00:00.000Z",
          starttime: 111,
        },
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => 111,
      }),
    ).toBe(false);
  });

  it("classifies pid-owned locks when the owner is definitely dead", () => {
    expect(
      isLockOwnerDefinitelyStale({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
        isPidDefinitelyDead: () => true,
      }),
    ).toBe(true);
  });

  it("keeps expired pidless locks because ownership cannot be proven", () => {
    expect(
      isLockOwnerDefinitelyStale({
        payload: {
          createdAt: "2026-05-23T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("retains shipped expiry recovery for generic pidless locks", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: { createdAt: "2026-05-23T00:00:00.000Z" },
        staleMs: 10,
        nowMs: Date.parse("2026-05-23T00:00:11.000Z"),
      }),
    ).toBe(true);
  });

  it("keeps malformed locks", () => {
    expect(
      isLockOwnerDefinitelyStale({
        payload: null,
      }),
    ).toBe(false);
  });

  it("accepts legacy Darwin microsecond start times", async () => {
    await withMockedPlatform("darwin", async () => {
      expect(
        isLockOwnerDefinitelyStale({
          payload: { pid: 123, starttime: 1_752_000_000_123_456 },
          isPidDefinitelyDead: () => false,
          getProcessStartTime: () => 1_752_000_000,
        }),
      ).toBe(false);
    });
  });
});
