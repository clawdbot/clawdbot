// Coverage for wiring the post-compaction loop guard into embedded runs.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  diagnosticSessionStates as DiagnosticSessionStatesType,
  getDiagnosticSessionState as GetDiagnosticSessionStateType,
  SessionState,
} from "../../logging/diagnostic-session-state.js";
import type {
  ToolOutcomeObserver,
  wrapToolWithBeforeToolCallHook as WrapToolWithBeforeToolCallHookType,
} from "../agent-tools.before-tool-call.js";
import type {
  recordToolCallOutcome as RecordToolCallOutcomeType,
  recordToolCall as RecordToolCallType,
} from "../tool-loop-detection.js";
import type { PostCompactionLoopPersistedError as PostCompactionLoopPersistedErrorType } from "./post-compaction-loop-guard.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  overflowBaseRunParams as baseParams,
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedRunEmbeddedAttempt,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;
// Import after loadRunOverflowCompactionHarness so these references point at the
// same module instances as the re-imported runner graph.
let diagnosticSessionStates: typeof DiagnosticSessionStatesType;
let getDiagnosticSessionState: typeof GetDiagnosticSessionStateType;
let recordToolCall: typeof RecordToolCallType;
let recordToolCallOutcome: typeof RecordToolCallOutcomeType;
let wrapToolWithBeforeToolCallHook: typeof WrapToolWithBeforeToolCallHookType;
let PostCompactionLoopPersistedError: typeof PostCompactionLoopPersistedErrorType;

// Mirror the production trim cap (resolveLoopDetectionConfig default
// historySize = 30). The trim is what makes the seq-based observation
// non-trivially better than an absolute index cursor.
const HISTORY_TRIM_CAP = 30;

function recordToolOutcome(
  state: SessionState,
  toolName: string,
  toolParams: unknown,
  result: unknown,
  runId?: string,
): void {
  // Seed diagnostic history directly for cases that inspect persisted loop
  // state without running a wrapped tool.
  const toolCallId = `${toolName}-${state.toolCallHistory?.length ?? 0}`;
  const scope = runId ? { runId } : undefined;
  recordToolCall(state, toolName, toolParams, toolCallId, undefined, scope);
  const outcome: Parameters<typeof recordToolCallOutcome>[1] = {
    toolName,
    toolParams,
    toolCallId,
    result,
  };
  if (runId) {
    outcome.runId = runId;
  }
  recordToolCallOutcome(state, outcome);
}

let liveToolCallSeq = 0;

async function executeWrappedToolOutcome(
  toolName: string,
  toolParams: unknown,
  result: unknown,
  onToolOutcome?: ToolOutcomeObserver,
  runId = baseParams.runId,
): Promise<unknown> {
  // Exercise the live before_tool_call wrapper so the guard sees the same
  // outcome observer path used by real embedded tools.
  const tool = wrapToolWithBeforeToolCallHook(
    {
      name: toolName,
      execute: vi.fn(async () => result),
    } as never,
    {
      agentId: "main",
      sessionKey: baseParams.sessionKey,
      sessionId: baseParams.sessionId,
      runId,
      onToolOutcome,
    },
  );
  liveToolCallSeq += 1;
  return tool.execute(`${toolName}-${liveToolCallSeq}`, toolParams, undefined, undefined);
}

describe("post-compaction loop guard wired into runEmbeddedAgent", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
    // Re-import after the harness reset so we share module instances with
    // the runner. The runner imports both modules through its own graph.
    ({ diagnosticSessionStates, getDiagnosticSessionState } =
      await import("../../logging/diagnostic-session-state.js"));
    ({ recordToolCall, recordToolCallOutcome } = await import("../tool-loop-detection.js"));
    ({ wrapToolWithBeforeToolCallHook } = await import("../agent-tools.before-tool-call.js"));
    ({ PostCompactionLoopPersistedError } = await import("./post-compaction-loop-guard.js"));
  });

  beforeEach(() => {
    liveToolCallSeq = 0;
    diagnosticSessionStates.clear();
    resetRunOverflowCompactionHarnessMocks();
    mockedIsCompactionFailureError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    });
    mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    });
  });

  it("aborts the attempt out-of-band when identical (tool, args, result) repeats windowSize times after compaction", async () => {
    const overflowError = makeOverflowError();
    let attemptReturned = false;
    let attemptSignalAborted = false;
    let attemptSignalReason: unknown;

    // Attempt 1: overflow triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({
        terminal: { kind: "failed", source: "prompt", error: overflowError },
      }),
    );
    // Attempt 2: live wrapped-tool outcomes repeat while the prompt is running.
    // The guard aborts the attempt signal, then the runner raises the loop error
    // after the attempt unwinds.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const { abortSignal, onToolOutcome } = attemptParams as {
        abortSignal?: AbortSignal;
        onToolOutcome?: ToolOutcomeObserver;
      };
      for (let i = 0; i < 3; i += 1) {
        await executeWrappedToolOutcome(
          "gateway",
          { action: "lookup", path: "x" },
          "identical-result",
          onToolOutcome,
        );
      }
      attemptSignalAborted = abortSignal?.aborted ?? false;
      attemptSignalReason = abortSignal?.reason;
      attemptReturned = true;
      return makeAttemptResult({
        toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    await expect(runEmbeddedAgent(baseParams)).rejects.toBeInstanceOf(
      PostCompactionLoopPersistedError,
    );

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptReturned).toBe(true);
    expect(attemptSignalAborted).toBe(true);
    expect(attemptSignalReason).toBeInstanceOf(PostCompactionLoopPersistedError);
  });

  it("releases the lane after a post-compaction abort when the backend ignores cancellation", async () => {
    vi.useFakeTimers();
    let settleIgnoredAttempt: ((value: ReturnType<typeof makeAttemptResult>) => void) | undefined;
    let resolveAttemptAborted: (() => void) | undefined;
    const attemptAbortedPromise = new Promise<void>((resolve) => {
      resolveAttemptAborted = resolve;
    });
    try {
      const overflowError = makeOverflowError();
      let attemptAborted = false;
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          terminal: { kind: "failed", source: "prompt", error: overflowError },
        }),
      );
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
        const { abortSignal, onToolOutcome } = attemptParams as {
          abortSignal?: AbortSignal;
          onToolOutcome?: ToolOutcomeObserver;
        };
        for (let i = 0; i < 3; i += 1) {
          await executeWrappedToolOutcome(
            "gateway",
            { action: "lookup", path: "x" },
            "identical-result",
            onToolOutcome,
          );
        }
        attemptAborted = abortSignal?.aborted ?? false;
        resolveAttemptAborted?.();
        return await new Promise((resolve) => {
          settleIgnoredAttempt = resolve;
        });
      });
      mockedCompactDirect.mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted session",
          firstKeptEntryId: "entry-5",
          tokensBefore: 150000,
        }),
      );

      const run = runEmbeddedAgent({
        ...baseParams,
        runId: "run-post-compaction-abort-lane-release",
        timeoutMs: 48 * 60 * 60 * 1000,
      });
      let settled = false;
      void run
        .finally(() => {
          settled = true;
        })
        .catch(() => {});

      await attemptAbortedPromise;
      expect(attemptAborted).toBe(true);
      await vi.advanceTimersByTimeAsync(30_001);

      expect(settled).toBe(true);
      await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    } finally {
      settleIgnoredAttempt?.(makeAttemptResult());
      vi.useRealTimers();
    }
  });

  it("keeps a native lane alive while a tool is still running", async () => {
    vi.useFakeTimers();
    let settleAttempt: ((value: ReturnType<typeof makeAttemptResult>) => void) | undefined;
    let resolveAttemptStarted: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => {
      resolveAttemptStarted = resolve;
    });
    try {
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
        const { onAttemptTimeoutArmed } = attemptParams as {
          onAttemptTimeoutArmed?: () => void;
        };
        resolveAttemptStarted?.();
        onAttemptTimeoutArmed?.();
        return await new Promise((resolve) => {
          settleAttempt = resolve;
        });
      });

      const run = runEmbeddedAgent({
        ...baseParams,
        runId: "run-native-tool-heartbeat",
        timeoutMs: 1,
        agentHarnessRuntimeOverride: "openclaw",
      });
      let settled = false;
      void run
        .finally(() => {
          settled = true;
        })
        .catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      await attemptStarted;
      await vi.advanceTimersByTimeAsync(30_001);

      expect(settled).toBe(false);
      settleAttempt?.(makeAttemptResult());
      await expect(run).resolves.toMatchObject({ meta: { aborted: false } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a native lane when a timed-out attempt ignores cancellation", async () => {
    vi.useFakeTimers();
    let settleAttempt: ((value: ReturnType<typeof makeAttemptResult>) => void) | undefined;
    let resolveAttemptStarted: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => {
      resolveAttemptStarted = resolve;
    });
    try {
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
        const { onAttemptTimeoutArmed, onAttemptTimeout } = attemptParams as {
          onAttemptTimeoutArmed?: () => void;
          onAttemptTimeout?: (reason: Error) => void;
        };
        resolveAttemptStarted?.();
        onAttemptTimeoutArmed?.();
        onAttemptTimeout?.(new Error("attempt timed out"));
        return await new Promise((resolve) => {
          settleAttempt = resolve;
        });
      });

      const run = runEmbeddedAgent({
        ...baseParams,
        runId: "run-native-timeout-lane-release",
        timeoutMs: 48 * 60 * 60 * 1000,
        agentHarnessRuntimeOverride: "openclaw",
      });
      let settled = false;
      void run
        .finally(() => {
          settled = true;
        })
        .catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      await attemptStarted;
      await vi.advanceTimersByTimeAsync(30_001);

      expect(settled).toBe(true);
      await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    } finally {
      settleAttempt?.(makeAttemptResult());
      vi.useRealTimers();
    }
  });

  it("releases a native lane when an explicit abort ignores cancellation", async () => {
    vi.useFakeTimers();
    let settleAttempt: ((value: ReturnType<typeof makeAttemptResult>) => void) | undefined;
    let resolveAttemptStarted: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => {
      resolveAttemptStarted = resolve;
    });
    try {
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
        const { onAttemptTimeoutArmed, onAttemptAbort } = attemptParams as {
          onAttemptTimeoutArmed?: () => void;
          onAttemptAbort?: () => void;
        };
        resolveAttemptStarted?.();
        onAttemptTimeoutArmed?.();
        onAttemptAbort?.();
        return await new Promise((resolve) => {
          settleAttempt = resolve;
        });
      });

      const run = runEmbeddedAgent({
        ...baseParams,
        runId: "run-native-abort-lane-release",
        timeoutMs: 48 * 60 * 60 * 1000,
        agentHarnessRuntimeOverride: "openclaw",
      });
      let settled = false;
      void run
        .finally(() => {
          settled = true;
        })
        .catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      await attemptStarted;
      await vi.advanceTimersByTimeAsync(30_001);

      expect(settled).toBe(true);
      await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    } finally {
      settleAttempt?.(makeAttemptResult());
      vi.useRealTimers();
    }
  });

  it("does not abort when the result hash changes across post-compaction attempts (progress was made)", async () => {
    const overflowError = makeOverflowError();
    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({
        terminal: { kind: "failed", source: "prompt", error: overflowError },
      }),
    );
    // Attempt 2 (post-compaction): identical args, but DIFFERENT result hash
    // each time. This fills the window without triggering the persisted-loop
    // abort because the tool is making progress.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (attemptParams as { onToolOutcome?: ToolOutcomeObserver })
        .onToolOutcome;
      for (let i = 0; i < 3; i += 1) {
        await executeWrappedToolOutcome(
          "gateway",
          { action: "lookup", path: "x" },
          `result-${i}`,
          onToolOutcome,
        );
      }
      return makeAttemptResult({
        toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);
    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("disarms after the built-in observation window, so later identical calls do not abort", async () => {
    const overflowError = makeOverflowError();

    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({
        terminal: { kind: "failed", source: "prompt", error: overflowError },
      }),
    );
    // Attempt 2 (post-compaction): three distinct records → window full,
    // guard disarms with no abort. We then append more identical records
    // afterwards in this test to confirm they are not observed by the guard.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (attemptParams as { onToolOutcome?: ToolOutcomeObserver })
        .onToolOutcome;
      await executeWrappedToolOutcome("read", { path: "/a" }, "ra", onToolOutcome);
      await executeWrappedToolOutcome("write", { path: "/b" }, "rb", onToolOutcome);
      await executeWrappedToolOutcome("read", { path: "/c" }, "rc", onToolOutcome);
      return makeAttemptResult({
        toolMetas: [{ toolName: "read" }, { toolName: "write" }, { toolName: "read" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not arm the post-compaction guard when loop detection is disabled", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({
        terminal: { kind: "failed", source: "prompt", error: overflowError },
      }),
    );
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (attemptParams as { onToolOutcome?: ToolOutcomeObserver })
        .onToolOutcome;
      for (let i = 0; i < 3; i += 1) {
        await executeWrappedToolOutcome(
          "gateway",
          { action: "lookup", path: "x" },
          "identical-result",
          onToolOutcome,
        );
      }
      return makeAttemptResult({
        toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent({
      ...baseParams,
      config: {
        tools: {
          loopDetection: {
            enabled: false,
          },
        },
      } as never,
    });

    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("aborts post-compaction loop from the live tool path even when toolCallHistory is at its trim cap", async () => {
    // Long-running sessions accumulate up to historySize (default 30) records
    // in toolCallHistory. The live observer must still see the new outcome
    // before trimming can make any after-attempt cursor ambiguous.
    const overflowError = makeOverflowError();
    const sessionState = getDiagnosticSessionState({
      sessionKey: baseParams.sessionKey,
      sessionId: baseParams.sessionId,
    });

    // Pre-fill history to the default trim cap with distinct entries that
    // pre-date the run. This puts the guard's cursor right at the trim
    // boundary before the post-compaction window opens.
    for (let i = 0; i < HISTORY_TRIM_CAP; i += 1) {
      recordToolOutcome(sessionState, "seed", { iter: i }, `seed-result-${i}`, baseParams.runId);
    }
    expect(sessionState.toolCallHistory?.length).toBe(HISTORY_TRIM_CAP);

    // Attempt 1: overflow -> triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({
        terminal: { kind: "failed", source: "prompt", error: overflowError },
      }),
    );
    // Attempt 2 (post-compaction): three identical live tool outcomes while
    // history is already at the cap. The guard aborts on the third result
    // before the mocked attempt can return.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (attemptParams as { onToolOutcome?: ToolOutcomeObserver })
        .onToolOutcome;
      for (let i = 0; i < 3; i += 1) {
        await executeWrappedToolOutcome(
          "gateway",
          { action: "lookup", path: "x" },
          "identical-result",
          onToolOutcome,
        );
      }
      // History is still capped at HISTORY_TRIM_CAP after the trim.
      expect(sessionState.toolCallHistory?.length).toBe(HISTORY_TRIM_CAP);
      return makeAttemptResult({
        toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    await expect(runEmbeddedAgent(baseParams)).rejects.toBeInstanceOf(
      PostCompactionLoopPersistedError,
    );

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });
});
