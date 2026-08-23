// Exercises harness lifecycle hook adapters and finalize-retry budget semantics.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
  runAgentHarnessBeforeAgentFinalizeHook,
  runAgentHarnessBeforeAgentRunHook,
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
  messages: [],
  success: true,
};

describe("agent harness lifecycle hook helpers", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.pluginFinalizeRetryBudget"));
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

  it("resolves after agent_end hooks settle", async () => {
    let releaseHook: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runAgentEnd: vi.fn(() => agentEndSettled),
    };

    const run = awaitAgentHarnessAgentEndHook({
      ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
      event: EVENT,
      hookRunner: hookRunner as never,
    });
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({ runId: "run-1", sessionKey: "agent:main:session-1" }),
      { unrefTimeout: false },
    );
    expect(resolved).toBe(false);
    releaseHook();
    await expect(run).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("can leave agent_end timeouts unref'd for fire-and-forget callers", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_end"),
      runAgentEnd: vi.fn(async () => undefined),
    };

    runAgentHarnessAgentEndHook({
      ctx: { runId: "run-1", sessionKey: "agent:main:session-1" },
      event: EVENT,
      hookRunner: hookRunner as never,
    });
    await Promise.resolve();

    expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
      EVENT,
      expect.objectContaining({ runId: "run-1", sessionKey: "agent:main:session-1" }),
      { unrefTimeout: true },
    );
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
    // retryCandidates is intentionally non-enumerable in production hook
    // results, so callers do not serialize internal retry bookkeeping.
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
    // Fallback keys include a digest of the full instruction. Prefix-only
    // truncation would spend unrelated long retry requests together.
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

describe("before_agent_run gate", () => {
  const GATE_EVENT = { prompt: "hello", systemPrompt: "system", messages: [] };

  it("proceeds when no runner advertises the gate", async () => {
    const hookRunner = { hasHooks: vi.fn(() => false), runBeforeAgentRun: vi.fn() };
    await expect(
      runAgentHarnessBeforeAgentRunHook({ event: GATE_EVENT, ctx: {}, hookRunner } as never),
    ).resolves.toEqual({ action: "proceed" });
    expect(hookRunner.runBeforeAgentRun).not.toHaveBeenCalled();
  });

  it("charges the gate once across re-dispatch sharing one run admission", async () => {
    const runBeforeAgentRun = vi.fn(async () => undefined);
    const hookRunner = { hasHooks: vi.fn(() => true), runBeforeAgentRun };
    const admission = {};
    const dispatch = async () =>
      await runAgentHarnessBeforeAgentRunHook({
        event: GATE_EVENT,
        ctx: { runId: "run-1" },
        hookRunner,
        admission,
      } as never);
    await expect(dispatch()).resolves.toEqual({ action: "proceed" });
    await expect(dispatch()).resolves.toEqual({ action: "proceed" });
    expect(runBeforeAgentRun).toHaveBeenCalledTimes(1);
  });

  it("replays the blocked decision across re-dispatch of one run", async () => {
    const runBeforeAgentRun = vi.fn(async () => ({
      decision: { outcome: "block", reason: "internal-detail", message: "nope" },
      pluginId: "guardrail",
    }));
    const hookRunner = { hasHooks: vi.fn(() => true), runBeforeAgentRun };
    const admission = {};
    const dispatch = async () =>
      await runAgentHarnessBeforeAgentRunHook({
        event: GATE_EVENT,
        ctx: { runId: "run-1" },
        hookRunner,
        admission,
      } as never);
    const first = await dispatch();
    const second = await dispatch();
    expect(second).toEqual(first);
    expect(second).toMatchObject({ action: "blocked", blockedBy: "guardrail" });
    expect(runBeforeAgentRun).toHaveBeenCalledTimes(1);
  });

  it("never carries a decision between logical runs that reuse one runId", async () => {
    const runBeforeAgentRun = vi.fn(async () => undefined);
    const hookRunner = { hasHooks: vi.fn(() => true), runBeforeAgentRun };
    // Two logical runs, same runId, one admission each: the memo is the run's
    // own object, so the second run must still be gated.
    for (const admission of [{}, {}]) {
      await runAgentHarnessBeforeAgentRunHook({
        event: GATE_EVENT,
        ctx: { runId: "run-1" },
        hookRunner,
        admission,
      } as never);
    }
    expect(runBeforeAgentRun).toHaveBeenCalledTimes(2);
  });

  it("gates every call when no run admission is supplied", async () => {
    const runBeforeAgentRun = vi.fn(async () => undefined);
    const hookRunner = { hasHooks: vi.fn(() => true), runBeforeAgentRun };
    for (let index = 0; index < 2; index += 1) {
      await runAgentHarnessBeforeAgentRunHook({
        event: GATE_EVENT,
        ctx: { runId: "run-1" },
        hookRunner,
      } as never);
    }
    expect(runBeforeAgentRun).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the gate is advertised but has no runner method", async () => {
    const hookRunner = { hasHooks: vi.fn(() => true) };
    await expect(
      runAgentHarnessBeforeAgentRunHook({ event: GATE_EVENT, ctx: {}, hookRunner } as never),
    ).resolves.toEqual({
      action: "blocked",
      blockedBy: "before_agent_run",
      message: "Your message could not be sent: blocked by before_agent_run",
    });
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("before_agent_run");
  });

  it.each([
    { label: "pass", result: { decision: { outcome: "pass" }, pluginId: "gate" } },
    { label: "void", result: undefined },
  ])("proceeds on a $label decision", async ({ result }) => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeAgentRun: vi.fn(async () => result),
    };
    await expect(
      runAgentHarnessBeforeAgentRunHook({ event: GATE_EVENT, ctx: {}, hookRunner } as never),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("blocks with the plugin attribution and never leaks the plugin-local reason", async () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeAgentRun: vi.fn(async () => ({
        decision: {
          outcome: "block",
          reason: "internal-policy-detail",
          message: "quota exhausted",
        },
        pluginId: "billing",
      })),
    };
    const outcome = await runAgentHarnessBeforeAgentRunHook({
      event: GATE_EVENT,
      ctx: {},
      hookRunner,
    } as never);
    expect(outcome).toEqual({
      action: "blocked",
      blockedBy: "billing",
      message: "Your message could not be sent: quota exhausted (blocked by billing)",
    });
    expect(JSON.stringify(outcome)).not.toContain("internal-policy-detail");
  });

  it("fails closed when the gate hook throws", async () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeAgentRun: vi.fn(async () => {
        throw new Error("gate exploded");
      }),
    };
    const outcome = await runAgentHarnessBeforeAgentRunHook({
      event: GATE_EVENT,
      ctx: {},
      hookRunner,
    } as never);
    expect(outcome).toEqual({
      action: "blocked",
      blockedBy: "before_agent_run",
      message: "Your message could not be sent: blocked by before_agent_run",
    });
  });

  it("hands hooks a bounded, isolated history snapshot", async () => {
    let observed: unknown[] = [];
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforeAgentRun: vi.fn(async (event: { messages: unknown[] }) => {
        observed = event.messages;
        (observed[0] as { content: string }).content = "mutated";
        return undefined;
      }),
    };
    const messages = Array.from({ length: 105 }, (_index, index) => ({
      role: "user",
      content: `message-${index}`,
    }));
    await runAgentHarnessBeforeAgentRunHook({
      event: { ...GATE_EVENT, messages },
      ctx: {},
      hookRunner,
    } as never);
    expect(observed).toHaveLength(100);
    expect((observed[0] as { content: string }).content).toBe("mutated");
    // Source history stays untouched: hooks never mutate the in-session copy.
    expect(messages[5]?.content).toBe("message-5");
    expect(messages.at(-1)?.content).toBe("message-104");
  });

  it("forwards trusted identity fields as hook-only evidence", async () => {
    const runBeforeAgentRun = vi.fn(
      async (_event: Record<string, unknown>, _ctx: Record<string, unknown>) => undefined,
    );
    await runAgentHarnessBeforeAgentRunHook({
      event: {
        ...GATE_EVENT,
        channelId: "telegram:1",
        accountId: "acct-1",
        senderId: "sender-1",
        senderIsOwner: true,
      },
      ctx: { runId: "run-1", agentId: "main" },
      hookRunner: { hasHooks: vi.fn(() => true), runBeforeAgentRun },
    } as never);
    expect(runBeforeAgentRun.mock.calls[0]?.[0]).toMatchObject({
      prompt: "hello",
      systemPrompt: "system",
      channelId: "telegram:1",
      accountId: "acct-1",
      senderId: "sender-1",
      senderIsOwner: true,
    });
    expect(runBeforeAgentRun.mock.calls[0]?.[1]).toMatchObject({ runId: "run-1", agentId: "main" });
  });
});
