// Core stuck session recovery runtime cases: embedded run handles and lane release.
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptMessageSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { saveCronStore } from "../cron/store.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import {
  mocks,
  resetMocks,
  warnLogMessages,
} from "./diagnostic-stuck-session-recovery.runtime.test-harness.js";

describe("stuck session recovery", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("does not abort an active embedded run by default", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery skipped: sessionId=session-1 sessionKey=agent:main:main age=180s queueDepth=1 activeSessionId=session-1",
      "stuck session recovery outcome: status=skipped action=observe_only sessionId=session-1 sessionKey=agent:main:main activeSessionId=session-1 activeWorkKind=embedded_run reason=active_embedded_run",
    ]);
  });

  it("reclaims a stale active embedded run with queued work and no forward progress (#85639)", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({
      lastProgressAgeMs: 10 * 60_000,
    });
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    mocks.resetCommandLane.mockReturnValue(1);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-1");
    expect(outcome.status).toBe("aborted");
    expect(warnLogMessages().some((m) => m.includes("reclaiming stale active run"))).toBe(true);
  });

  it("reclaims an orphaned handle once classification age is stale without an activity record", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("orphaned-session");
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({});
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "orphaned-session",
      sessionKey: "agent:main:main",
      ageMs: 10 * 60_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("orphaned-session");
    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      activeSessionId: "orphaned-session",
    });
  });
  it("aborts an active embedded run when active abort recovery is enabled", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      allowActiveAbort: true,
    });

    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-1");
    expect(mocks.waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith("session-1", 15_000);
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
  });

  it("returns an abort outcome for a stale tool call on an active embedded run", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-tool");
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    mocks.resetCommandLane.mockReturnValue(1);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "session-tool",
      sessionKey: "agent:main:telegram:group:-1003821464158:topic:4836",
      ageMs: 147_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      sessionId: "session-tool",
      sessionKey: "agent:main:telegram:group:-1003821464158:topic:4836",
      activeSessionId: "session-tool",
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 1,
    });
    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-tool");
    expect(mocks.waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith("session-tool", 15_000);
    expect(mocks.resetCommandLane).toHaveBeenCalledWith(
      "session:agent:main:telegram:group:-1003821464158:topic:4836",
    );
  });

  it("keeps the lane when a fresh turn started during the abort even with lane-queued work", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-fresh-queued");
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    mocks.getCommandLaneActiveTaskIds.mockReturnValueOnce([101]).mockReturnValueOnce([202]);
    mocks.getCommandLaneSnapshot.mockReturnValue({
      lane: "session:agent:main:main",
      queuedCount: 1,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "session-fresh-queued",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({ status: "aborted", aborted: true, released: 0 });
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
  });

  it("logs stopped cron context when aborting an active embedded run", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-recovery-context-",
    });
    const tempDir = openClawState.stateDir;
    try {
      await saveCronStore(path.join(tempDir, "cron", "jobs.json"), {
        version: 1,
        jobs: [
          {
            id: "job-123",
            name: "Twitter Mention Moderation Agent",
            enabled: true,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "tick" },
            state: {},
          },
        ],
      });
      const sessionKey = "agent:clawblocker:cron:job-123:run:run-456";
      await replaceSessionEntry(
        { agentId: "clawblocker", sessionKey },
        { sessionId: "run-456", updatedAt: 1 },
      );
      appendTranscriptMessageSync(
        { agentId: "clawblocker", sessionId: "run-456", sessionKey },
        { message: { role: "assistant", content: "There are 40 cached mentions." } },
      );
      mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("run-456");
      mocks.abortEmbeddedAgentRun.mockReturnValue(true);
      mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);

      await recoverStuckDiagnosticSession({
        sessionId: "run-456",
        sessionKey,
        ageMs: 629_000,
        allowActiveAbort: true,
      });
    } finally {
      await openClawState.cleanup();
    }

    expect(warnLogMessages()).toEqual([
      'stuck session recovery: sessionId=run-456 sessionKey=agent:clawblocker:cron:job-123:run:run-456 age=629s action=abort_embedded_run aborted=true drained=true released=0 stopped="Twitter Mention Moderation Agent" cronJobId=job-123 cronRunId=run-456 lastAssistant="There are 40 cached mentions."',
      "stuck session recovery outcome: status=aborted action=abort_embedded_run sessionId=run-456 sessionKey=agent:clawblocker:cron:job-123:run:run-456 activeSessionId=run-456 activeWorkKind=embedded_run lane=session:agent:clawblocker:cron:job-123:run:run-456 aborted=true drained=true forceCleared=false released=0",
    ]);
  });

  it("force-clears and releases the session lane when abort cleanup does not drain", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(false);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 240_000,
      allowActiveAbort: true,
    });

    expect(mocks.forceClearEmbeddedAgentRun).toHaveBeenCalledWith(
      "session-1",
      "agent:main:main",
      "stuck_recovery",
    );
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
  });

  it("force-clears and releases the session lane when an active run cannot be aborted", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedAgentRun.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 240_000,
      allowActiveAbort: true,
    });

    expect(mocks.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).toHaveBeenCalledWith(
      "session-1",
      "agent:main:main",
      "stuck_recovery",
    );
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
  });

  it("releases a stale session lane when diagnostics are processing but no active run exists", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
    });

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
  });

  it("releases the session lane when abort+drain succeeds but queued messages remain (ghost run + queued messages)", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("ghost-run-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    mocks.resetCommandLane.mockReturnValue(1);
    // Bug scenario: ghost run aborted+drained successfully, but user sent messages during the stall
    mocks.getCommandLaneSnapshot.mockReturnValue({
      lane: "session:agent:ghost:ghost",
      queuedCount: 1,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "ghost-run-session",
      sessionKey: "agent:ghost:ghost",
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("ghost-run-session");
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:ghost:ghost");
    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      released: 1,
      queuedCount: 1,
    });
  });

  it("reports queued lane work when aborting active work releases a lane", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.abortEmbeddedAgentRun.mockReturnValue(false);
    mocks.forceClearEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(false);
    mocks.resetCommandLane.mockReturnValue(1);
    mocks.getCommandLaneSnapshot.mockReturnValue({
      lane: "session:agent:main:main",
      queuedCount: 1,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      released: 1,
      queuedCount: 1,
    });
    expect(warnLogMessages()).toContain(
      "stuck session recovery outcome: status=aborted action=abort_embedded_run sessionId=queued-reply-session sessionKey=agent:main:main activeSessionId=queued-reply-session activeWorkKind=embedded_run lane=session:agent:main:main aborted=false drained=false forceCleared=true released=1 queuedCount=1",
    );
  });

  it("releases stale unregistered lane work after the diagnostic abort floor", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(false);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.getCommandLaneSnapshot.mockReturnValue({
      lane: "session:agent:main:main",
      queuedCount: 1,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    });
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "unregistered-work-session",
      sessionKey: "agent:main:main",
      ageMs: 300_000,
      queueDepth: 0,
    });

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=released action=release_lane sessionId=unregistered-work-session sessionKey=agent:main:main lane=session:agent:main:main reason=stale_lane_task released=1 queuedCount=1",
    ]);
  });

  it("does not release stale unregistered lane work when a fresh task appeared", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(false);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.getCommandLaneSnapshot.mockReturnValue({
      lane: "session:agent:main:main",
      queuedCount: 1,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    });
    mocks.getCommandLaneActiveTaskIds.mockReturnValueOnce([101]).mockReturnValueOnce([202]);

    await recoverStuckDiagnosticSession({
      sessionId: "unregistered-work-session",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 0,
    });

    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=skipped action=keep_lane sessionId=unregistered-work-session sessionKey=agent:main:main lane=session:agent:main:main reason=active_lane_task laneActive=1 laneQueued=1",
    ]);
  });

  it("waits for the compaction safety window before releasing unregistered lane work", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(false);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.getCommandLaneSnapshot.mockReturnValue({
      lane: "session:agent:main:main",
      queuedCount: 1,
      activeCount: 1,
      maxConcurrent: 1,
      draining: false,
      generation: 0,
    });

    await recoverStuckDiagnosticSession({
      sessionId: "unregistered-work-session",
      sessionKey: "agent:main:main",
      ageMs: 300_000,
      queueDepth: 0,
      compactionSafetyTimeoutMs: 600_000,
    });

    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=skipped action=keep_lane sessionId=unregistered-work-session sessionKey=agent:main:main lane=session:agent:main:main reason=active_lane_task laneActive=1 laneQueued=1",
    ]);

    mocks.diag.warn.mockClear();
    mocks.resetCommandLane.mockClear();
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "unregistered-work-session",
      sessionKey: "agent:main:main",
      ageMs: 615_000,
      queueDepth: 0,
      compactionSafetyTimeoutMs: 600_000,
    });

    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=released action=release_lane sessionId=unregistered-work-session sessionKey=agent:main:main lane=session:agent:main:main reason=stale_lane_task released=1 queuedCount=1",
    ]);
  });

  it("releases stale processing state when recovery finds no active work", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(0);

    await recoverStuckDiagnosticSession({
      sessionId: "stale-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
    });

    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
    expect(warnLogMessages()).toEqual([
      "stuck session recovery: sessionId=stale-session sessionKey=agent:main:main age=180s action=release_lane aborted=false drained=true released=0",
      "stuck session recovery outcome: status=released action=release_lane sessionId=stale-session sessionKey=agent:main:main lane=session:agent:main:main reason=no_active_work released=0",
    ]);
  });

  it("keeps observing an active run that neither aborted nor released", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("active-session");
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("active-session");
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.abortEmbeddedAgentRun.mockReturnValue(false);
    mocks.forceClearEmbeddedAgentRun.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(0);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "active-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "observe_only",
      reason: "active_embedded_run",
      activeSessionId: "active-session",
    });
  });

  it("clears stale queued processing state even when the lane has no active work", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(0);

    await recoverStuckDiagnosticSession({
      sessionId: "stale-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 2,
    });

    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
    expect(warnLogMessages()).toEqual([
      "stuck session recovery: sessionId=stale-session sessionKey=agent:main:main age=180s action=release_lane aborted=false drained=true released=0",
      "stuck session recovery outcome: status=released action=release_lane sessionId=stale-session sessionKey=agent:main:main lane=session:agent:main:main reason=no_active_work released=0",
    ]);
  });

  it("releases idle queued work without aborting when stale activity has no active owner", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(0);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "idle-stale-model-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
      expectedState: "idle",
    });

    expect(outcome).toMatchObject({
      status: "released",
      action: "release_lane",
      sessionId: "idle-stale-model-session",
      sessionKey: "agent:main:main",
      released: 0,
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
  });

  it("releases idle queued work with orphaned tool_call without aborting active work", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(1);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "idle-stale-tool-session",
      sessionKey: "agent:sub:tool-runner",
      ageMs: 180_000,
      queueDepth: 2,
      expectedState: "idle",
    });

    expect(outcome).toMatchObject({
      status: "released",
      action: "release_lane",
      sessionId: "idle-stale-tool-session",
      sessionKey: "agent:sub:tool-runner",
      released: 1,
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:sub:tool-runner");
  });

  it("releases a stale session-id lane when no session key is available", async () => {
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "session-only",
      ageMs: 180_000,
    });

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resolveEmbeddedSessionLane).toHaveBeenCalledWith("session-only");
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:session-only");
  });

  it("coalesces duplicate recovery attempts for the same session", async () => {
    let resolveWait: ((value: boolean) => void) | undefined;
    const waitPromise = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockReturnValue(waitPromise);

    const first = recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      allowActiveAbort: true,
    });
    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 210_000,
      allowActiveAbort: true,
    });

    expect(mocks.abortEmbeddedAgentRun).toHaveBeenCalledTimes(1);
    if (!resolveWait) {
      throw new Error("Expected diagnostic recovery wait resolver to be initialized");
    }
    resolveWait(true);
    await first;
  });
});
