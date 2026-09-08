import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { capEntryCount } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

describe("capEntryCount archive behavior", () => {
  it("archives the eligible session untouched longest across the whole active roster", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      oldestUpdateButRecentlyTouched: {
        ...makeEntry(now - 10 * DAY_MS),
        lastInteractionAt: now - DAY_MS,
      },
      untouchedLongest: {
        ...makeEntry(now - 2 * DAY_MS),
        lastActivityAt: now - 3 * DAY_MS,
      },
      newest: makeEntry(now),
    };

    expect(capEntryCount(store, 2, { nowMs: now })).toBe(1);
    expect(store.untouchedLongest?.archivedAt).toBe(now);
    expect(store.untouchedLongest?.archiveReason).toBe("active-session-cap");
    expect(store.oldestUpdateButRecentlyTouched?.archivedAt).toBeUndefined();
    expect(store.newest?.archivedAt).toBeUndefined();
  });

  it("preserves archived sessions when capping", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      archived: { ...makeEntry(now - 10 * DAY_MS), archivedAt: now - 5 * DAY_MS },
      recent: makeEntry(now),
      old: makeEntry(now - DAY_MS),
    };

    expect(capEntryCount(store, 2)).toBe(0);
    expect(store).toHaveProperty("archived");
    expect(store.recent?.archivedAt).toBeUndefined();
    expect(store.old?.archivedAt).toBeUndefined();
  });
});
