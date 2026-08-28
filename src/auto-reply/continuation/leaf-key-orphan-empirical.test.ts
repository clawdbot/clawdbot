/**
 * Proves post-compaction delegates are strictly session-keyed. A one-shot leaf
 * that never compacts strands a leaf-keyed delegate, while staging under the
 * long-lived parent keeps the delegate consumable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  stagePostCompactionDelegate,
  consumeStagedPostCompactionDelegates,
  stagedPostCompactionDelegateCount,
} from "../continuation/delegate-store-post-compaction.js";

describe("leaf-key post-compaction staging", () => {
  const leafKey = "leaf-session::oneshot-deny-tools";
  const parentKey = "parent-session::live-requester";

  beforeEach(() => {
    consumeStagedPostCompactionDelegates(leafKey);
    consumeStagedPostCompactionDelegates(parentKey);
  });

  it("keeps a leaf-keyed delegate invisible to the parent's consume", () => {
    stagePostCompactionDelegate(leafKey, {
      task: "leaf-keyed delegate",
      createdAt: 1_700_000_000_000,
    });
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);

    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);
    const parentConsumed = consumeStagedPostCompactionDelegates(parentKey);
    expect(parentConsumed).toHaveLength(0);

    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);
  });

  it("strands a leaf-keyed delegate when the leaf never compacts", () => {
    stagePostCompactionDelegate(leafKey, {
      task: "leaf-keyed delegate",
      createdAt: 1_700_000_000_000,
    });
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);

    // No leaf-key consume occurs before the one-shot leaf is removed.
    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);
    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);

    stagePostCompactionDelegate(parentKey, {
      task: "parent-keyed delegate",
      createdAt: 1_700_000_000_000,
    });
    const parentFired = consumeStagedPostCompactionDelegates(parentKey);
    expect(parentFired).toHaveLength(1);
    expect(parentFired[0]).toMatchObject({
      task: "parent-keyed delegate",
    });

    expect(stagedPostCompactionDelegateCount(leafKey)).toBe(1);
  });

  it("no migration: deleting/cleaning the leaf lane does NOT move its delegate to the parent", () => {
    stagePostCompactionDelegate(leafKey, {
      task: "leaf-keyed delegate",
      createdAt: 1_700_000_000_000,
    });
    // The parent stays empty unless the delegate is explicitly staged there.
    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);

    consumeStagedPostCompactionDelegates(leafKey);
    expect(stagedPostCompactionDelegateCount(parentKey)).toBe(0);
  });
});
