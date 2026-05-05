import { describe, expect, it } from "vitest";
import {
  createPostCompactionLoopGuard,
  PostCompactionLoopPersistedError,
} from "./post-compaction-loop-guard.js";

function callOutcome(toolName: string, args: unknown, result: string) {
  return { toolName, argsHash: JSON.stringify(args), resultHash: result };
}

describe("createPostCompactionLoopGuard", () => {
  it("is dormant when never armed", () => {
    const guard = createPostCompactionLoopGuard();
    const verdict = guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(verdict.shouldAbort).toBe(false);
    expect(verdict.armed).toBe(false);
  });

  it("arms for the configured window after compaction", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 3 });
    guard.armPostCompaction();
    expect(guard.snapshot().armed).toBe(true);
    expect(guard.snapshot().remainingAttempts).toBe(3);
  });

  it("decrements remainingAttempts on each observation", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 3 });
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(guard.snapshot().remainingAttempts).toBe(2);
    guard.observe(callOutcome("read", { path: "/y" }, "r2"));
    expect(guard.snapshot().remainingAttempts).toBe(1);
    guard.observe(callOutcome("read", { path: "/z" }, "r3"));
    expect(guard.snapshot().remainingAttempts).toBe(0);
    expect(guard.snapshot().armed).toBe(false);
  });

  it("aborts on the windowSize-th identical (tool,args,result) call within the window", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 3 });
    guard.armPostCompaction();
    expect(
      guard.observe(callOutcome("gateway", { action: "lookup", path: "x" }, "r1")).shouldAbort,
    ).toBe(false);
    expect(
      guard.observe(callOutcome("gateway", { action: "lookup", path: "x" }, "r1")).shouldAbort,
    ).toBe(false);
    const third = guard.observe(callOutcome("gateway", { action: "lookup", path: "x" }, "r1"));
    expect(third.shouldAbort).toBe(true);
    if (third.shouldAbort) {
      expect(third.detector).toBe("compaction_loop_persisted");
      expect(third.count).toBe(3);
      expect(third.toolName).toBe("gateway");
    }
  });

  it("does NOT abort when the result hash changes (progress was made)", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 3 });
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    guard.observe(callOutcome("read", { path: "/x" }, "r2"));
    const third = guard.observe(callOutcome("read", { path: "/x" }, "r3"));
    expect(third.shouldAbort).toBe(false);
  });

  it("does NOT abort when the args hash changes", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 3 });
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/a" }, "r1"));
    guard.observe(callOutcome("read", { path: "/b" }, "r1"));
    const third = guard.observe(callOutcome("read", { path: "/c" }, "r1"));
    expect(third.shouldAbort).toBe(false);
  });

  it("does NOT abort outside the window", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 2 });
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(guard.snapshot().armed).toBe(false);
    const after = guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(after.shouldAbort).toBe(false);
  });

  it("re-arms when armPostCompaction is called again (multiple compactions per run)", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 2 });
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(guard.snapshot().armed).toBe(false);
    guard.armPostCompaction();
    expect(guard.snapshot().armed).toBe(true);
    expect(guard.snapshot().remainingAttempts).toBe(2);
  });

  it("respects the parent loop detection disabled state", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 3 }, { enabled: false });
    guard.armPostCompaction();
    guard.observe(callOutcome("gateway", { x: 1 }, "r1"));
    guard.observe(callOutcome("gateway", { x: 1 }, "r1"));
    const third = guard.observe(callOutcome("gateway", { x: 1 }, "r1"));
    expect(third.shouldAbort).toBe(false);
  });

  it("disarms after observing windowSize calls regardless of verdict", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 3 });
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/a" }, "r1"));
    guard.observe(callOutcome("write", { path: "/b" }, "r2"));
    guard.observe(callOutcome("exec", { cmd: "ls" }, "r3"));
    expect(guard.snapshot().armed).toBe(false);
    expect(guard.snapshot().remainingAttempts).toBe(0);
  });
});

describe("PostCompactionLoopPersistedError", () => {
  it("captures the detector, count, toolName, and message", () => {
    const err = new PostCompactionLoopPersistedError("loop persisted", {
      detector: "compaction_loop_persisted",
      count: 4,
      toolName: "gateway",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PostCompactionLoopPersistedError);
    expect(err.name).toBe("PostCompactionLoopPersistedError");
    expect(err.message).toBe("loop persisted");
    expect(err.detector).toBe("compaction_loop_persisted");
    expect(err.count).toBe(4);
    expect(err.toolName).toBe("gateway");
  });

  it("can be built from a guard verdict via fromVerdict", () => {
    const guard = createPostCompactionLoopGuard({ windowSize: 2 });
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    const verdict = guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(verdict.shouldAbort).toBe(true);
    if (!verdict.shouldAbort) {
      throw new Error("verdict was expected to abort");
    }
    const err = PostCompactionLoopPersistedError.fromVerdict(verdict);
    expect(err).toBeInstanceOf(PostCompactionLoopPersistedError);
    expect(err.detector).toBe(verdict.detector);
    expect(err.count).toBe(verdict.count);
    expect(err.toolName).toBe(verdict.toolName);
    expect(err.message).toBe(verdict.message);
  });
});
