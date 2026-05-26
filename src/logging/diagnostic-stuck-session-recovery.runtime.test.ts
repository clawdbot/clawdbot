import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abortEmbeddedPiRun: vi.fn(),
  forceClearEmbeddedPiRun: vi.fn(),
  isEmbeddedPiRunActive: vi.fn(),
  isEmbeddedPiRunHandleActive: vi.fn(),
  getCommandLaneSnapshot: vi.fn(),
  resetCommandLane: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  resolveActiveEmbeddedRunHandleSessionId: vi.fn(),
  resolveEmbeddedSessionLane: vi.fn((key: string) => `session:${key}`),
  waitForEmbeddedPiRunEnd: vi.fn(),
  getDiagnosticSessionActivitySnapshot: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  abortAndDrainEmbeddedPiRun: async (params: {
    sessionId: string;
    sessionKey?: string;
    settleMs?: number;
    forceClear?: boolean;
    reason?: string;
  }) => {
    const aborted = mocks.abortEmbeddedPiRun(params.sessionId);
    const drained = aborted
      ? await mocks.waitForEmbeddedPiRunEnd(params.sessionId, params.settleMs)
      : false;
    const forceCleared =
      params.forceClear === true && (!aborted || !drained)
        ? mocks.forceClearEmbeddedPiRun(params.sessionId, params.sessionKey, params.reason)
        : false;
    return { aborted, drained, forceCleared };
  },
  abortEmbeddedPiRun: mocks.abortEmbeddedPiRun,
  forceClearEmbeddedPiRun: mocks.forceClearEmbeddedPiRun,
  isEmbeddedPiRunActive: mocks.isEmbeddedPiRunActive,
  isEmbeddedPiRunHandleActive: mocks.isEmbeddedPiRunHandleActive,
  resolveActiveEmbeddedRunSessionId: mocks.resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunHandleSessionId: mocks.resolveActiveEmbeddedRunHandleSessionId,
  waitForEmbeddedPiRunEnd: mocks.waitForEmbeddedPiRunEnd,
}));

vi.mock("../agents/pi-embedded-runner/lanes.js", () => ({
  resolveEmbeddedSessionLane: mocks.resolveEmbeddedSessionLane,
}));

vi.mock("../process/command-queue.js", () => ({
  getCommandLaneSnapshot: mocks.getCommandLaneSnapshot,
  resetCommandLane: mocks.resetCommandLane,
}));

vi.mock("./diagnostic-runtime.js", () => ({
  diagnosticLogger: mocks.diag,
}));

vi.mock("./diagnostic-run-activity.js", () => ({
  getDiagnosticSessionActivitySnapshot: mocks.getDiagnosticSessionActivitySnapshot,
}));

import {
  testing,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";

function resetMocks() {
  testing.resetRecoveriesInFlight();
  mocks.abortEmbeddedPiRun.mockReset();
  mocks.forceClearEmbeddedPiRun.mockReset();
  mocks.isEmbeddedPiRunActive.mockReset();
  mocks.isEmbeddedPiRunHandleActive.mockReset();
  mocks.getCommandLaneSnapshot.mockReset();
  mocks.getCommandLaneSnapshot.mockReturnValue({
    lane: "session:agent:main:main",
    queuedCount: 0,
    activeCount: 0,
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  });
  mocks.resetCommandLane.mockReset();
  mocks.resolveActiveEmbeddedRunSessionId.mockReset();
  mocks.resolveActiveEmbeddedRunHandleSessionId.mockReset();
  mocks.resolveEmbeddedSessionLane.mockClear();
  mocks.waitForEmbeddedPiRunEnd.mockReset();
  mocks.getDiagnosticSessionActivitySnapshot.mockReset();
  // Default: no progress signal, so the staleness gate stays off unless a test
  // opts in by returning a stale lastProgressAgeMs.
  mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({});
  mocks.diag.debug.mockReset();
  mocks.diag.warn.mockReset();
}

function warnLogMessages(): string[] {
  return mocks.diag.warn.mock.calls.map(([message]) => {
    expect(typeof message).toBe("string");
    return message as string;
  });
}

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

    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.waitForEmbeddedPiRunEnd).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedPiRun).not.toHaveBeenCalled();
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
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("session-1");
    expect(outcome.status).toBe("aborted");
    expect(warnLogMessages().some((m) => m.includes("reclaiming stale active run"))).toBe(true);
  });

  it("aborts an active embedded run when active abort recovery is enabled", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      allowActiveAbort: true,
    });

    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("session-1");
    expect(mocks.waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("session-1", 15_000);
    expect(mocks.forceClearEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
  });

  it("returns an abort outcome for a stale tool call on an active embedded run", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-tool");
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);

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
      released: 0,
    });
    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("session-tool");
    expect(mocks.waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("session-tool", 15_000);
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
  });

  it("logs stopped cron context when aborting an active embedded run", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-context-"));
    try {
      process.env.OPENCLAW_STATE_DIR = tempDir;
      fs.mkdirSync(path.join(tempDir, "cron"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "cron", "jobs.json"),
        JSON.stringify({
          jobs: [{ id: "job-123", name: "Twitter Mention Moderation Agent" }],
        }),
      );
      fs.mkdirSync(path.join(tempDir, "agents", "clawblocker", "sessions"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tempDir, "agents", "clawblocker", "sessions", "run-456.jsonl"),
        JSON.stringify({
          message: { role: "assistant", content: "There are 40 cached mentions." },
        }) + "\n",
      );
      mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("run-456");
      mocks.abortEmbeddedPiRun.mockReturnValue(true);
      mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);

      await recoverStuckDiagnosticSession({
        sessionId: "run-456",
        sessionKey: "agent:clawblocker:cron:job-123:run:run-456",
        ageMs: 629_000,
        allowActiveAbort: true,
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    expect(warnLogMessages()).toEqual([
      'stuck session recovery: sessionId=run-456 sessionKey=agent:clawblocker:cron:job-123:run:run-456 age=629s action=abort_embedded_run aborted=true drained=true released=0 stopped="Twitter Mention Moderation Agent" cronJobId=job-123 cronRunId=run-456 lastAssistant="There are 40 cached mentions."',
      "stuck session recovery outcome: status=aborted action=abort_embedded_run sessionId=run-456 sessionKey=agent:clawblocker:cron:job-123:run:run-456 activeSessionId=run-456 activeWorkKind=embedded_run lane=session:agent:clawblocker:cron:job-123:run:run-456 aborted=true drained=true forceCleared=false released=0",
    ]);
  });

  it("force-clears and releases the session lane when abort cleanup does not drain", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(false);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 240_000,
      allowActiveAbort: true,
    });

    expect(mocks.forceClearEmbeddedPiRun).toHaveBeenCalledWith(
      "session-1",
      "agent:main:main",
      "stuck_recovery",
    );
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
  });

  it("force-clears and releases the session lane when an active run cannot be aborted", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedPiRun.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      ageMs: 240_000,
      allowActiveAbort: true,
    });

    expect(mocks.waitForEmbeddedPiRunEnd).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedPiRun).toHaveBeenCalledWith(
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

    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
  });

  it("does not release the session lane while reply work is active without an embedded handle", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);

    await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=skipped action=keep_lane sessionId=queued-reply-session sessionKey=agent:main:main activeSessionId=queued-reply-session activeWorkKind=embedded_run reason=active_reply_work",
    ]);
  });

  it("reclaims stale leaked reply work with queued work and no forward progress (#85639)", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
    // The "active" run has made no forward progress for well past the staleness
    // window — a leaked/dead handle, not genuine work.
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: 10 * 60_000 });
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
    });

    // Reclaimed (aborted) instead of skipping with active_reply_work.
    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("queued-reply-session");
    expect(outcome.status).not.toBe("skipped");
    expect(warnLogMessages().some((m) => m.includes("reclaiming stale active reply work"))).toBe(
      true,
    );
  });

  it("honors an operator-raised stuck-session abort threshold for stale reclaim (#85639)", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);

    // Operator raised the abort threshold to 20 min to protect slow active work.
    const raisedAbortMs = 20 * 60_000;

    // Below the raised threshold (10 min): keep the lane, do not reclaim.
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: 10 * 60_000 });
    const kept = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
      staleActiveProgressAbortMs: raisedAbortMs,
    });
    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(kept.status).toBe("skipped");

    // Past the raised threshold (25 min): reclaim.
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: 25 * 60_000 });
    const reclaimed = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
      staleActiveProgressAbortMs: raisedAbortMs,
    });
    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("queued-reply-session");
    expect(reclaimed.status).not.toBe("skipped");
  });

  it("keeps the lane when active reply work is still progressing", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
    // Recent forward progress: a genuinely active run must not be reclaimed.
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: 5_000 });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(outcome.status).toBe("skipped");
    expect(warnLogMessages().some((m) => m.includes("reason=active_reply_work"))).toBe(true);
  });

  it("does not reclaim stale reply work when no work is queued", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
    mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({ lastProgressAgeMs: 10 * 60_000 });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 0,
    });

    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(outcome.status).toBe("skipped");
    expect(warnLogMessages().some((m) => m.includes("reason=active_reply_work"))).toBe(true);
  });

  it("aborts stale reply work without an embedded handle when active abort recovery is enabled", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);

    await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledWith("queued-reply-session");
    expect(mocks.waitForEmbeddedPiRunEnd).toHaveBeenCalledWith("queued-reply-session", 15_000);
    expect(mocks.forceClearEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery: sessionId=queued-reply-session sessionKey=agent:main:main age=720s action=abort_embedded_run aborted=true drained=true released=0",
      "stuck session recovery outcome: status=aborted action=abort_embedded_run sessionId=queued-reply-session sessionKey=agent:main:main activeSessionId=queued-reply-session activeWorkKind=embedded_run lane=session:agent:main:main aborted=true drained=true forceCleared=false released=0",
    ]);
  });

  it("reports queued lane work when aborting active work releases a lane", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(true);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
    mocks.abortEmbeddedPiRun.mockReturnValue(false);
    mocks.forceClearEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(false);
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

  it("does not release the session lane while unregistered lane work is active", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(false);
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
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
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=skipped action=keep_lane sessionId=unregistered-work-session sessionKey=agent:main:main lane=session:agent:main:main reason=active_lane_task laneActive=1 laneQueued=1",
    ]);
  });

  it("reports when recovery finds no active work to release", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(0);

    await recoverStuckDiagnosticSession({
      sessionId: "stale-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
    });

    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:agent:main:main");
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=noop action=none sessionId=stale-session sessionKey=agent:main:main lane=session:agent:main:main reason=no_active_work",
    ]);
  });

  it("clears stale queued processing state even when the lane has no active work", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedPiRunActive.mockReturnValue(false);
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
      "stuck session recovery outcome: status=released action=release_lane sessionId=stale-session sessionKey=agent:main:main lane=session:agent:main:main released=0",
    ]);
  });

  it("releases a stale session-id lane when no session key is available", async () => {
    mocks.isEmbeddedPiRunHandleActive.mockReturnValue(false);
    mocks.resetCommandLane.mockReturnValue(1);

    await recoverStuckDiagnosticSession({
      sessionId: "session-only",
      ageMs: 180_000,
    });

    expect(mocks.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(mocks.resolveEmbeddedSessionLane).toHaveBeenCalledWith("session-only");
    expect(mocks.resetCommandLane).toHaveBeenCalledWith("session:session-only");
  });

  it("coalesces duplicate recovery attempts for the same session", async () => {
    let resolveWait: ((value: boolean) => void) | undefined;
    const waitPromise = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-1");
    mocks.abortEmbeddedPiRun.mockReturnValue(true);
    mocks.waitForEmbeddedPiRunEnd.mockReturnValue(waitPromise);

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

    expect(mocks.abortEmbeddedPiRun).toHaveBeenCalledTimes(1);
    if (!resolveWait) {
      throw new Error("Expected diagnostic recovery wait resolver to be initialized");
    }
    resolveWait(true);
    await first;
  });
});
