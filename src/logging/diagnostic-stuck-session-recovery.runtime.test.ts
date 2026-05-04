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

import {
  __testing,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";

function resetMocks() {
  __testing.resetRecoveriesInFlight();
  mocks.abortEmbeddedPiRun.mockReset();
  mocks.forceClearEmbeddedPiRun.mockReset();
  mocks.isEmbeddedPiRunActive.mockReset();
  mocks.isEmbeddedPiRunHandleActive.mockReset();
  mocks.getCommandLaneSnapshot.mockReset();
  mocks.getCommandLaneSnapshot.mockReturnValue({
    lane: "session:agent:main:main",
    queuedCount: 1,
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
  mocks.diag.debug.mockReset();
  mocks.diag.warn.mockReset();
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
    expect(mocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=active_embedded_run"),
    );
    expect(mocks.diag.warn).toHaveBeenCalledWith(expect.stringContaining("action=observe_only"));
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

    expect(mocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining("action=abort_embedded_run"),
    );
    expect(mocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining('stopped="Twitter Mention Moderation Agent"'),
    );
    expect(mocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining('lastAssistant="There are 40 cached mentions."'),
    );
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
    expect(mocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=active_reply_work"),
    );
    expect(mocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining("activeSessionId=queued-reply-session"),
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
    expect(mocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=active_lane_task"),
    );
    expect(mocks.diag.warn).toHaveBeenCalledWith(expect.stringContaining("laneActive=1"));
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
    expect(mocks.diag.warn).toHaveBeenCalledWith(expect.stringContaining("reason=no_active_work"));
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
    let resolveWait!: (value: boolean) => void;
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
    resolveWait(true);
    await first;
  });
});
