// Tlon monitor tracking tests cover thread eviction and snapshot lifecycle.
import { describe, expect, it } from "vitest";
import { createActiveSnapshotTracker, createParticipatedThreadTracker } from "./tracking.js";

describe("createParticipatedThreadTracker", () => {
  it("evicts the least recently used thread at the configured limit", () => {
    const tracker = createParticipatedThreadTracker(3);
    tracker.add("oldest");
    tracker.add("refreshed");
    tracker.add("recent");

    expect(tracker.has("refreshed")).toBe(true);
    tracker.add("newest");

    expect(tracker.has("oldest")).toBe(false);
    expect(tracker.has("refreshed")).toBe(true);
    expect(tracker.has("recent")).toBe(true);
    expect(tracker.has("newest")).toBe(true);
  });
});

describe("createActiveSnapshotTracker", () => {
  it("forgets processed keys after they leave the active snapshot", () => {
    const tracker = createActiveSnapshotTracker();
    expect(tracker.beginSnapshot(["active", "removed"])).toEqual(new Set(["active", "removed"]));
    tracker.add("active");
    tracker.add("removed");

    tracker.beginSnapshot(["active"]);
    expect(tracker.has("active")).toBe(true);
    expect(tracker.has("removed")).toBe(false);

    tracker.beginSnapshot(["active", "removed"]);
    expect(tracker.has("removed")).toBe(false);
  });

  it("does not impose a count cap on the authoritative active snapshot", () => {
    const tracker = createActiveSnapshotTracker();
    const keys = Array.from({ length: 2_001 }, (_, index) => `invite-${index}`);
    const active = tracker.beginSnapshot(keys);
    for (const key of active) {
      tracker.add(key);
    }

    expect(keys.every((key) => tracker.has(key))).toBe(true);
  });
});
