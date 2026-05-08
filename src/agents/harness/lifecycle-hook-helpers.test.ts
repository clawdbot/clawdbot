import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentHarnessFinalizeRetryBudget,
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./lifecycle-hook-helpers.js";

const createLegacyHookRunner = () => ({
  hasHooks: vi.fn(() => true),
});

const EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  turnId: "turn-1",
  provider: "codex",
  model: "gpt-5.4",
  cwd: "/repo",
  transcriptPath: "/tmp/session.jsonl",
  stopHookActive: false,
  lastAssistantMessage: "done",
};

describe("agent harness lifecycle hook helpers", () => {
  afterEach(() => {
    clearAgentHarnessFinalizeRetryBudget();
  });

  it("ignores legacy hook runners that advertise llm_input without a runner method", () => {
    const hookRunner = createLegacyHookRunner();
    runAgentHarnessLlmInputHook({
      ctx: {},
      event: {},
      hookRunner,
    } as never);
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("llm_input");
  });

  it("ignores legacy hook runners that advertise llm_output without a runner method", () => {
    const hookRunner = createLegacyHookRunner();
    runAgentHarnessLlmOutputHook({
      ctx: {},
      event: {},
      hookRunner,
    } as never);
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("llm_output");
  });

  it("ignores legacy hook runners that advertise agent_end without a runner method", () => {
    const hookRunner = createLegacyHookRunner();
    runAgentHarnessAgentEndHook({
      ctx: {},
      event: {},
      hookRunner,
    } as never);
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("agent_end");
  });

  it("continues when legacy hook runners advertise before_agent_finalize without a runner method", async () => {
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        ctx: {},
        event: {},
        hookRunner: createLegacyHookRunner(),
      } as never),
    ).resolves.toEqual({ action: "continue" });
  });

  it("clears finalize retry budgets by run id", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "revise once",
          idempotencyKey: "stable",
          maxAttempts: 1,
        },
      }),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise once" });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "continue" });

    clearAgentHarnessFinalizeRetryBudget({ runId: "run-1" });

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise once" });
  });

  it("does not clear finalize retry budgets for runs that only share a prefix", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "revise child once",
          idempotencyKey: "stable",
          maxAttempts: 1,
        },
      }),
    };
    const childEvent = {
      ...EVENT,
      runId: "run:child",
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: childEvent,
        ctx: { runId: "run:child", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise child once" });

    clearAgentHarnessFinalizeRetryBudget({ runId: "run" });

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: childEvent,
        ctx: { runId: "run:child", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "continue" });
  });

  it("keys finalize retry budgets by context run id when the event omits run id", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "revise from context run",
          idempotencyKey: "stable",
          maxAttempts: 1,
        },
      }),
    };
    const eventWithoutRunId = {
      ...EVENT,
      runId: undefined,
      sessionId: "shared-session",
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: eventWithoutRunId,
        ctx: { runId: "run-from-context", sessionKey: "agent:main:shared-session" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise from context run" });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: eventWithoutRunId,
        ctx: { runId: "run-from-context", sessionKey: "agent:main:shared-session" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "continue" });

    clearAgentHarnessFinalizeRetryBudget({ runId: "run-from-context" });

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: eventWithoutRunId,
        ctx: { runId: "run-from-context", sessionKey: "agent:main:shared-session" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "revise", reason: "revise from context run" });
  });

  it("preserves merged revise reasons when retry metadata is present", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        reason: "fix generated baseline\n\nrerun the focused tests",
        retry: {
          instruction: "rerun the focused tests",
          idempotencyKey: "merged-reason",
          maxAttempts: 1,
        },
      }),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "fix generated baseline\n\nrerun the focused tests",
    });
  });

  it("honors a later finalize retry candidate after an earlier candidate is spent", async () => {
    const firstRetry = {
      instruction: "regenerate artifacts",
      idempotencyKey: "artifacts",
      maxAttempts: 1,
    };
    const secondRetry = {
      instruction: "rerun focused tests",
      idempotencyKey: "tests",
      maxAttempts: 1,
    };
    const result = {
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests",
      retry: firstRetry,
    };
    Object.defineProperty(result, "retryCandidates", {
      enumerable: false,
      value: [firstRetry, secondRetry],
    });
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue(result),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests\n\nregenerate artifacts",
    });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "retry generated artifacts\n\nretry focused tests\n\nrerun focused tests",
    });
  });

  it("falls back to retry instruction keys when retry idempotency keys are malformed", async () => {
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi.fn().mockResolvedValue({
        action: "revise",
        retry: {
          instruction: "retry with a safe key",
          idempotencyKey: { invalid: true },
          maxAttempts: 1,
        } as never,
      }),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: "retry with a safe key",
    });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({ action: "continue" });
  });

  it("does not collide fallback retry keys for long instructions with shared prefixes", async () => {
    const sharedPrefix = "x".repeat(180);
    const firstInstruction = `${sharedPrefix} first`;
    const secondInstruction = `${sharedPrefix} second`;
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentFinalize: vi
        .fn()
        .mockResolvedValueOnce({
          action: "revise",
          retry: {
            instruction: firstInstruction,
            idempotencyKey: { invalid: true },
            maxAttempts: 1,
          },
        })
        .mockResolvedValueOnce({
          action: "revise",
          retry: {
            instruction: secondInstruction,
            idempotencyKey: { invalid: true },
            maxAttempts: 1,
          },
        }),
    };

    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: firstInstruction,
    });
    await expect(
      runAgentHarnessBeforeAgentFinalizeHook({
        event: EVENT,
        ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
        hookRunner: hookRunner as never,
      }),
    ).resolves.toEqual({
      action: "revise",
      reason: secondInstruction,
    });
  });
});
