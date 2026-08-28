import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitContinuationCompactionReleasedSpan,
  resetContinuationTracer,
  setContinuationTracer,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "../../infra/continuation-tracer.js";
import {
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import {
  createRequestCompactionTool,
  _resetGuardState,
  _resetVolitionalCounts,
  _setPending,
  _guards,
  getVolitionalCompactionCount,
  incrementVolitionalCompactionCount,
  type RequestCompactionToolOpts,
} from "./request-compaction-tool.js";

const ACTIVE_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";
const ACTIVE_TRACE_CONTEXT: DiagnosticTraceContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: "00",
};

type RecordedSpan = {
  name: string;
  options?: StartSpanOptions;
  statusCalls: Array<{ status: SpanStatus; message?: string }>;
  ended: boolean;
};

function createRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, options?: StartSpanOptions): Span {
      const span: RecordedSpan = {
        name,
        options,
        statusCalls: [],
        ended: false,
      };
      spans.push(span);
      return {
        setAttributes(_attrs: SpanAttributes): void {},
        setStatus(status: SpanStatus, message?: string): void {
          span.statusCalls.push({ status, message });
        },
        recordException(): void {},
        end(): void {
          span.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

describe("request_compaction tool", () => {
  const SESSION_KEY = "test-session";
  const SESSION_ID = "session-uuid-1234";

  let contextUsage: number;
  let mockTriggerCompaction: ReturnType<
    typeof vi.fn<RequestCompactionToolOpts["triggerCompaction"]>
  >;
  let mockEnqueueSystemEvent: ReturnType<
    typeof vi.fn<NonNullable<RequestCompactionToolOpts["enqueueSystemEvent"]>>
  >;

  function makeOpts(overrides?: Partial<RequestCompactionToolOpts>): RequestCompactionToolOpts {
    return {
      agentSessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      getContextUsage: () => contextUsage,
      triggerCompaction: mockTriggerCompaction,
      enqueueSystemEvent: mockEnqueueSystemEvent,
      ...overrides,
    };
  }

  function makeTool(overrides?: Partial<RequestCompactionToolOpts>) {
    return createRequestCompactionTool(makeOpts(overrides));
  }

  async function executeTool(
    tool: ReturnType<typeof createRequestCompactionTool>,
    args: Record<string, unknown> = { reason: "test compaction request" },
  ) {
    return (await tool.execute("call-1", args))?.details as Record<string, unknown>;
  }

  async function flushBackgroundCompaction(): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  beforeEach(() => {
    contextUsage = 0.85; // above threshold by default
    _resetGuardState();
    _resetVolitionalCounts();
    mockTriggerCompaction = vi.fn().mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "Session compacted successfully with key decisions preserved.",
        firstKeptEntryId: "entry-42",
        tokensBefore: 850_000,
        tokensAfter: 120_000,
      },
    });
    mockEnqueueSystemEvent = vi.fn();
  });

  afterEach(async () => {
    await flushBackgroundCompaction();
    _resetGuardState();
    _resetVolitionalCounts();
    resetContinuationTracer();
    resetDiagnosticTraceContextForTest();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Precondition errors
  // -------------------------------------------------------------------------

  it("throws when no session key is provided", async () => {
    const tool = makeTool({ agentSessionKey: undefined });
    await expect(tool.execute("call-1", {})).rejects.toThrow(/requires an active session/);
  });

  it("throws when no session id is provided", async () => {
    const tool = makeTool({ sessionId: undefined });
    await expect(tool.execute("call-1", {})).rejects.toThrow(/requires a sessionId/);
  });

  // -------------------------------------------------------------------------
  // Guard: context threshold
  // -------------------------------------------------------------------------

  it("rejects when context usage is below threshold", async () => {
    contextUsage = 0.5;
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({
      status: "rejected",
      guard: "context_threshold",
      contextUsage: 50,
      threshold: _guards.MIN_CONTEXT_THRESHOLD * 100,
    });
    expect(mockTriggerCompaction).not.toHaveBeenCalled();
  });

  it("accepts when context usage is exactly at threshold", async () => {
    contextUsage = _guards.MIN_CONTEXT_THRESHOLD;
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Guard: rate limit
  // -------------------------------------------------------------------------

  it("rejects a second request within the rate limit window", async () => {
    const tool = makeTool();

    // First call succeeds
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });
    await flushBackgroundCompaction();

    // Second call within 5 minutes is rate-limited
    const second = await executeTool(tool);
    expect(second).toMatchObject({
      status: "rejected",
      guard: "rate_limit",
    });
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(1);
  });

  it("allows a request after the rate limit window expires", async () => {
    const tool = makeTool();

    let fakeNow = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    // First call
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });
    await flushBackgroundCompaction();

    // Advance past rate limit
    fakeNow += _guards.RATE_LIMIT_MS + 1;

    const second = await executeTool(tool);
    expect(second).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it("keeps same-turn duplicate requests pending until successful compaction arms cooldown", async () => {
    let resolveCompaction!: () => void;
    mockTriggerCompaction.mockReturnValue(
      new Promise<{ ok: boolean; compacted: boolean }>((resolve) => {
        resolveCompaction = () => resolve({ ok: true, compacted: true });
      }),
    );

    const tool = makeTool();
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    const second = await executeTool(tool);
    expect(second).toMatchObject({ status: "already_pending" });

    resolveCompaction();
    await flushBackgroundCompaction();

    const third = await executeTool(tool);
    expect(third).toMatchObject({
      status: "rejected",
      guard: "rate_limit",
    });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(1);
  });

  it("does not arm cooldown when background compaction resolves as a failure", async () => {
    mockTriggerCompaction
      .mockResolvedValueOnce({ ok: false, compacted: false, reason: "lane_contention" })
      .mockResolvedValueOnce({ ok: true, compacted: true });

    const tool = makeTool();
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });
    await flushBackgroundCompaction();

    const second = await executeTool(tool);
    expect(second).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(2);
    expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        "Your evacuated state was NOT compacted. Staged post-compaction delegates remain pending.",
      ),
      { sessionKey: SESSION_KEY },
    );
  });

  it("does not arm cooldown when background compaction rejects", async () => {
    mockTriggerCompaction
      .mockRejectedValueOnce(new Error("Lane contention timeout"))
      .mockResolvedValueOnce({ ok: true, compacted: true });

    const tool = makeTool();
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });
    await flushBackgroundCompaction();

    const second = await executeTool(tool);
    expect(second).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(2);
    expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Volitional compaction request"),
      { sessionKey: SESSION_KEY },
    );
    expect(mockEnqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Lane contention timeout"),
      { sessionKey: SESSION_KEY },
    );
  });

  // -------------------------------------------------------------------------
  // No generation guard; per docs/design/continue-work-signal-v2.md,
  // compaction is not blocked by unrelated channel activity.
  // -------------------------------------------------------------------------

  it("proceeds regardless of session generation drift", async () => {
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Async fire-and-forget
  // -------------------------------------------------------------------------

  it("returns compaction_requested immediately without awaiting compaction", async () => {
    // triggerCompaction returns a promise that never resolves — tool should
    // still return immediately because it does not await.
    let resolveCompaction!: () => void;
    mockTriggerCompaction.mockReturnValue(
      new Promise<{ ok: boolean; compacted: boolean }>((resolve) => {
        resolveCompaction = () => resolve({ ok: true, compacted: true });
      }),
    );

    const tool = makeTool();
    const result = await executeTool(tool);

    // Tool returned before compaction completed
    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledOnce();

    // Clean up the dangling promise
    resolveCompaction();
  });

  it("logs errors from background compaction without crashing the tool", async () => {
    mockTriggerCompaction.mockRejectedValue(new Error("Lane contention timeout"));

    const tool = makeTool();
    const result = await executeTool(tool);

    // Tool still returns success — the error is handled in the background
    expect(result).toMatchObject({ status: "compaction_requested" });

    // Let the rejection propagate through the microtask queue
    await vi.waitFor(() => {
      expect(mockTriggerCompaction).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Reason parameter
  // -------------------------------------------------------------------------

  it("passes through the reason parameter in the result", async () => {
    const tool = makeTool();
    const result = await executeTool(tool, { reason: "thermal evacuation complete" });

    expect(result).toMatchObject({
      status: "compaction_requested",
      reason: "thermal evacuation complete",
    });
  });

  it("threads focus to the compaction customInstructions slot", async () => {
    const tool = makeTool();
    const result = await executeTool(tool, {
      reason: "thermal evacuation complete",
      focus: "preserve the b683 fix-spec and the open path-b question",
    });
    await flushBackgroundCompaction();

    expect(result).toMatchObject({
      status: "compaction_requested",
      reason: "thermal evacuation complete",
    });
    expect(mockTriggerCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "thermal evacuation complete",
        customInstructions: "preserve the b683 fix-spec and the open path-b question",
      }),
    );
  });

  it("does not expose diagnostic traceparent as a model-facing parameter", () => {
    const tool = makeTool();

    expect(JSON.stringify(tool.parameters)).not.toContain("traceparent");
  });

  it("keeps traceparent absent when the optional carrier is omitted", async () => {
    const tool = makeTool();

    const result = await executeTool(tool, {
      reason: "thermal evacuation complete",
    });
    await flushBackgroundCompaction();

    expect(mockTriggerCompaction).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceparent: expect.any(String) }),
    );
    expect(result).toMatchObject({
      status: "compaction_requested",
      trigger: "volitional",
      reason: "thermal evacuation complete",
    });
    expect(result).not.toHaveProperty("traceparent");
  });

  it("threads the active runtime trace context into the compaction span", async () => {
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);
    mockTriggerCompaction.mockImplementation(async (request) => {
      emitContinuationCompactionReleasedSpan({
        releasedCount: 0,
        compactionId: 0,
        traceparent: request.traceparent,
      });
      return { ok: true, compacted: true };
    });
    const tool = makeTool();

    const result = await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      executeTool(tool, {
        reason: "thermal evacuation complete",
      }),
    );
    await flushBackgroundCompaction();

    expect(mockTriggerCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "thermal evacuation complete",
        traceparent: ACTIVE_TRACEPARENT,
      }),
    );
    expect(result).toMatchObject({
      status: "compaction_requested",
      trigger: "volitional",
    });
    expect(result).not.toHaveProperty("traceparent");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "continuation.compaction.released",
      options: { traceparent: ACTIVE_TRACEPARENT },
      statusCalls: [{ status: "OK", message: undefined }],
      ended: true,
    });
  });

  it("truncates long reasons to 1024 characters", async () => {
    const tool = makeTool();
    const longReason = "x".repeat(2000);
    const result = await executeTool(tool, { reason: longReason });

    expect((result.reason as string).length).toBe(1024);
  });

  // -------------------------------------------------------------------------
  // Collision edge cases (Trigger dedup)
  // -------------------------------------------------------------------------

  it("two request_compaction calls in same turn — second is already pending", async () => {
    let resolveCompaction!: () => void;
    mockTriggerCompaction.mockReturnValue(
      new Promise<{ ok: boolean; compacted: boolean }>((resolve) => {
        resolveCompaction = () => resolve({ ok: true, compacted: true });
      }),
    );
    const tool = makeTool();

    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    // Second call in same turn
    const second = await executeTool(tool);
    expect(second).toMatchObject({
      status: "already_pending",
    });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(1);

    resolveCompaction();
  });

  it("request_compaction below 70% is rejected", async () => {
    contextUsage = 0.69;
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({
      status: "rejected",
      guard: "context_threshold",
    });
  });

  // -------------------------------------------------------------------------
  // Guard isolation per session
  // -------------------------------------------------------------------------

  it("rate limits are per-session, not global", async () => {
    const toolA = makeTool({ agentSessionKey: "session-a" });
    const toolB = makeTool({ agentSessionKey: "session-b" });

    // Session A compacts
    const resultA = await executeTool(toolA);
    expect(resultA).toMatchObject({ status: "compaction_requested" });

    // Session B can still compact
    const resultB = await executeTool(toolB);
    expect(resultB).toMatchObject({ status: "compaction_requested" });
    await flushBackgroundCompaction();

    // Session A is rate-limited
    const resultA2 = await executeTool(toolA);
    expect(resultA2).toMatchObject({ status: "rejected", guard: "rate_limit" });
  });

  // -------------------------------------------------------------------------
  // Guard ordering
  // -------------------------------------------------------------------------

  it("checks context threshold before rate limit", async () => {
    const tool = makeTool();

    // First: succeed to set rate limit state
    await executeTool(tool);
    await flushBackgroundCompaction();

    // Now drop context below threshold
    contextUsage = 0.3;

    // Should get threshold rejection, not rate limit rejection
    const result = await executeTool(tool);
    expect(result).toMatchObject({
      status: "rejected",
      guard: "context_threshold",
    });
  });

  // -------------------------------------------------------------------------
  // _resetGuardState
  // -------------------------------------------------------------------------

  it("_resetGuardState clears per-session state", async () => {
    const tool = makeTool();

    await executeTool(tool);
    await flushBackgroundCompaction();
    _resetGuardState(SESSION_KEY);

    // After reset, should be able to request compaction again
    const result = await executeTool(tool);
    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(2);
  });

  it("_resetGuardState with no arg clears all sessions", async () => {
    const toolA = makeTool({ agentSessionKey: "session-a" });
    const toolB = makeTool({ agentSessionKey: "session-b" });

    await executeTool(toolA);
    await executeTool(toolB);
    await flushBackgroundCompaction();

    _resetGuardState();

    const resultA = await executeTool(toolA);
    const resultB = await executeTool(toolB);
    expect(resultA).toMatchObject({ status: "compaction_requested" });
    expect(resultB).toMatchObject({ status: "compaction_requested" });
  });

  it("expires volitional compaction counts after the diagnostic TTL", () => {
    let fakeNow = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    incrementVolitionalCompactionCount(SESSION_KEY);
    expect(getVolitionalCompactionCount(SESSION_KEY)).toBe(1);

    fakeNow += _guards.VOLITIONAL_COMPACTION_COUNT_TTL_MS + 1;
    expect(getVolitionalCompactionCount(SESSION_KEY)).toBe(0);

    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Guard: dedup (compaction already pending)
  // -------------------------------------------------------------------------

  it("returns already_pending when compaction is in-flight", async () => {
    _setPending(SESSION_KEY);

    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({ status: "already_pending" });
    expect(mockTriggerCompaction).not.toHaveBeenCalled();
  });

  it("dedup is cleared after triggerCompaction resolves", async () => {
    let resolveCompaction!: () => void;
    mockTriggerCompaction.mockReturnValue(
      new Promise<{ ok: boolean; compacted: boolean }>((resolve) => {
        resolveCompaction = () => resolve({ ok: true, compacted: true });
      }),
    );

    const tool = makeTool();
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    // Resolve the background compaction and flush microtasks
    resolveCompaction();
    await flushBackgroundCompaction();

    // After resolution, pending is cleared — a new call (with fresh guard state) works
    _resetGuardState(SESSION_KEY);
    const second = await executeTool(tool);
    expect(second).toMatchObject({ status: "compaction_requested" });
  });

  // In-flight dedup cleanup on background rejection.
  //
  // Bug-shape / risk:
  //   `pendingCompactionSessions` is the volatile in-flight dedup Set guarded
  //   by a `.finally(() => pendingCompactionSessions.delete(sessionKey))`
  //   in the fire-and-forget chain. If a future refactor moves cleanup from
  //   `.finally` into the `.then` happy-path only, a rejection would orphan
  //   the sessionKey in the Set forever — every subsequent
  //   `request_compaction` call would return `already_pending` until process
  //   restart. The existing "dedup is cleared after triggerCompaction
  //   resolves" test only covers the happy path.
  //
  // Pins the createRequestCompactionTool .finally cleanup.
  it("clears pending compaction session after background rejection", async () => {
    let rejectCompaction!: (err: Error) => void;
    mockTriggerCompaction.mockReturnValue(
      new Promise<{ ok: boolean; compacted: boolean }>((_resolve, reject) => {
        rejectCompaction = reject;
      }),
    );

    const tool = makeTool();
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    // Reject the background compaction and flush microtasks (multiple ticks
    // because .then().finally() chains across two microtask boundaries).
    rejectCompaction(new Error("simulated background failure"));
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    await new Promise((r) => {
      setTimeout(r, 0);
    });

    // After rejection, pending MUST be cleared — a new call must NOT return
    // `already_pending` (it WILL hit rate-limit since lastRequestMs was set
    // by the first call; that's expected. The trap is specifically that the
    // dedup Set, which is Guard 0 BEFORE rate-limit, must not still hold the
    // sessionKey).
    //
    // Note: we deliberately do NOT call `_resetGuardState(SESSION_KEY)` here
    // — that helper clears `pendingCompactionSessions` itself and would mask
    // the bug. We test the .finally-cleanup path directly through behavior.
    const second = await executeTool(tool);
    expect(
      second,
      "pendingCompactionSessions must clear in .finally after background rejection; " +
        "a refactor that moves cleanup into .then-only would orphan the sessionKey " +
        "and the second call would return `already_pending` (Guard 0) instead of " +
        "`rejected/rate_limit` (Guard 2)",
    ).not.toMatchObject({ status: "already_pending" });
  });

  // _resetGuardState restart/test-isolation contract.
  //
  // Bug-shape / risk:
  //   `_resetGuardState()` is the test-only helper that simulates process
  //   restart for in-flight dedup. It MUST clear `pendingCompactionSessions`
  //   alongside `sessionGuardState`. A refactor that splits the guard caches
  //   without updating `_resetGuardState` would leave the dedup Set polluted
  //   across test boundaries — symptom would be flaky `already_pending`
  //   results bleeding between tests.
  //
  // Pins _resetGuardState for both keyed and unkeyed branches.
  it("_resetGuardState clears pending compaction sessions for restart/test isolation", async () => {
    // Keyed reset path.
    _setPending(SESSION_KEY);
    _resetGuardState(SESSION_KEY);
    const tool = makeTool();
    const afterKeyedReset = await executeTool(tool);
    expect(
      afterKeyedReset,
      "_resetGuardState(sessionKey) must clear pendingCompactionSessions for that session",
    ).toMatchObject({ status: "compaction_requested" });

    // Unkeyed reset path (full restart simulation).
    const OTHER_KEY = "other-session-447";
    _setPending(SESSION_KEY);
    _setPending(OTHER_KEY);
    _resetGuardState();

    const toolAfterFullReset = makeTool();
    const afterFullReset = await executeTool(toolAfterFullReset);
    expect(
      afterFullReset,
      "_resetGuardState() (no key) must clear ALL pendingCompactionSessions for restart simulation",
    ).toMatchObject({ status: "compaction_requested" });

    // Verify the OTHER_KEY entry was also cleared (would surface if .clear()
    // was replaced with a sessionKey-scoped delete by a refactor).
    const otherTool = makeTool({ agentSessionKey: OTHER_KEY });
    const otherResult = await executeTool(otherTool);
    expect(
      otherResult,
      "_resetGuardState() must clear pendingCompactionSessions across all sessions, not just the active one",
    ).toMatchObject({ status: "compaction_requested" });
  });

  // -------------------------------------------------------------------------
  // Required reason parameter
  // -------------------------------------------------------------------------

  it("throws ToolInputError when reason is missing", async () => {
    const tool = makeTool();
    await expect(tool.execute("call-1", {})).rejects.toThrow(/reason required/);
  });

  it("throws ToolInputError when reason is empty string", async () => {
    const tool = makeTool();
    await expect(tool.execute("call-1", { reason: "  " })).rejects.toThrow(/reason required/);
  });
});
