import { describe, expect, it } from "vitest";
import { capEntryCount, getActiveSessionMaintenanceWarning } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: `session-${updatedAt}`, updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

describe("session maintenance eligible quota", () => {
  it("keeps 499 archived sessions outside the ordinary-session allowance", () => {
    const now = Date.now();
    const archivedEntries = Array.from({ length: 499 }, (_, index): [string, SessionEntry] => [
      `archived-${index}`,
      { ...makeEntry(index), archivedAt: now },
    ]);
    const store = makeStore([
      ...archivedEntries,
      ["dashboard-1", makeEntry(now - 2)],
      ["dashboard-2", makeEntry(now - 1)],
      ["dashboard-3", makeEntry(now)],
    ]);

    expect(capEntryCount(store, 500)).toBe(0);
    expect(Object.keys(store)).toHaveLength(502);
    expect(store).toHaveProperty("dashboard-1");
    expect(store).toHaveProperty("dashboard-2");
    expect(store).toHaveProperty("dashboard-3");
  });

  it("removes only the oldest eligible session above the allowance", () => {
    const now = Date.now();
    const archivedEntries = Array.from({ length: 499 }, (_, index): [string, SessionEntry] => [
      `archived-${index}`,
      { ...makeEntry(index), archivedAt: now },
    ]);
    const eligibleEntries = Array.from({ length: 501 }, (_, index): [string, SessionEntry] => [
      `eligible-${index}`,
      makeEntry(index),
    ]);
    const store = makeStore([...archivedEntries, ...eligibleEntries]);

    expect(capEntryCount(store, 500)).toBe(1);
    expect(store["eligible-0"]).toBeUndefined();
    expect(store).toHaveProperty("eligible-1");
    expect(store).toHaveProperty("eligible-500");
    expect(store).toHaveProperty("archived-0");
    expect(store).toHaveProperty("archived-498");
  });

  it("does not count archived sessions against the active-session allowance", () => {
    const now = Date.now();
    const archivedEntries = Array.from({ length: 499 }, (_, index): [string, SessionEntry] => [
      `archived-${index}`,
      { ...makeEntry(index), archivedAt: now },
    ]);
    const store = makeStore([
      ...archivedEntries,
      ["recent", makeEntry(now)],
      ["active", makeEntry(now - 1)],
    ]);

    expect(
      getActiveSessionMaintenanceWarning({
        store,
        activeSessionKey: "active",
        pruneAfterMs: DAY_MS,
        maxEntries: 2,
        nowMs: now,
      }),
    ).toBeNull();
  });
});
