// Tests reply turn admission decisions for active, queued, and aborted runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation, testing } from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

describe("reply turn admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
  });

  it("waits for visible turns and reuses the active session id", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    active.setPhase("running");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
    });

    let settled = false;
    void admitted.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("active-session");
      result.operation.complete();
    }
  });

  it("does not apply cleanup settle timeout to visible turn admission", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "waiting-session",
        kind: "visible",
        resetTriggered: false,
      });

      let settled = false;
      void admitted.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);

      active.complete();
      const result = await admitted;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps the cleanup settle timeout for queued follow-up retry", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "queued-session",
        kind: "queued_followup",
        resetTriggered: false,
      });

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(admitted).resolves.toMatchObject({
        status: "skipped",
        reason: "active-run",
        activeOperation: active,
      });
      active.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("uses the active run's final session id after waiting", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "pre-compact-session",
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
    });

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("post-compact-session");
      result.operation.complete();
    }
  });

  it("skips heartbeat turns while a visible turn owns the lane", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "visible-session",
      resetTriggered: false,
    });

    const result = await admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
      resetTriggered: false,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: active,
    });
    active.complete();
  });

  it("stops waiting when the caller aborts", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    const abortController = new AbortController();
    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "waiting-session",
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(admitted).resolves.toMatchObject({
      status: "skipped",
      reason: "aborted",
      activeOperation: active,
    });
    active.complete();
  });
});
