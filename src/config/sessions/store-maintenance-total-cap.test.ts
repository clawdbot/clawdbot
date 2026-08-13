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

describe("session maintenance total entry cap", () => {
  it("counts archived sessions toward the cap without evicting them", () => {
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

    expect(capEntryCount(store, 500)).toBe(2);
    expect(Object.keys(store)).toHaveLength(500);
    expect(store["dashboard-1"]).toBeUndefined();
    expect(store["dashboard-2"]).toBeUndefined();
    expect(store).toHaveProperty("dashboard-3");
    expect(store).toHaveProperty("archived-0");
    expect(store).toHaveProperty("archived-498");
  });

  it("uses the remaining total capacity for ordinary sessions", () => {
    const pinnedEntries = Array.from({ length: 200 }, (_, index): [string, SessionEntry] => [
      `pinned-${index}`,
      { ...makeEntry(index), pinnedAt: index + 1 },
    ]);
    const ordinaryEntries = Array.from({ length: 400 }, (_, index): [string, SessionEntry] => [
      `ordinary-${index}`,
      makeEntry(index),
    ]);
    const store = makeStore([...pinnedEntries, ...ordinaryEntries]);

    expect(capEntryCount(store, 500)).toBe(100);
    expect(Object.keys(store)).toHaveLength(500);
    expect(store["ordinary-99"]).toBeUndefined();
    expect(store).toHaveProperty("ordinary-100");
    expect(store).toHaveProperty("ordinary-399");
    expect(store).toHaveProperty("pinned-0");
    expect(store).toHaveProperty("pinned-199");
  });

  it("uses total rows when warning that an active session would be capped", () => {
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
        maxEntries: 500,
        nowMs: now,
      }),
    ).toMatchObject({ wouldCap: true, wouldPrune: false });
  });
});
