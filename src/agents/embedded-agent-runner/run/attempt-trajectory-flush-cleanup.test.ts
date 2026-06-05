// Coverage for bounded trajectory flush during attempt cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush-cleanup.js";

describe("embedded attempt trajectory flush cleanup", () => {
  const log = {
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    log.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a stalled trajectory flush without rejecting attempt cleanup", async () => {
    // Trajectory persistence is diagnostic best-effort; a stalled flush should
    // warn with recorder state but not block attempt cleanup.
    const flush = vi.fn(async () => new Promise<never>(() => {}));
    const describeFlushState = vi.fn(
      () => "pendingWrites=1 queuedBytes=704 activeOperation=file-append",
    );

    const result = flushEmbeddedAttemptTrajectoryRecorder({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      trajectoryRecorder: {
        describeFlushState,
        flush,
      },
      log,
      timeoutMs: 5,
    });

    await vi.advanceTimersByTimeAsync(4);
    expect(log.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(describeFlushState).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=openclaw-trajectory-flush timeoutMs=5 details=pendingWrites=1 queuedBytes=704 activeOperation=file-append",
    );
  });
});
