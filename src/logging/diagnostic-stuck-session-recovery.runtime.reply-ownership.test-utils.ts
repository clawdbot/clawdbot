// Stuck session recovery cases owned by an active reply operation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import {
  mocks,
  resetMocks,
  warnLogMessages,
} from "./diagnostic-stuck-session-recovery.runtime.test-harness.js";

describe("stuck session recovery reply ownership", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("aborts stale reply work without an embedded handle when active abort recovery is enabled", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("queued-reply-session");
    expect(mocks.waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith("queued-reply-session", 15_000);
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
    expect(warnLogMessages()).toEqual([
      "stuck session recovery: sessionId=queued-reply-session sessionKey=agent:main:main age=720s action=abort_embedded_run aborted=true drained=true released=1",
      "stuck session recovery outcome: status=aborted action=abort_embedded_run sessionId=queued-reply-session sessionKey=agent:main:main activeSessionId=queued-reply-session activeWorkKind=embedded_run lane=session:agent:main:main aborted=true drained=true forceCleared=false released=1",
    ]);
  });

  it("keeps the lane once the turn committed its terminal outcome", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("finalizing-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("finalizing-reply-session");
    mocks.resolveEmbeddedReplyActivity.mockReturnValue({
      phase: "running",
      lastActivityAtMs: Date.now(),
      terminalOutcomeCommitted: true,
    });
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(true);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "finalizing-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 486_000,
      queueDepth: 0,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "terminal_outcome_committed",
      activeSessionId: "finalizing-reply-session",
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
  });

  it("keeps the lane while reply work waits for deferred maintenance", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveEmbeddedReplyActivity.mockReturnValue({
      phase: "waiting_for_deferred_maintenance",
      lastActivityAtMs: Date.now(),
    });
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 928_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "deferred_maintenance_wait",
      activeSessionId: "queued-reply-session",
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=skipped action=keep_lane sessionId=queued-reply-session sessionKey=agent:main:main activeSessionId=queued-reply-session reason=deferred_maintenance_wait",
    ]);
  });

  it("keeps a reply queued on the global lane instead of reclaiming it", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveEmbeddedReplyActivity.mockReturnValue({
      phase: "waiting_for_global_lane",
      lastActivityAtMs: Date.now(),
    });
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 15 * 60_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "global_lane_wait",
      activeSessionId: "queued-reply-session",
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
  });

  it("reclaims proven-stale reply-only ownership even with zero queued backlog", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("phantom-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "phantom-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 0,
    });

    // Stale reply-only ownership must expire through the abort-and-drain owner
    // path even when the queued backlog is empty; previously the zero-depth
    // gate kept the lane forever (reason=active_reply_work).
    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("phantom-reply-session");
    expect(mocks.waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith("phantom-reply-session", 15_000);
    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      activeSessionId: "phantom-reply-session",
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: true,
    });
    expect(warnLogMessages()).toEqual([
      "stuck session recovery reclaiming stale active reply work: sessionId=phantom-reply-session sessionKey=agent:main:main age=720s queueDepth=0 activeSessionId=phantom-reply-session",
      "stuck session recovery: sessionId=phantom-reply-session sessionKey=agent:main:main age=720s action=abort_embedded_run aborted=true drained=true released=0",
      "stuck session recovery outcome: status=aborted action=abort_embedded_run sessionId=phantom-reply-session sessionKey=agent:main:main activeSessionId=phantom-reply-session activeWorkKind=embedded_run lane=session:agent:main:main aborted=true drained=true forceCleared=false released=0",
    ]);
  });

  it.each(["preflight_compacting", "memory_flushing"])(
    "keeps zero-backlog maintenance phase %s out of the stale reclaim path",
    async (phase) => {
      mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("maintenance-reply-session");
      mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
      mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
      mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
      mocks.resolveEmbeddedReplyActivity.mockReturnValue({
        phase,
        lastActivityAtMs: Date.now(),
      });
      mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({
        lastProgressAgeMs: 720_000,
      });

      const outcome = await recoverStuckDiagnosticSession({
        sessionId: "maintenance-reply-session",
        sessionKey: "agent:main:main",
        ageMs: 720_000,
        queueDepth: 0,
      });

      // Preflight compaction and memory flush are recognized maintenance
      // phases that may legitimately outlive the stale threshold (they honor a
      // configured compaction timeout). The zero-backlog exemption must not
      // turn a running maintenance operation into a reclaim target.
      expect(outcome).toMatchObject({
        status: "skipped",
        action: "keep_lane",
        reason: "active_reply_work",
        activeSessionId: "maintenance-reply-session",
      });
      expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["preflight_compacting", "memory_flushing"] as const)
      .flatMap((phase) =>
        [false, true].flatMap((hasEmbeddedHandle) =>
          [false, true].map((allowActiveAbort) => ({
            phase,
            hasEmbeddedHandle,
            allowActiveAbort,
            ageMs: 720_000,
          })),
        ),
      )
      .concat([
        {
          phase: "preflight_compacting",
          hasEmbeddedHandle: false,
          allowActiveAbort: false,
          ageMs: 915_000,
        },
        {
          phase: "memory_flushing",
          hasEmbeddedHandle: true,
          allowActiveAbort: true,
          ageMs: 915_000,
        },
      ]),
  )(
    "honors the configured $phase timeout with queued work (handle=$hasEmbeddedHandle, abort=$allowActiveAbort, age=$ageMs)",
    async ({ phase, hasEmbeddedHandle, allowActiveAbort, ageMs }) => {
      const sessionId = "maintenance-reply-session";
      mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);
      mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(
        hasEmbeddedHandle ? sessionId : undefined,
      );
      mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
      mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(hasEmbeddedHandle);
      mocks.resolveEmbeddedReplyActivity.mockReturnValue({
        phase,
        lastActivityAtMs: Date.now() - ageMs,
      });
      mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: ageMs });
      mocks.abortEmbeddedAgentRun.mockReturnValue(true);
      mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);

      const outcome = await recoverStuckDiagnosticSession({
        sessionId,
        sessionKey: "agent:main:main",
        ageMs,
        queueDepth: 1,
        allowActiveAbort,
        staleActiveProgressAbortMs: 360_000,
        compactionSafetyTimeoutMs: 900_000,
      });

      const withinCompactionSafetyWindow = ageMs < 915_000;
      expect(outcome.status).toBe(withinCompactionSafetyWindow ? "skipped" : "aborted");
      expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledTimes(
        withinCompactionSafetyWindow ? 0 : 1,
      );
    },
  );

  it.each([
    {
      name: "keeps fresh queued preflight despite an old session attention age",
      replyActivityAgeMs: 1_000,
      queueDepth: 1,
      compactionSafetyTimeoutMs: 600_000,
      expectedAbort: false,
    },
    {
      name: "clamps a future preflight activity clock instead of treating it as stale",
      replyActivityAgeMs: -1_000,
      queueDepth: 1,
      compactionSafetyTimeoutMs: 600_000,
      expectedAbort: false,
    },
    {
      name: "keeps zero-backlog preflight one millisecond before timeout plus settle",
      replyActivityAgeMs: 614_999,
      queueDepth: 0,
      compactionSafetyTimeoutMs: 600_000,
      expectedAbort: false,
    },
    {
      name: "recovers queued preflight exactly at timeout plus settle",
      replyActivityAgeMs: 615_000,
      queueDepth: 1,
      compactionSafetyTimeoutMs: 600_000,
      expectedAbort: true,
    },
    {
      name: "recovers queued preflight after timeout plus settle",
      replyActivityAgeMs: 615_001,
      queueDepth: 1,
      compactionSafetyTimeoutMs: 600_000,
      expectedAbort: true,
    },
    {
      name: "keeps preflight before the default stale recovery floor",
      replyActivityAgeMs: 299_999,
      queueDepth: 1,
      expectedAbort: false,
    },
    {
      name: "recovers preflight at the default stale recovery floor",
      replyActivityAgeMs: 300_000,
      queueDepth: 1,
      expectedAbort: true,
    },
    {
      name: "uses the default stale recovery floor for an invalid compaction timeout",
      replyActivityAgeMs: 299_999,
      queueDepth: 1,
      compactionSafetyTimeoutMs: 0,
      expectedAbort: false,
    },
  ])(
    "$name",
    async ({ replyActivityAgeMs, queueDepth, compactionSafetyTimeoutMs, expectedAbort }) => {
      const now = 1_800_000;
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("preflight-session");
        mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
        mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
        mocks.resolveEmbeddedReplyActivity.mockReturnValue({
          phase: "preflight_compacting",
          lastActivityAtMs: now - replyActivityAgeMs,
        });
        mocks.abortEmbeddedAgentRun.mockReturnValue(true);
        mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
        mocks.resetCommandLane.mockReturnValue(0);

        const outcome = await recoverStuckDiagnosticSession({
          sessionId: "preflight-session",
          sessionKey: "agent:main:main",
          // Deliberately older than every preflight clock in this table.
          ageMs: 30 * 60_000,
          queueDepth,
          allowActiveAbort: true,
          compactionSafetyTimeoutMs,
        });

        expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledTimes(expectedAbort ? 1 : 0);
        expect(outcome).toMatchObject(
          expectedAbort
            ? { status: "aborted", action: "abort_embedded_run" }
            : { status: "skipped", action: "keep_lane", reason: "active_reply_work" },
        );
      } finally {
        dateNow.mockRestore();
      }
    },
  );

  it("uses reply activity rather than session age for memory flushing", async () => {
    const now = Date.now();
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("memory-flush-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.resolveEmbeddedReplyActivity.mockReturnValue({
      phase: "memory_flushing",
      lastActivityAtMs: now,
    });
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    mocks.resetCommandLane.mockReturnValue(0);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "memory-flush-session",
      sessionKey: "agent:main:main",
      ageMs: 30 * 60_000,
      queueDepth: 1,
      allowActiveAbort: true,
      compactionSafetyTimeoutMs: 600_000,
    });

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "active_reply_work",
    });
  });

  it("keeps reply-only ownership with recent progress even with zero queued backlog", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("live-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: 1_000 });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "live-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 0,
    });

    // Recent progress means the reply is genuinely active; the zero-depth
    // exemption must not turn live work into a reclaim target.
    expect(outcome).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "active_reply_work",
      activeSessionId: "live-reply-session",
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
  });

  it("keeps the queue gate for active run handles with zero queued backlog", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(true);
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: 720_000 });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 0,
    });

    // Run-handle recovery keeps the queue gate: without a queued backlog the
    // active run is presumed to be processing and must not be aborted.
    expect(outcome).toMatchObject({
      status: "skipped",
      action: "observe_only",
      reason: "active_embedded_run",
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
  });
});
