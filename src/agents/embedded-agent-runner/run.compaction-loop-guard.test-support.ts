// Full-entry coverage for wiring the post-compaction loop guard into embedded runs.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedCompactDirect,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let baseParams: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>["runParams"];
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
// Import after the shared harness loads so these references point at the
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
  diagnosticState: SessionState,
  toolName: string,
  toolParams: unknown,
  result: unknown,
  runId?: string,
): void {
  // Seed diagnostic history directly for cases that inspect persisted loop
  // state without running a wrapped tool.
  const toolCallId = `${toolName}-${diagnosticState.toolCallHistory?.length ?? 0}`;
  const scope = runId ? { runId } : undefined;
  recordToolCall(diagnosticState, toolName, toolParams, toolCallId, undefined, scope);
  const outcome: Parameters<typeof recordToolCallOutcome>[1] = {
    toolName,
    toolParams,
    toolCallId,
    result,
  };
  if (runId) {
    outcome.runId = runId;
  }
  recordToolCallOutcome(diagnosticState, outcome);
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
  let queuedTasks: Promise<unknown>[];
  let pendingTasks: Set<Promise<unknown>>;
  let restoreQueueObserver: (() => void) | undefined;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    // Re-import after the harness reset so we share module instances with
    // the runner. The runner imports both modules through its own graph.
    ({ diagnosticSessionStates, getDiagnosticSessionState } =
      await import("../../logging/diagnostic-session-state.js"));
    ({ recordToolCall, recordToolCallOutcome } = await import("../tool-loop-detection.js"));
    ({ wrapToolWithBeforeToolCallHook } = await import("../agent-tools.before-tool-call.js"));
    ({ PostCompactionLoopPersistedError } = await import("./post-compaction-loop-guard.js"));
  });

  beforeEach(async () => {
    liveToolCallSeq = 0;
    diagnosticSessionStates.clear();
    resetSharedRunIntegrationHarnessMocks();
    session = await createSharedRunIntegrationSession();
    baseParams = session.runParams;
    const queue = await import("../../process/command-queue.js");
    const enqueue = queue.enqueueCommandInLane;
    queuedTasks = [];
    pendingTasks = new Set();
    // Observe the callback, not the caller's timeout race. Delegate unchanged so
    // the real queue still owns scheduling, errors and AsyncLocalStorage capture.
    const observe: typeof enqueue = (lane, task, options) =>
      enqueue(
        lane,
        (marker) => {
          const work = task(marker);
          queuedTasks.push(work);
          pendingTasks.add(work);
          void work.then(
            () => pendingTasks.delete(work),
            () => pendingTasks.delete(work),
          );
          return work;
        },
        options,
      );
    const spy = vi.spyOn(queue, "enqueueCommandInLane").mockImplementation(observe);
    restoreQueueObserver = () => spy.mockRestore();
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

  afterEach(async () => {
    // The ignored backend must settle before canonical cleanup removes its files.
    // If this join fails, leave the fixture owned by the proof process.
    try {
      await Promise.allSettled(queuedTasks);
      expect(queuedTasks.length, "post-reset queue observer captured actual work").toBeGreaterThan(
        0,
      );
      expect(pendingTasks.size).toBe(0);
      await session?.cleanup();
    } finally {
      restoreQueueObserver?.();
    }
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

    await expect(runEmbeddedAgent(session.runParams)).rejects.toBeInstanceOf(
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
    const ignoredAttempt = createDeferred<ReturnType<typeof makeAttemptResult>>();
    let run: ReturnType<typeof runEmbeddedAgent> | undefined;
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
        return await ignoredAttempt.promise;
      });
      mockedCompactDirect.mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted session",
          firstKeptEntryId: "entry-5",
          tokensBefore: 150000,
        }),
      );

      run = runEmbeddedAgent({
        ...session.runParams,
        runId: "run-post-compaction-abort-lane-release",
        timeoutMs: 48 * 60 * 60 * 1000,
      });
      let settled = false;
      void run
        .finally(() => {
          settled = true;
        })
        .catch(() => {});

      await Promise.race([attemptAbortedPromise, run]);
      expect(attemptAborted).toBe(true);
      await vi.advanceTimersByTimeAsync(30_001);

      expect(settled).toBe(true);
      expect(pendingTasks.size, "backend still runs after the outer timeout").toBeGreaterThan(0);
      await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    } finally {
      ignoredAttempt.resolve(makeAttemptResult());
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "keeps cold runtime acquisition outside execution budget (stop=%s)",
    async (stop) => {
      vi.useFakeTimers();
      const acquisitionStarted = createDeferred();
      const resumeAcquisition = createDeferred();
      const parent = new AbortController();
      const acquire = mockedAcquireAgentRunPreparedModelRuntime.getMockImplementation();
      if (!acquire) {
        throw new Error("Missing prepared runtime fixture");
      }
      let acquisitionSignal: AbortSignal | undefined;
      mockedAcquireAgentRunPreparedModelRuntime.mockImplementationOnce(
        async (input, options?: { abortSignal?: AbortSignal }) => {
          acquisitionSignal = options?.abortSignal;
          acquisitionStarted.resolve();
          await resumeAcquisition.promise;
          acquisitionSignal?.throwIfAborted();
          return await acquire(input);
        },
      );
      if (!stop) {
        mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
      }
      const run = runEmbeddedAgent({
        ...baseParams,
        runId: `run-cold-acquisition-${stop}`,
        timeoutMs: 1,
        abortSignal: parent.signal,
      });
      let settled = false;
      const observed = run
        .finally(() => {
          settled = true;
        })
        .catch((error: unknown) => error);
      try {
        await Promise.race([acquisitionStarted.promise, run]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
        if (stop) {
          parent.abort(new Error("stopped during preparation"));
          expect(acquisitionSignal?.aborted).toBe(true);
        }
        resumeAcquisition.resolve();
        if (stop) {
          await expect(run).rejects.toThrow("stopped during preparation");
          expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
        } else {
          await run;
          expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
        }
      } finally {
        resumeAcquisition.resolve();
        await observed;
        vi.useRealTimers();
      }
    },
  );

  it("enforces the runtime deadline after a paused built-in attempt resumes", async () => {
    vi.useFakeTimers();
    const heldAttempt = createDeferred<ReturnType<typeof makeAttemptResult>>();
    const attemptStarted = createDeferred();
    let run: ReturnType<typeof runEmbeddedAgent> | undefined;
    let publishDeadline: EmbeddedRunAttemptParams["onAttemptDeadlineChanged"];
    let attemptSignal: AbortSignal | undefined;
    try {
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
        const params = attemptParams as EmbeddedRunAttemptParams;
        publishDeadline = params.onAttemptDeadlineChanged;
        attemptSignal = params.abortSignal;
        // The legacy notification must not substitute a heartbeat for the owner's deadline.
        params.onAttemptTimeoutArmed?.();
        publishDeadline?.({ kind: "unlimited" });
        attemptStarted.resolve();
        return await heldAttempt.promise;
      });

      run = runEmbeddedAgent({
        ...baseParams,
        runId: "run-builtin-deadline-handoff",
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
      await Promise.race([attemptStarted.promise, run]);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);

      publishDeadline?.({ kind: "bounded", deadlineAtMs: Date.now() + 10 });
      await vi.advanceTimersByTimeAsync(30_011);
      expect(settled).toBe(true);
      expect(pendingTasks.size, "backend still runs after the owner deadline").toBeGreaterThan(0);
      expect(attemptSignal?.aborted).toBe(true);
      expect(attemptSignal?.reason).toMatchObject({ name: "CommandLaneTaskTimeoutError" });
      await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    } finally {
      heldAttempt.resolve(makeAttemptResult());
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("releases a native lane when a timed-out attempt ignores cancellation", async () => {
    vi.useFakeTimers();
    const heldAttempt = createDeferred<ReturnType<typeof makeAttemptResult>>();
    let run: ReturnType<typeof runEmbeddedAgent> | undefined;
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
        return await heldAttempt.promise;
      });

      run = runEmbeddedAgent({
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
      expect(pendingTasks.size, "backend still runs after the outer timeout").toBeGreaterThan(0);
      await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    } finally {
      heldAttempt.resolve(makeAttemptResult());
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("releases a native lane when an explicit abort ignores cancellation", async () => {
    vi.useFakeTimers();
    const heldAttempt = createDeferred<ReturnType<typeof makeAttemptResult>>();
    let run: ReturnType<typeof runEmbeddedAgent> | undefined;
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
        return await heldAttempt.promise;
      });

      run = runEmbeddedAgent({
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
      expect(pendingTasks.size, "backend still runs after the outer timeout").toBeGreaterThan(0);
      await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    } finally {
      heldAttempt.resolve(makeAttemptResult());
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
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
      ...session.runParams,
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

    await expect(runEmbeddedAgent(session.runParams)).rejects.toBeInstanceOf(
      PostCompactionLoopPersistedError,
    );

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });
});
