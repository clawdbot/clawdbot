import { expectDefined } from "@openclaw/normalization-core";
import { describe, it, expect, beforeEach } from "vitest";
import {
  cancelPendingDelegates,
  consumeStagedPostCompactionDelegates,
  enqueuePendingDelegate,
  consumePendingDelegates,
  pendingDelegateCount,
  stagePostCompactionDelegate,
  stagedPostCompactionDelegateCount,
} from "./continuation-delegate-store.js";

describe("continuation-delegate-store", () => {
  beforeEach(() => {
    cancelPendingDelegates("test-session");
    cancelPendingDelegates("other-session");
  });

  it("returns empty array when no delegates pending", () => {
    expect(consumePendingDelegates("test-session")).toEqual([]);
  });

  it("enqueues and consumes a single delegate", () => {
    enqueuePendingDelegate("test-session", {
      task: "summarize the RFC",
      delayMs: 0,
    });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    const delegate = expectDefined(delegates.at(0), "delegate");
    expect(delegate.task).toBe("summarize the RFC");
    expect(delegate.delayMs).toBe(0);
  });

  it("consumes removes delegates from store", () => {
    enqueuePendingDelegate("test-session", { task: "task 1" });

    const first = consumePendingDelegates("test-session");
    expect(first).toHaveLength(1);

    const second = consumePendingDelegates("test-session");
    expect(second).toEqual([]);
  });

  it("supports multiple delegates per session (multi-arrow fan-out)", () => {
    enqueuePendingDelegate("test-session", { task: "arrow 1" });
    enqueuePendingDelegate("test-session", { task: "arrow 2", mode: "silent" });
    enqueuePendingDelegate("test-session", { task: "arrow 3", mode: "silent-wake" });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(3);
    expect(expectDefined(delegates.at(0), "first delegate").task).toBe("arrow 1");
    const secondDelegate = expectDefined(delegates.at(1), "second delegate");
    expect(secondDelegate.task).toBe("arrow 2");
    expect(secondDelegate.mode).toBe("silent");
    const thirdDelegate = expectDefined(delegates.at(2), "third delegate");
    expect(thirdDelegate.task).toBe("arrow 3");
    expect(thirdDelegate.mode).toBe("silent-wake");
  });

  it("isolates delegates by session key", () => {
    enqueuePendingDelegate("test-session", { task: "session A task" });
    enqueuePendingDelegate("other-session", { task: "session B task" });

    const a = consumePendingDelegates("test-session");
    const b = consumePendingDelegates("other-session");

    expect(a).toHaveLength(1);
    expect(expectDefined(a.at(0), "session A delegate").task).toBe("session A task");
    expect(b).toHaveLength(1);
    expect(expectDefined(b.at(0), "session B delegate").task).toBe("session B task");
  });

  it("pendingDelegateCount reflects current queue depth", () => {
    expect(pendingDelegateCount("test-session")).toBe(0);

    enqueuePendingDelegate("test-session", { task: "task 1" });
    expect(pendingDelegateCount("test-session")).toBe(1);

    enqueuePendingDelegate("test-session", { task: "task 2" });
    expect(pendingDelegateCount("test-session")).toBe(2);

    consumePendingDelegates("test-session");
    expect(pendingDelegateCount("test-session")).toBe(0);
  });

  it("handles delegates with no optional fields", () => {
    enqueuePendingDelegate("test-session", { task: "minimal task" });

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    // `flowId` + `expectedRevision` are carried through from the consumed
    // TaskFlow row so dispatch-time spawn failures can mark the row failed
    // without re-querying. The minimal-fields test only cares that no
    // optional caller-set fields leak through, so assert on `task` and
    // check the carry-through metadata shape separately.
    const delegate = expectDefined(delegates.at(0), "delegate");
    expect(delegate.task).toBe("minimal task");
    expect(typeof delegate.flowId).toBe("string");
    expect(delegate.expectedRevision).toBe(1);
    expect(delegate.delayMs).toBeUndefined();
    expect(delegate.mode).toBeUndefined();
    expect(delegate.targetSessionKey).toBeUndefined();
    expect(delegate.targetSessionKeys).toBeUndefined();
    expect(delegate.fanoutMode).toBeUndefined();
  });

  it("handles zero delay (immediate dispatch)", () => {
    enqueuePendingDelegate("test-session", { task: "immediate", delayMs: 0 });

    const delegates = consumePendingDelegates("test-session");
    expect(expectDefined(delegates.at(0), "delegate").delayMs).toBe(0);
  });
});

describe("post-compaction delegate staging", () => {
  beforeEach(() => {
    cancelPendingDelegates("test-session");
    cancelPendingDelegates("other-session");
  });

  it("returns empty array when no staged delegates are pending", () => {
    expect(consumeStagedPostCompactionDelegates("test-session")).toEqual([]);
  });

  it("stages and consumes a post-compaction delegate", () => {
    stagePostCompactionDelegate("test-session", {
      task: "carry working state past compaction",
      createdAt: 123,
    });

    const delegates = consumeStagedPostCompactionDelegates("test-session");
    expect(delegates).toHaveLength(1);
    const delegate = expectDefined(delegates.at(0), "post-compaction delegate");
    expect(delegate.task).toBe("carry working state past compaction");
    expect(typeof delegate.createdAt).toBe("number");
  });

  it("consuming removes staged delegates from store", () => {
    stagePostCompactionDelegate("test-session", { task: "task 1", createdAt: 1 });

    const first = consumeStagedPostCompactionDelegates("test-session");
    expect(first).toHaveLength(1);

    const second = consumeStagedPostCompactionDelegates("test-session");
    expect(second).toEqual([]);
  });

  it("supports multiple staged delegates per session", () => {
    stagePostCompactionDelegate("test-session", { task: "shard 1", createdAt: 1 });
    stagePostCompactionDelegate("test-session", { task: "shard 2", createdAt: 2 });
    stagePostCompactionDelegate("test-session", { task: "shard 3", createdAt: 3 });

    const delegates = consumeStagedPostCompactionDelegates("test-session");
    expect(delegates).toHaveLength(3);
    expect(delegates.map((d) => d.task)).toEqual(["shard 1", "shard 2", "shard 3"]);
  });

  it("isolates staged delegates by session key", () => {
    stagePostCompactionDelegate("test-session", { task: "session A", createdAt: 1 });
    stagePostCompactionDelegate("other-session", { task: "session B", createdAt: 1 });

    expect(consumeStagedPostCompactionDelegates("test-session")).toHaveLength(1);
    expect(consumeStagedPostCompactionDelegates("other-session")).toHaveLength(1);
  });

  it("staged delegates are separate from immediate delegates", () => {
    enqueuePendingDelegate("test-session", { task: "immediate task" });
    stagePostCompactionDelegate("test-session", { task: "compaction task", createdAt: 1 });

    expect(pendingDelegateCount("test-session")).toBe(1);
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(1);

    const immediate = consumePendingDelegates("test-session");
    expect(immediate).toHaveLength(1);
    expect(expectDefined(immediate.at(0), "immediate delegate").task).toBe("immediate task");

    const compaction = consumeStagedPostCompactionDelegates("test-session");
    expect(compaction).toHaveLength(1);
    expect(expectDefined(compaction.at(0), "compaction delegate").task).toBe("compaction task");
  });

  it("stagedPostCompactionDelegateCount reflects current queue depth", () => {
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(0);

    stagePostCompactionDelegate("test-session", { task: "task 1", createdAt: 1 });
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(1);

    stagePostCompactionDelegate("test-session", { task: "task 2", createdAt: 2 });
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(2);

    consumeStagedPostCompactionDelegates("test-session");
    expect(stagedPostCompactionDelegateCount("test-session")).toBe(0);
  });
});
