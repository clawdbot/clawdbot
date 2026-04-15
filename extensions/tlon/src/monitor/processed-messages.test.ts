import { describe, expect, it } from "vitest";
import {
  createProcessedMessageTracker,
  runWithProcessedMessageClaim,
} from "./processed-messages.js";

describe("createProcessedMessageTracker", () => {
  it("dedupes and evicts oldest entries", () => {
    const tracker = createProcessedMessageTracker(3);

    expect(tracker.mark("a")).toBe(true);
    expect(tracker.mark("a")).toBe(false);
    expect(tracker.has("a")).toBe(true);

    tracker.mark("b");
    tracker.mark("c");
    expect(tracker.size()).toBe(3);

    tracker.mark("d");
    expect(tracker.size()).toBe(3);
    expect(tracker.has("a")).toBe(false);
    expect(tracker.has("b")).toBe(true);
    expect(tracker.has("c")).toBe(true);
    expect(tracker.has("d")).toBe(true);
  });

  it("releases failed claims so retries can run again", async () => {
    const tracker = createProcessedMessageTracker();

    await expect(
      runWithProcessedMessageClaim({
        tracker,
        id: "evt-1",
        task: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(tracker.has("evt-1")).toBe(false);
    expect(tracker.claim("evt-1")).toEqual({ kind: "claimed" });
  });

  it("keeps successful claims deduped", async () => {
    const tracker = createProcessedMessageTracker();

    await expect(
      runWithProcessedMessageClaim({
        tracker,
        id: "evt-2",
        task: async () => undefined,
      }),
    ).resolves.toEqual({ kind: "processed", value: undefined });

    expect(tracker.has("evt-2")).toBe(true);
    expect(tracker.claim("evt-2")).toEqual({ kind: "duplicate" });
  });
});
