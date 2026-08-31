// Coverage for detecting repeated tool loops immediately after compaction.
import { beforeEach, describe, expect, it, vi } from "vitest";

const logInfo = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: logInfo,
    error: logError,
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  createPostCompactionLoopGuard,
  PostCompactionLoopPersistedError,
} from "./post-compaction-loop-guard.js";

function callOutcome(toolName: string, args: unknown, result: string) {
  // The guard compares stable hashes instead of full payloads to keep runtime
  // state bounded.
  return { toolName, argsHash: JSON.stringify(args), resultHash: result };
}

describe("createPostCompactionLoopGuard", () => {
  it("is dormant when never armed", () => {
    const guard = createPostCompactionLoopGuard();
    const verdict = guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(verdict.shouldAbort).toBe(false);
    expect(verdict.armed).toBe(false);
  });

  it("arms for the built-in window after compaction", () => {
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    expect(guard.snapshot().armed).toBe(true);
    expect(guard.snapshot().remainingAttempts).toBe(3);
  });

  it("decrements remainingAttempts on each observation", () => {
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(guard.snapshot().remainingAttempts).toBe(2);
    guard.observe(callOutcome("read", { path: "/y" }, "r2"));
    expect(guard.snapshot().remainingAttempts).toBe(1);
    guard.observe(callOutcome("read", { path: "/z" }, "r3"));
    expect(guard.snapshot().remainingAttempts).toBe(0);
    expect(guard.snapshot().armed).toBe(false);
  });

  it("aborts on the third identical (tool,args,result) call within the window", () => {
    // Repeating the same tool, args, and result right after compaction means the
    // model likely lost progress and is stuck replaying the same recovery step.
    const guard = createPostCompactionLoopGuard();
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
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    guard.observe(callOutcome("read", { path: "/x" }, "r2"));
    const third = guard.observe(callOutcome("read", { path: "/x" }, "r3"));
    expect(third.shouldAbort).toBe(false);
  });

  it("does NOT abort when the args hash changes", () => {
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/a" }, "r1"));
    guard.observe(callOutcome("read", { path: "/b" }, "r1"));
    const third = guard.observe(callOutcome("read", { path: "/c" }, "r1"));
    expect(third.shouldAbort).toBe(false);
  });

  it("does NOT abort outside the window", () => {
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(guard.snapshot().armed).toBe(true);
    guard.observe(callOutcome("read", { path: "/y" }, "r2"));
    expect(guard.snapshot().armed).toBe(false);
    const after = guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(after.shouldAbort).toBe(false);
  });

  it("re-arms when armPostCompaction is called again (multiple compactions per run)", () => {
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    guard.observe(callOutcome("read", { path: "/y" }, "r2"));
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
    expect(guard.snapshot().armed).toBe(false);
    guard.armPostCompaction();
    expect(guard.snapshot().armed).toBe(true);
    expect(guard.snapshot().remainingAttempts).toBe(3);
  });

  it("respects the parent loop detection disabled state", () => {
    const guard = createPostCompactionLoopGuard({ enabled: false });
    guard.armPostCompaction();
    guard.observe(callOutcome("gateway", { x: 1 }, "r1"));
    guard.observe(callOutcome("gateway", { x: 1 }, "r1"));
    const third = guard.observe(callOutcome("gateway", { x: 1 }, "r1"));
    expect(third.shouldAbort).toBe(false);
  });

  it("disarms after observing the built-in window regardless of verdict", () => {
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/a" }, "r1"));
    guard.observe(callOutcome("write", { path: "/b" }, "r2"));
    guard.observe(callOutcome("exec", { cmd: "ls" }, "r3"));
    expect(guard.snapshot().armed).toBe(false);
    expect(guard.snapshot().remainingAttempts).toBe(0);
  });
});

describe("post-compaction re-read instrumentation", () => {
  beforeEach(() => {
    logInfo.mockClear();
    logError.mockClear();
  });

  it("summarizes post-compaction re-reads against the pre-compaction baseline", () => {
    const guard = createPostCompactionLoopGuard();
    guard.observe(callOutcome("read", { path: "/report.md" }, "content-v1"));
    guard.observe(callOutcome("exec", { cmd: "ls" }, "ok"));
    guard.armPostCompaction();
    // The model immediately re-reads what compaction summarized away, then moves on.
    guard.observe(callOutcome("read", { path: "/report.md" }, "content-v2"));
    guard.observe(callOutcome("read", { path: "/other.md" }, "fresh"));
    const last = guard.observe(callOutcome("gateway", { action: "probe" }, "r1"));
    expect(last.shouldAbort).toBe(false);
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("post-compaction window closed"));
    const summary = logInfo.mock.calls
      .map((call) => call[0] as string)
      .find((message) => message.includes("post-compaction window closed"));
    expect(summary).toContain("toolCalls=3");
    expect(summary).toContain("preCompactionRepeats=1");
    expect(summary).toContain("read");
    expect(logError).not.toHaveBeenCalled();
  });

  it("reports zero re-reads when the window introduces only fresh calls", () => {
    const guard = createPostCompactionLoopGuard();
    guard.observe(callOutcome("read", { path: "/a.md" }, "v1"));
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/b.md" }, "v1"));
    guard.observe(callOutcome("read", { path: "/c.md" }, "v1"));
    guard.observe(callOutcome("exec", { cmd: "ls" }, "ok"));
    const summary = logInfo.mock.calls
      .map((call) => call[0] as string)
      .find((message) => message.includes("post-compaction window closed"));
    expect(summary).toContain("preCompactionRepeats=0");
  });

  it("does not count signatures evicted from the bounded baseline", () => {
    const guard = createPostCompactionLoopGuard();
    for (let i = 0; i < 20; i += 1) {
      guard.observe(callOutcome("read", { path: `/old-${i}.md` }, "v1"));
    }
    guard.armPostCompaction();
    // Signature from before the baseline window: no longer comparable.
    guard.observe(callOutcome("read", { path: "/old-0.md" }, "v2"));
    // Signature still inside the baseline window tail.
    guard.observe(callOutcome("read", { path: "/old-19.md" }, "v2"));
    guard.observe(callOutcome("gateway", { action: "probe" }, "r1"));
    const summary = logInfo.mock.calls
      .map((call) => call[0] as string)
      .find((message) => message.includes("post-compaction window closed"));
    expect(summary).toContain("toolCalls=3");
    expect(summary).toContain("preCompactionRepeats=1");
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
    const guard = createPostCompactionLoopGuard();
    guard.armPostCompaction();
    guard.observe(callOutcome("read", { path: "/x" }, "r1"));
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
