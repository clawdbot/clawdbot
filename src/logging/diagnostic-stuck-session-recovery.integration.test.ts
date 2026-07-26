// Stuck session recovery integration tests cover end-to-end recovery diagnostics.
import { afterEach, describe, expect, it } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import { enqueueCommandInLane, getQueueSize, resetCommandLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";

async function expectPendingAfterEventLoopTurn(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(settled).toBe(false);
}

describe("stuck session recovery integration", () => {
  afterEach(() => {
    recoveryTesting.resetRecoveriesInFlight();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
  });

  it("does not reset a blocked lane while a reply operation is still active", async () => {
    const sessionKey = "agent:main:active-reply";
    const sessionId = "active-reply-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);

    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });

    expect(getQueueSize(lane)).toBe(2);

    await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 180_000,
      queueDepth: 1,
    });

    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    operation.complete();
    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("does not reset sibling-key lane work while the same session file has an active embedded run", async () => {
    const activeSessionKey = "agent:main:visible";
    const fallbackSessionKey = "agent:main:fallback";
    const activeSessionId = "active-session-file-run";
    const fallbackSessionId = "fallback-session-file-run";
    const sessionFile = "/tmp/openclaw-diagnostic-shared-session.jsonl";
    const lane = resolveEmbeddedSessionLane(fallbackSessionKey);
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };

    setActiveEmbeddedRun(activeSessionId, handle, activeSessionKey, sessionFile);
    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: fallbackSessionId,
      sessionKey: fallbackSessionKey,
      sessionFile,
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "observe_only",
      reason: "active_embedded_run",
      activeSessionId,
    });
    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    clearActiveEmbeddedRun(activeSessionId, handle, activeSessionKey, sessionFile);
    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("aborts registered pre-run lane work and drains queued messages", async () => {
    const sessionKey = "agent:main:active-pre-run";
    const sessionId = "active-pre-run-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });

    const active = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markActiveStarted();
          if (operation.abortSignal.aborted) {
            resolve("aborted");
            return;
          }
          operation.abortSignal.addEventListener("abort", () => resolve("aborted"), { once: true });
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    expect(getQueueSize(lane)).toBe(2);
    await activeStarted;

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    await expect(active).resolves.toBe("aborted");
    await expect(queued).resolves.toBe("drained");
    expect(outcome.status).toBe("aborted");
    expect(getQueueSize(lane)).toBe(0);
  });

  it("releases a wedged lane after a clean abort when session work remains queued (#91700)", async () => {
    const sessionKey = "agent:main:wedged-delivery";
    const sessionId = "wedged-delivery-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    // Cancel settles the registry (clean abort+drain) while the lane task that
    // hosted the run stays wedged, mirroring a hang past the run's own cleanup.
    operation.attachBackend({
      kind: "embedded",
      cancel: () => queueMicrotask(() => operation.complete()),
      isStreaming: () => false,
    });
    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    expect(getQueueSize(lane)).toBe(1);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 1,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await expect(queued).resolves.toBe("drained");
  });

  it("does not reset a lane that unwedged and started a queued turn during the abort (#91700)", async () => {
    const sessionKey = "agent:main:unwedged-during-abort";
    const sessionId = "unwedged-during-abort-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    let markHostStarted!: () => void;
    const hostStarted = new Promise<void>((resolve) => {
      markHostStarted = resolve;
    });
    // Host task frees the lane on abort; the queued turn then pumps to active
    // and only it settles the registry, so the drain resolves with fresh work
    // already running — the race the queueDepth reset must not clobber.
    const host = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markHostStarted();
          operation.abortSignal.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    let releaseFreshTurn!: (value: "done") => void;
    const freshTurn = enqueueCommandInLane(
      lane,
      () => {
        operation.complete();
        return new Promise<"done">((resolve) => {
          releaseFreshTurn = resolve;
        });
      },
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    await hostStarted;

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    await expect(host).resolves.toBe("aborted");
    expect(outcome).toMatchObject({
      status: "aborted",
      aborted: true,
      drained: true,
      released: 0,
    });
    // The fresh turn still owns the lane slot: later work must wait for it.
    const third = enqueueCommandInLane(lane, async () => "third", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await expectPendingAfterEventLoopTurn(third);
    expect(getQueueSize(lane)).toBe(2);
    releaseFreshTurn("done");
    await expect(freshTurn).resolves.toBe("done");
    await expect(third).resolves.toBe("third");
  });

  it("does not reset a blocked lane while unregistered lane work is still active", async () => {
    const sessionKey = "agent:main:unregistered-work";
    const sessionId = "unregistered-work-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);

    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    expect(getQueueSize(lane)).toBe(2);

    await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 180_000,
      queueDepth: 1,
    });

    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });
});
