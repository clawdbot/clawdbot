// Stuck session recovery runtime tests cover recovery inspection and event output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveCronStore } from "../cron/store.js";

const mocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(),
  forceClearEmbeddedAgentRun: vi.fn(),
  isEmbeddedAgentRunActive: vi.fn(),
  isEmbeddedAgentRunHandleActive: vi.fn(),
  getCommandLaneActiveTaskIds: vi.fn(),
  getCommandLaneSnapshot: vi.fn(),
  resetCommandLane: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn(),
  resolveActiveEmbeddedRunHandleSessionId: vi.fn(),
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile: vi.fn(),
  resolveEmbeddedAgentReplyRunPhase: vi.fn(),
  resolveEmbeddedSessionLane: vi.fn((key: string) => `session:${key}`),
  waitForEmbeddedAgentRunEnd: vi.fn(),
  getDiagnosticSessionActivitySnapshot: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../agents/embedded-agent-runner/runs.js", () => ({
  abortAndDrainEmbeddedAgentRun: async (params: {
    sessionId: string;
    sessionKey?: string;
    settleMs?: number;
    forceClear?: boolean;
    reason?: string;
  }) => {
    const aborted = mocks.abortEmbeddedAgentRun(params.sessionId);
    const drained = aborted
      ? await mocks.waitForEmbeddedAgentRunEnd(params.sessionId, params.settleMs)
      : false;
    const forceCleared =
      params.forceClear === true && (!aborted || !drained)
        ? mocks.forceClearEmbeddedAgentRun(params.sessionId, params.sessionKey, params.reason)
        : false;
    return { aborted, drained, forceCleared };
  },
  abortEmbeddedAgentRun: mocks.abortEmbeddedAgentRun,
  forceClearEmbeddedAgentRun: mocks.forceClearEmbeddedAgentRun,
  isEmbeddedAgentRunActive: mocks.isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive: mocks.isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunSessionId: mocks.resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile:
    mocks.resolveActiveEmbeddedRunSessionIdBySessionFile,
  resolveActiveEmbeddedRunHandleSessionId: mocks.resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile:
    mocks.resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  resolveEmbeddedAgentReplyRunPhase: mocks.resolveEmbeddedAgentReplyRunPhase,
  waitForEmbeddedAgentRunEnd: mocks.waitForEmbeddedAgentRunEnd,
}));

vi.mock("../agents/embedded-agent-runner/lanes.js", () => ({
  resolveEmbeddedSessionLane: mocks.resolveEmbeddedSessionLane,
}));

vi.mock("../process/command-queue.js", () => ({
  getCommandLaneActiveTaskIds: mocks.getCommandLaneActiveTaskIds,
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
  mocks.abortEmbeddedAgentRun.mockReset();
  mocks.forceClearEmbeddedAgentRun.mockReset();
  mocks.isEmbeddedAgentRunActive.mockReset();
  mocks.isEmbeddedAgentRunHandleActive.mockReset();
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
  mocks.getCommandLaneActiveTaskIds.mockReset();
  mocks.getCommandLaneActiveTaskIds.mockReturnValue([]);
  mocks.resolveActiveEmbeddedRunSessionId.mockReset();
  mocks.resolveActiveEmbeddedRunSessionIdBySessionFile.mockReset();
  mocks.resolveActiveEmbeddedRunHandleSessionId.mockReset();
  mocks.resolveActiveEmbeddedRunHandleSessionIdBySessionFile.mockReset();
  mocks.resolveEmbeddedAgentReplyRunPhase.mockReset();
  mocks.resolveEmbeddedSessionLane.mockClear();
  mocks.waitForEmbeddedAgentRunEnd.mockReset();
  mocks.getDiagnosticSessionActivitySnapshot.mockReset();
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

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery skipped: sessionId=session-1 sessionKey=agent:main:main age=180s queueDepth=1 activeSessionId=session-1",
      "stuck session recovery outcome: status=skipped action=observe_only sessionId=session-1 sessionKey=agent:main:main activeSessionId=session-1 activeWorkKind=embedded_run reason=active_embedded_run",
    ]);
  });

  it("does not release a sibling-key lane while the same session file has an active run", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveActiveEmbeddedRunHandleSessionIdBySessionFile.mockReturnValue("session-file-run");

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "sibling-session",
      sessionKey: "agent:main:fallback",
      sessionFile: "/tmp/openclaw-shared-session.jsonl",
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "observe_only",
      reason: "active_embedded_run",
      activeSessionId: "session-file-run",
    });
    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
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

  it("keeps the lane when a fresh queued turn started during the abort despite stale queue depth", async () => {
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("session-fresh");
    mocks.abortEmbeddedAgentRun.mockReturnValue(true);
    mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    mocks.getCommandLaneActiveTaskIds.mockReturnValueOnce([101]).mockReturnValueOnce([202]);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: "session-fresh",
      sessionKey: "agent:main:main",
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      aborted: true,
      drained: true,
      released: 0,
    });
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
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
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-context-"));
    try {
      process.env.OPENCLAW_STATE_DIR = tempDir;
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
      mocks.abortEmbeddedAgentRun.mockReturnValue(true);
      mocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);

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

  it("does not release the session lane while reply work is active without an embedded handle", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.isEmbeddedAgentRunActive.mockReturnValue(true);
    mocks.isEmbeddedAgentRunHandleActive.mockReturnValue(false);

    await recoverStuckDiagnosticSession({
      sessionId: "queued-reply-session",
      sessionKey: "agent:main:main",
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=skipped action=keep_lane sessionId=queued-reply-session sessionKey=agent:main:main activeSessionId=queued-reply-session activeWorkKind=embedded_run reason=active_reply_work",
    ]);
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

  it("keeps the lane while reply work waits for deferred maintenance", async () => {
    mocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("queued-reply-session");
    mocks.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    mocks.resolveEmbeddedAgentReplyRunPhase.mockReturnValue("waiting_for_deferred_maintenance");
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

  it("does not release the session lane while unregistered lane work is active", async () => {
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
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.forceClearEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(mocks.resetCommandLane).not.toHaveBeenCalled();
    expect(warnLogMessages()).toEqual([
      "stuck session recovery outcome: status=skipped action=keep_lane sessionId=unregistered-work-session sessionKey=agent:main:main lane=session:agent:main:main reason=active_lane_task laneActive=1 laneQueued=1",
    ]);
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

  it("reports when recovery finds no active work to release", async () => {
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
      "stuck session recovery outcome: status=noop action=none sessionId=stale-session sessionKey=agent:main:main lane=session:agent:main:main reason=no_active_work",
    ]);
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
      "stuck session recovery outcome: status=released action=release_lane sessionId=stale-session sessionKey=agent:main:main lane=session:agent:main:main released=0",
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
