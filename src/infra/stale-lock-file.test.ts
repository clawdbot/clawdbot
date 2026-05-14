import { describe, expect, it } from "vitest";
import { shouldRemoveDeadOwnerOrExpiredLock } from "./stale-lock-file.js";

describe("stale lock file ownership", () => {
  it("treats permission-denied process probes as not definitely dead", () => {
    expect(
      shouldRemoveDeadOwnerOrExpiredLock({
        payload: {
          pid: 123,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
        staleMs: 10,
        isPidDefinitelyDead: () => false,
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
});
