/**
 * Test: before_compaction & after_compaction hook wiring
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeCompaction: vi.fn(async () => {}),
    runAfterCompaction: vi.fn(async () => {}),
  },
  emitAgentEvent: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: hookMocks.emitAgentEvent,
  emitAgentEventIfCurrent: vi.fn(() => true),
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

import {
  handleCompactionEnd,
  handleCompactionStart,
} from "../agents/embedded-agent-subscribe.handlers.compaction.js";

describe("compaction hook wiring", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockClear();
    hookMocks.runner.runBeforeCompaction.mockResolvedValue(undefined);
    hookMocks.runner.runAfterCompaction.mockClear();
    hookMocks.runner.runAfterCompaction.mockResolvedValue(undefined);
    hookMocks.emitAgentEvent.mockClear();
  });

  function createCompactionEndCtx(params: {
    runId: string;
    messages?: unknown[];
    sessionFile?: string;
    sessionKey?: string;
    compactionCount?: number;
    withRetryHooks?: boolean;
    isTerminalAborted?: () => boolean;
  }) {
    return {
      params: {
        runId: params.runId,
        sessionKey: params.sessionKey,
        isTerminalAborted: params.isTerminalAborted,
        session: {
          messages: params.messages ?? [],
          sessionFile: params.sessionFile,
        },
      },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      incrementCompactionCount: vi.fn(),
      getCompactionCount: () => params.compactionCount ?? 0,
      noteCompactionTokensAfter: vi.fn(),
      getLastCompactionTokensAfter: vi.fn(() => undefined),
      ...(params.withRetryHooks
        ? {
            noteCompactionRetry: vi.fn(),
            resetForCompactionRetry: vi.fn(),
          }
        : {}),
    };
  }

  function getBeforeCompactionCall() {
    const beforeCalls = hookMocks.runner.runBeforeCompaction.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    return {
      event: beforeCalls[0]?.[0] as
        | { messageCount?: number; messages?: unknown[]; sessionFile?: string }
        | undefined,
      hookCtx: beforeCalls[0]?.[1] as { sessionKey?: string } | undefined,
    };
  }

  function getAfterCompactionCall() {
    const afterCalls = hookMocks.runner.runAfterCompaction.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    return {
      event: afterCalls[0]?.[0] as
        | { messageCount?: number; compactedCount?: number; sessionFile?: string }
        | undefined,
      hookCtx: afterCalls[0]?.[1] as { sessionKey?: string } | undefined,
    };
  }

  function expectCompactionEvent(params: {
    call: ReturnType<typeof getBeforeCompactionCall> | ReturnType<typeof getAfterCompactionCall>;
    expectedEvent: Record<string, unknown>;
    expectedSessionKey?: string;
  }) {
    expect(params.call.event).toEqual(params.expectedEvent);
    if (params.expectedSessionKey !== undefined) {
      if (!params.call.hookCtx) {
        throw new Error("Expected compaction hook context");
      }
      expect(params.call.hookCtx).toEqual({ sessionKey: params.expectedSessionKey });
    }
  }

  function runCompactionEnd(
    ctx: ReturnType<typeof createCompactionEndCtx> | Record<string, unknown>,
    event: {
      outcome:
        | { status: "completed"; tokensBefore: number; tokensAfter: number; willRetry: boolean }
        | { status: "skipped" | "failed"; reason: string }
        | { status: "aborted" };
    },
  ) {
    handleCompactionEnd(
      ctx as never,
      {
        type: "compaction_end",
        reason: "threshold",
        ...event,
      } as never,
    );
  }

  it("calls runBeforeCompaction in handleCompactionStart", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = {
      params: {
        runId: "r1",
        sessionKey: "agent:main:web-abc123",
        session: { messages: [1, 2, 3], sessionFile: "/tmp/test.jsonl" },
        onAgentEvent: vi.fn(),
      },
      state: { compactionInFlight: false },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      incrementCompactionCount: vi.fn(),
      ensureCompactionPromise: vi.fn(),
    };

    handleCompactionStart(ctx as never, { type: "compaction_start", reason: "threshold" });

    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expectCompactionEvent({
      call: getBeforeCompactionCall(),
      expectedEvent: {
        messageCount: 3,
        messages: [1, 2, 3],
        sessionFile: "/tmp/test.jsonl",
      },
      expectedSessionKey: "agent:main:web-abc123",
    });
    expect(ctx.ensureCompactionPromise).toHaveBeenCalledTimes(1);
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "r1",
      stream: "compaction",
      data: { phase: "start" },
    });
    expect(ctx.params.onAgentEvent).toHaveBeenCalledWith({
      stream: "compaction",
      data: { phase: "start" },
    });
  });

  it.each([false, true])(
    "retains completed compaction facts with terminalAborted=%s",
    (terminalAborted) => {
      hookMocks.runner.hasHooks.mockReturnValue(true);

      const ctx = createCompactionEndCtx({
        runId: "r2",
        messages: [1, 2],
        sessionFile: "/tmp/session.jsonl",
        sessionKey: "agent:main:web-xyz",
        compactionCount: 1,
        isTerminalAborted: () => terminalAborted,
      });

      runCompactionEnd(ctx, {
        outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: false },
      });

      expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
      expect(ctx.noteCompactionTokensAfter).toHaveBeenCalledWith(50);
      expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
      expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
        runId: "r2",
        stream: "compaction",
        data: {
          phase: "end",
          outcome: "completed",
          willRetry: false,
          completed: true,
        },
      });
      expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(terminalAborted ? 0 : 1);
      if (!terminalAborted) {
        expectCompactionEvent({
          call: getAfterCompactionCall(),
          expectedEvent: {
            messageCount: 2,
            compactedCount: 1,
            sessionFile: "/tmp/session.jsonl",
          },
          expectedSessionKey: "agent:main:web-xyz",
        });
      }
    },
  );

  it("does not call runAfterCompaction when willRetry is true but still increments counter", () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const ctx = createCompactionEndCtx({
      runId: "r3",
      compactionCount: 1,
      withRetryHooks: true,
    });

    runCompactionEnd(ctx, {
      outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
    });

    expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
    // Counter is incremented even with willRetry — compaction succeeded (#38905)
    expect(ctx.incrementCompactionCount).toHaveBeenCalledTimes(1);
    expect(ctx.noteCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.resetForCompactionRetry).toHaveBeenCalledTimes(1);
    expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "r3",
      stream: "compaction",
      data: {
        phase: "end",
        outcome: "completed",
        willRetry: true,
        completed: true,
      },
    });
  });

  it.each([
    { status: "aborted" },
    { status: "skipped", reason: "Nothing to compact (session too small)" },
    { status: "failed", reason: "Summary generation failed" },
  ] as const)("keeps $status compaction observable without success hooks", (outcome) => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const ctx = createCompactionEndCtx({ runId: "r3c" });

    runCompactionEnd(ctx, { outcome });

    expect(ctx.incrementCompactionCount).not.toHaveBeenCalled();
    expect(ctx.noteCompactionTokensAfter).not.toHaveBeenCalled();
    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledOnce();
    expect(hookMocks.emitAgentEvent).toHaveBeenCalledWith({
      runId: "r3c",
      stream: "compaction",
      data: expect.objectContaining({
        phase: "end",
        outcome: outcome.status,
        completed: false,
        willRetry: false,
      }),
    });
    expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
  });

  it("retains queued compaction facts without starting hooks after unsubscribe", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const flushStarted = createDeferred();
    const flush = createDeferred();
    const onAgentEvent = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-compaction-hook-after-unsubscribe",
      sessionExtras: { messages: [] },
      blockReplyBreak: "message_end",
      onBlockReplyFlush: () => {
        flushStarted.resolve();
        return flush.promise;
      },
      onAgentEvent,
    });
    try {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Previous reply" }],
          stopReason: "stop",
        },
      });
      await flushStarted.promise;
      emit({
        type: "compaction_end",
        reason: "threshold",
        outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: false },
      });
      expect(subscription.getCompactionCount()).toBe(0);
      expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();

      // The end event is already queued behind delivery when teardown closes the subscription.
      subscription.unsubscribe();
      flush.resolve();
      await subscription.waitForPendingEvents();

      expect(subscription.getCompactionCount()).toBe(1);
      expect(subscription.getLastCompactionTokensAfter()).toBe(50);
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "compaction",
        data: { phase: "end", outcome: "completed", completed: true, willRetry: false },
      });
      expect(hookMocks.runner.runAfterCompaction).not.toHaveBeenCalled();
    } finally {
      flush.resolve();
      subscription.unsubscribe();
      await subscription.waitForPendingEvents();
    }
  });

  it("resets stale assistant usage after final compaction", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "response one",
        usage: { totalTokens: 180_000, input: 100, output: 50 },
      },
      {
        role: "assistant",
        content: "response two",
        usage: { totalTokens: 181_000, input: 120, output: 60 },
      },
    ];

    const ctx = {
      params: { runId: "r4", session: { messages } },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      maybeResolveCompactionWait: vi.fn(),
      getCompactionCount: () => 1,
      incrementCompactionCount: vi.fn(),
      noteCompactionTokensAfter: vi.fn(),
      getLastCompactionTokensAfter: vi.fn(() => undefined),
    };

    runCompactionEnd(ctx, {
      outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: false },
    });

    const assistantOne = messages[1] as { usage?: unknown };
    const assistantTwo = messages[2] as { usage?: unknown };
    expect(assistantOne.usage).toEqual(makeZeroUsageSnapshot());
    expect(assistantTwo.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("does not clear assistant usage while compaction is retrying", () => {
    const messages = [
      {
        role: "assistant",
        content: "response",
        usage: { totalTokens: 184_297, input: 130_000, output: 2_000 },
      },
    ];

    const ctx = {
      params: { runId: "r5", session: { messages } },
      state: { compactionInFlight: true },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      noteCompactionRetry: vi.fn(),
      resetForCompactionRetry: vi.fn(),
      incrementCompactionCount: vi.fn(),
      getCompactionCount: () => 0,
      noteCompactionTokensAfter: vi.fn(),
    };

    runCompactionEnd(ctx, {
      outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
    });

    const assistant = messages[0] as { usage?: unknown };
    expect(assistant.usage).toEqual({ totalTokens: 184_297, input: 130_000, output: 2_000 });
  });
});
