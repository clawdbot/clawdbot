import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  diagnosticSessionStates as DiagnosticSessionStatesType,
  getDiagnosticSessionState as GetDiagnosticSessionStateType,
  SessionState,
} from "../../logging/diagnostic-session-state.js";
import type {
  ToolOutcomeObserver,
  wrapToolWithBeforeToolCallHook as WrapToolWithBeforeToolCallHookType,
} from "../pi-tools.before-tool-call.js";
import type {
  recordToolCall as RecordToolCallType,
  recordToolCallOutcome as RecordToolCallOutcomeType,
} from "../tool-loop-detection.js";
import type { PostCompactionLoopPersistedError as PostCompactionLoopPersistedErrorType } from "./post-compaction-loop-guard.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedContextEngine,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedLog,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
// These need to be imported AFTER loadRunOverflowCompactionHarness so that
// they reference the same module instances the (re-imported) runner uses.
// vi.resetModules() inside the harness invalidates any earlier import.
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

describe("post-compaction loop guard wired into runEmbeddedPiAgent", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
    // Re-import after the harness reset so we share module instances with
    // the runner. The runner imports both modules through its own graph.
    ({ diagnosticSessionStates, getDiagnosticSessionState } =
      await import("../../logging/diagnostic-session-state.js"));
    ({ recordToolCall, recordToolCallOutcome } = await import("../tool-loop-detection.js"));
    ({ wrapToolWithBeforeToolCallHook } = await import("../pi-tools.before-tool-call.js"));
    ({ PostCompactionLoopPersistedError } = await import("./post-compaction-loop-guard.js"));
  });

  beforeEach(() => {
    liveToolCallSeq = 0;
    diagnosticSessionStates.clear();
    mockedRunEmbeddedAttempt.mockReset();
    mockedCompactDirect.mockReset();
    mockedSessionLikelyHasOversizedToolResults.mockReset();
    mockedTruncateOversizedToolResultsInSession.mockReset();
    mockedContextEngine.info.ownsCompaction = false;
    mockedLog.debug.mockReset();
    mockedLog.info.mockReset();
    mockedLog.warn.mockReset();
    mockedLog.error.mockReset();
    mockedLog.isEnabled.mockReset();
    mockedLog.isEnabled.mockReturnValue(false);
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
    mockedCompactDirect.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized tool results",
    });
  });

  it("aborts the attempt out-of-band when identical (tool, args, result) repeats windowSize times after compaction", async () => {
    const overflowError = makeOverflowError();
    let attemptReturned = false;
    let attemptSignalAborted = false;
    let attemptSignalReason: unknown;

    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
    );
    // Attempt 2: post-compaction. The live wrapped-tool path records each
    // outcome while the prompt is still running. The third identical result
    // must not rely on throwing out of tool execution (the dependency converts
    // tool errors into tool results); instead it aborts the attempt signal and
    // the runner raises the persisted-loop error after the attempt unwinds.
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
        promptError: null,
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

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toBeInstanceOf(
      PostCompactionLoopPersistedError,
    );

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptReturned).toBe(true);
    expect(attemptSignalAborted).toBe(true);
    expect(attemptSignalReason).toBeInstanceOf(PostCompactionLoopPersistedError);
  });

  it("does not abort when the result hash changes across post-compaction attempts (progress was made)", async () => {
    const overflowError = makeOverflowError();
    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
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
        promptError: null,
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

    const result = await runEmbeddedPiAgent(baseParams);
    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("disarms after windowSize observations regardless of match, so later identical calls do not abort", async () => {
    // Use windowSize: 2 so the guard disarms after 2 observations.
    const overflowError = makeOverflowError();

    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
    );
    // Attempt 2 (post-compaction): two distinct records → window full,
    // guard disarms with no abort. We then append more identical records
    // afterwards in this test to confirm they are not observed by the guard.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (attemptParams as { onToolOutcome?: ToolOutcomeObserver })
        .onToolOutcome;
      await executeWrappedToolOutcome("read", { path: "/a" }, "ra", onToolOutcome);
      await executeWrappedToolOutcome("write", { path: "/b" }, "rb", onToolOutcome);
      return makeAttemptResult({
        promptError: null,
        toolMetas: [{ toolName: "read" }, { toolName: "write" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      config: {
        tools: {
          loopDetection: {
            postCompactionGuard: { windowSize: 2 },
          },
        },
      } as never,
    });

    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("uses the active agent post-compaction guard window over the global default", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
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
        promptError: null,
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

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      agentId: "agent-a",
      config: {
        tools: {
          loopDetection: {
            postCompactionGuard: { windowSize: 2 },
          },
        },
        agents: {
          list: [
            {
              id: "agent-a",
              tools: {
                loopDetection: {
                  postCompactionGuard: { windowSize: 4 },
                },
              },
            },
          ],
        },
      } as never,
    });

    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not arm the post-compaction guard when loop detection is disabled", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
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
        promptError: null,
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

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      config: {
        tools: {
          loopDetection: {
            enabled: false,
            postCompactionGuard: { windowSize: 2 },
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
      makeAttemptResult({ promptError: overflowError }),
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
        promptError: null,
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

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toBeInstanceOf(
      PostCompactionLoopPersistedError,
    );

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });
});
