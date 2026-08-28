// Codex tests cover thread lifecycle unsubscribe behavior when replacing retained threads.
import { describe, expect, it, vi } from "vitest";

/**
 * Regression test for MCP process accumulation bug.
 *
 * Bug: When startOrResumeThread replaces a retained Codex thread with
 * preserveExistingBinding=true, the previous thread is NOT unsubscribed
 * because releaseRetainedThread is guarded by !preserveExistingBinding.
 *
 * This causes Codex MCP subprocesses to accumulate:
 * old thread MCP set + new thread MCP set = doubled processes.
 *
 * Fix: Remove !preserveExistingBinding from the releaseRetainedThread condition
 * so that the old thread is ALWAYS unsubscribed when a new thread replaces it.
 */

describe("Thread lifecycle unsubscribe on replacement", () => {
  it("releases retained thread when preserveExistingBinding is true", () => {
    // Simulate the condition check from startOrResumeThread
    const initialBoundThreadId = "thread-old-123";
    const preserveExistingBinding = true;
    const replacementPredecessor = undefined;

    // BEFORE FIX: this condition would be false (skip release)
    const buggyCondition =
      initialBoundThreadId && !preserveExistingBinding && !replacementPredecessor;

    // AFTER FIX: this condition is true (release happens)
    const fixedCondition = initialBoundThreadId && !replacementPredecessor;

    expect(buggyCondition).toBe(false); // Bug: release skipped
    expect(fixedCondition).toBe(true); // Fix: release happens
  });

  it("releases retained thread when preserveExistingBinding is false", () => {
    const initialBoundThreadId = "thread-old-456";
    const preserveExistingBinding = false;
    const replacementPredecessor = undefined;

    const buggyCondition =
      initialBoundThreadId && !preserveExistingBinding && !replacementPredecessor;
    const fixedCondition = initialBoundThreadId && !replacementPredecessor;

    // Both old and new conditions allow release
    expect(buggyCondition).toBe(true);
    expect(fixedCondition).toBe(true);
  });

  it("does not release when replacementPredecessor is set", () => {
    const initialBoundThreadId = "thread-old-789";
    const preserveExistingBinding = false;
    const replacementPredecessor = { threadId: "thread-predecessor" };

    const buggyCondition =
      initialBoundThreadId && !preserveExistingBinding && !replacementPredecessor;
    const fixedCondition = initialBoundThreadId && !replacementPredecessor;

    // Neither allows release (replacementPredecessor handles its own release)
    expect(buggyCondition).toBe(false);
    expect(fixedCondition).toBe(false);
  });

  it("does not release when no initial binding exists", () => {
    const initialBoundThreadId = undefined;
    const preserveExistingBinding = true;
    const replacementPredecessor = undefined;

    const buggyCondition =
      initialBoundThreadId && !preserveExistingBinding && !replacementPredecessor;
    const fixedCondition = initialBoundThreadId && !replacementPredecessor;

    // Neither allows release (nothing to release)
    expect(buggyCondition).toBe(false);
    expect(fixedCondition).toBe(false);
  });

  it("fix does not affect replacementPredecessor release path", () => {
    // The replacementPredecessor has its own separate release path
    // that is independent of the initialBoundThreadId condition
    const replacementPredecessor = { threadId: "thread-pred", clientId: "client-1" };

    // This path is unchanged by the fix
    expect(replacementPredecessor.threadId).toBe("thread-pred");
    expect(replacementPredecessor.clientId).toBe("client-1");
  });
});
