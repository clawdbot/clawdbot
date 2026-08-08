// Embedded run registry tests cover active run handles, abort/drain, waiters,
// abandonment tracking, diagnostics, and snapshots.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import { diagnosticLogger } from "../../logging/diagnostic.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  clearEmbeddedAgentRunAbortabilityForRunId,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedAgentRunAbortableForRunId,
  isEmbeddedAgentRunAbortableForCompaction,
  isEmbeddedAgentRunHandleActive,
  isEmbeddedRunAbandoned,
  markActiveEmbeddedRunAbandoned,
  retainEmbeddedAgentRunAbortabilityForRunId,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
  waitForEmbeddedAgentRunEnd,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    isAbortable?: boolean;
    isCompacting?: boolean;
    isStreaming?: boolean;
    runId?: string;
  } = {},
): RunHandle {
  // Minimal handle fixture with overrideable lifecycle probes for registry
  // behavior; individual tests supply abort behavior when needed.
  const abort = overrides.abort ?? (() => {});
  return {
    runId: overrides.runId,
    queueMessage: async () => {},
    isStreaming: () => overrides.isStreaming ?? true,
    ...(overrides.isAbortable !== undefined
      ? { isAbortable: () => overrides.isAbortable !== false }
      : {}),
    isCompacting: () => overrides.isCompacting ?? false,
    abort,
  };
}

describe("embedded-agent runner run registry", () => {
  afterEach(() => {
    // Registry state is process-global so imported module instances can share
    // it; every test must reset both embedded and reply-run registries.
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticSessionStateForTest();
    setDiagnosticsEnabledForProcess(false);
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun(
      "session-compacting",
      createRunHandle({ isCompacting: true, abort: abortCompacting }),
    );

    setActiveEmbeddedRun("session-normal", createRunHandle({ abort: abortNormal }));

    const aborted = abortEmbeddedAgentRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("keeps queued reply operations out of compact abort checks", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-reply-run",
      resetTriggered: false,
    });

    expect(isEmbeddedAgentRunAbortableForCompaction("session-reply-run")).toBe(false);

    operation.setPhase("running");

    expect(isEmbeddedAgentRunAbortableForCompaction("session-reply-run")).toBe(true);
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", createRunHandle({ isCompacting: true, abort: abortA }));

    setActiveEmbeddedRun("session-b", createRunHandle({ abort: abortB }));

    const aborted = abortEmbeddedAgentRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("keeps finalizing runs active while rejecting abort requests", () => {
    const abort = vi.fn();
    const handle = createRunHandle({ abort, isAbortable: false });
    const operation = createReplyOperation({
      sessionKey: "agent:main:finalizing",
      sessionId: "session-finalizing",
      resetTriggered: false,
    });
    const replyBackend = {
      kind: "embedded" as const,
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    };
    operation.setPhase("running");
    operation.attachBackend(replyBackend);
    setActiveEmbeddedRun("session-finalizing", handle);

    expect(abortEmbeddedAgentRun("session-finalizing")).toBe(false);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all" })).toBe(false);
    expect(isEmbeddedAgentRunAbortableForCompaction("session-finalizing")).toBe(true);
    expect(isEmbeddedAgentRunHandleActive("session-finalizing")).toBe(true);
    expect(operation.result).toBeNull();
    expect(abort).not.toHaveBeenCalled();

    clearActiveEmbeddedRun("session-finalizing", handle);
    operation.detachBackend(replyBackend);
    expect(abortEmbeddedAgentRun(undefined, { mode: "all" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    operation.complete();
    expect(isEmbeddedAgentRunHandleActive("session-finalizing")).toBe(false);
  });

  it("keeps frozen run ownership through forced in-process restart", () => {
    const abort = vi.fn();
    const handle = createRunHandle({ abort, isAbortable: false });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-finalizing",
      sessionId: "session-restart-finalizing",
      resetTriggered: false,
    });
    const replyBackend = {
      kind: "embedded" as const,
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    };
    operation.setPhase("running");
    operation.attachBackend(replyBackend);
    setActiveEmbeddedRun("session-restart-finalizing", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(false);
    expect(isEmbeddedAgentRunHandleActive("session-restart-finalizing")).toBe(true);
    expect(isReplyRunActiveForSessionId("session-restart-finalizing")).toBe(true);
    expect(operation.result).toBeNull();
    expect(abort).not.toHaveBeenCalled();

    clearActiveEmbeddedRun("session-restart-finalizing", handle);
    operation.detachBackend(replyBackend);
    operation.complete();
    expect(isEmbeddedAgentRunHandleActive("session-restart-finalizing")).toBe(false);
    expect(isReplyRunActiveForSessionId("session-restart-finalizing")).toBe(false);
  });

  it("binds abortability to the owning run id", () => {
    const finalizing = createRunHandle({
      abort: vi.fn(),
      isAbortable: false,
      runId: "run-finalizing",
    });
    setActiveEmbeddedRun("session-shared", finalizing);

    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("run-queued")).toBe(true);

    clearActiveEmbeddedRun("session-shared", finalizing);
    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(true);

    retainEmbeddedAgentRunAbortabilityForRunId("run-finalizing");
    setActiveEmbeddedRun("session-shared", finalizing);
    clearActiveEmbeddedRun("session-shared", finalizing);
    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(false);

    const queued = createRunHandle({ runId: "run-queued" });
    setActiveEmbeddedRun("session-shared", queued);

    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(false);
    expect(isEmbeddedAgentRunAbortableForRunId("run-queued")).toBe(true);

    clearEmbeddedAgentRunAbortabilityForRunId("run-finalizing");
    expect(isEmbeddedAgentRunAbortableForRunId("run-finalizing")).toBe(true);
  });

  it("passes restart ownership to every aborted run", () => {
    const abort = vi.fn();
    setActiveEmbeddedRun("session-restart", createRunHandle({ abort }));

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(true);
    expect(abort).toHaveBeenCalledWith("restart");
  });

  it("expires reply-owned stuck recovery as run_stalled instead of user abort", async () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:reply-stuck",
      sessionId: "session-reply-stuck",
      resetTriggered: false,
    });
    cancel.mockImplementation(() => operation.complete());
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: "session-reply-stuck",
      sessionKey: "agent:main:reply-stuck",
      reason: "stuck_recovery",
      forceClear: true,
    });

    expect(result).toEqual({ aborted: true, drained: true, forceCleared: false });
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(cancel).toHaveBeenCalledWith("superseded");
  });

  it("expires stuck recovery as run_stalled even with a live embedded handle", async () => {
    // The live-handle path is the common field case: the wedged run still owns
    // a registered handle, and its abort handler re-enters abortByUser. The
    // expiry must win the attribution race (run_stalled, not aborted_by_user).
    const operation = createReplyOperation({
      sessionKey: "agent:main:reply-stuck-live",
      sessionId: "session-reply-stuck-live",
      resetTriggered: false,
    });
    const handle = createRunHandle({
      abort: () => {
        operation.abortByUser();
      },
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
    });
    operation.setPhase("running");
    setActiveEmbeddedRun("session-reply-stuck-live", handle);

    const result = await abortAndDrainEmbeddedAgentRun({
      sessionId: "session-reply-stuck-live",
      sessionKey: "agent:main:reply-stuck-live",
      reason: "stuck_recovery",
      forceClear: true,
      settleMs: 50,
    });

    expect(result.aborted).toBe(true);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
  });

  it("claims shared restart ownership before invoking an attached handle", () => {
    const abort = vi.fn();
    const handle = createRunHandle({ abort });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-owned",
      sessionId: "session-restart-owned",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    });
    setActiveEmbeddedRun("session-restart-owned", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("restart");
  });

  it.each(["all", "compacting"] as const)(
    "does not bypass frozen shared ownership through %s handle aborts",
    (mode) => {
      const abort = vi.fn();
      const handle = createRunHandle({ abort, isCompacting: true });
      const sessionId = `session-restart-frozen-${mode}`;
      const operation = createReplyOperation({
        sessionKey: `agent:main:restart-frozen-${mode}`,
        sessionId,
        resetTriggered: false,
      });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        cancel: handle.abort,
        isStreaming: handle.isStreaming,
        isAbortable: handle.isAbortable,
        isCompacting: handle.isCompacting,
      });
      operation.freezeAbort();
      setActiveEmbeddedRun(sessionId, handle);

      expect(abortEmbeddedAgentRun(undefined, { mode, reason: "restart" })).toBe(false);
      expect(operation.result).toBeNull();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it("keeps shared restart ownership when the attached cancel callback throws", () => {
    const abort = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const handle = createRunHandle({ abort });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-throwing",
      sessionId: "session-restart-throwing",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
    });
    setActiveEmbeddedRun("session-restart-throwing", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "all", reason: "restart" })).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not bypass retained terminal ownership through compacting handle aborts", () => {
    const abort = vi.fn();
    const handle = createRunHandle({ abort, isCompacting: true });
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-failed-compacting",
      sessionId: "session-restart-failed-compacting",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      cancel: handle.abort,
      isStreaming: handle.isStreaming,
      isAbortable: handle.isAbortable,
      isCompacting: handle.isCompacting,
    });
    operation.retainFailureUntilComplete();
    operation.fail("run_failed", new Error("terminal failure"));
    setActiveEmbeddedRun("session-restart-failed-compacting", handle);

    expect(abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(abort).not.toHaveBeenCalled();
  });

  it("records active run session files in diagnostic state for heartbeat recovery", () => {
    setDiagnosticsEnabledForProcess(true);
    const sessionFile = "/tmp/openclaw-run-registry-session.jsonl";
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-file-diagnostics", handle, "agent:main:visible", sessionFile);

    expect(getDiagnosticSessionState({ sessionId: "session-file-diagnostics" }).sessionFile).toBe(
      sessionFile,
    );
  });

  it("force-clears an aborted run that does not drain", async () => {
    vi.useFakeTimers();
    try {
      const abortRun = vi.fn();
      setActiveEmbeddedRun(
        "session-stuck",
        createRunHandle({ abort: abortRun }),
        "agent:main:main",
      );

      const resultPromise = abortAndDrainEmbeddedAgentRun({
        sessionId: "session-stuck",
        sessionKey: "agent:main:main",
        settleMs: 100,
        forceClear: true,
        reason: "test_timeout",
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result).toEqual({ aborted: true, drained: false, forceCleared: true });
      expect(abortRun).toHaveBeenCalledTimes(1);
      expect(isEmbeddedAgentRunHandleActive("session-stuck")).toBe(false);
      expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBeUndefined();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("clamps oversized embedded run wait timers", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-running", handle);

      const waitPromise = waitForEmbeddedAgentRunEnd("session-running", MAX_TIMER_TIMEOUT_MS + 1);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      clearActiveEmbeddedRun("session-running", handle);
      await expect(waitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("waits without a timer when no run-end timeout is requested", async () => {
    vi.useFakeTimers();
    try {
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-unbounded", handle);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const waitPromise = waitForEmbeddedAgentRunEnd("session-unbounded", null);

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      clearActiveEmbeddedRun("session-unbounded", handle);
      await expect(waitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("waits for a reply-backed run without an embedded handle", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:reply-wait",
      sessionId: "session-reply-wait",
      resetTriggered: false,
    });

    const waitPromise = waitForEmbeddedAgentRunEnd("session-reply-wait", null);
    let settled = false;
    void waitPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    operation.complete();
    await expect(waitPromise).resolves.toBe(true);
  });

  it("waits for a replacement run under the same session id", async () => {
    const firstHandle = createRunHandle();
    const replacementHandle = createRunHandle();
    setActiveEmbeddedRun("session-replaced", firstHandle);

    const waitPromise = waitForEmbeddedAgentRunEnd("session-replaced", null);
    clearActiveEmbeddedRun("session-replaced", firstHandle);
    setActiveEmbeddedRun("session-replaced", replacementHandle);
    await Promise.resolve();

    let settled = false;
    void waitPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    clearActiveEmbeddedRun("session-replaced", replacementHandle);
    await expect(waitPromise).resolves.toBe(true);
  });

  it("waits for active runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-a", handle);
      setTimeout(() => {
        clearActiveEmbeddedRun("session-a", handle);
      }, 500);

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await waitPromise;

      expect(result.drained).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns drained=false when timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("session-a", createRunHandle());

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waitPromise;
      expect(result.drained).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("clamps oversized active-run drain poll intervals", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-a", handle);

      const waitPromise = waitForActiveEmbeddedRuns(undefined, {
        pollMs: Number.MAX_SAFE_INTEGER,
      });
      await Promise.resolve();

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      clearActiveEmbeddedRun("session-a", handle);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
      await expect(waitPromise).resolves.toEqual({ drained: true });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("shares active run state across distinct module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-b",
    );
    const handle = createRunHandle();

    testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedAgentRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedAgentRunActive("session-shared")).toBe(false);
    } finally {
      testing.resetActiveEmbeddedRuns();
    }
  });

  it("tracks actual embedded handles separately from reply-operation ownership", () => {
    const handle = createRunHandle();

    expect(isEmbeddedAgentRunHandleActive("session-a")).toBe(false);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBeUndefined();

    setActiveEmbeddedRun("session-a", handle, "agent:main:main");

    expect(isEmbeddedAgentRunHandleActive("session-a")).toBe(true);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBe("session-a");

    clearActiveEmbeddedRun("session-a", handle, "agent:main:main");

    expect(isEmbeddedAgentRunHandleActive("session-a")).toBe(false);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBeUndefined();
  });

  it("clears a relative compatibility file key after normalization", () => {
    const handle = createRunHandle();
    const sessionFile = "relative-session-token";

    setActiveEmbeddedRun("session-relative", handle, "agent:main:relative", sessionFile);
    expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile)).toBe(
      "session-relative",
    );

    clearActiveEmbeddedRun("session-relative", handle, "agent:main:relative", sessionFile);
    expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(sessionFile)).toBeUndefined();
  });

  it("tracks timeout abandonment by session id, key, and file until a new run starts", () => {
    // Abandonment markers must catch retries addressed by any durable identity,
    // then clear once a new run owns the same session key/file.
    const sessionFile = "/tmp/openclaw-abandoned-session.jsonl";
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-timeout", handle, "agent:main:main", sessionFile);
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-timeout",
        handle,
        sessionKey: "agent:main:main",
        sessionFile,
        reason: "timeout",
      }),
    ).toBe(true);

    expect(isEmbeddedRunAbandoned({ sessionId: "session-timeout" })).toBe(true);
    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(true);
    expect(isEmbeddedRunAbandoned({ sessionFile })).toBe(true);

    const nextHandle = createRunHandle();
    setActiveEmbeddedRun("session-next", nextHandle, "agent:main:main", sessionFile);

    expect(isEmbeddedRunAbandoned({ sessionId: "session-timeout" })).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionFile })).toBe(false);

    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-next",
        handle: nextHandle,
        sessionKey: "agent:main:main",
        reason: "timeout",
      }),
    ).toBe(true);
    setActiveEmbeddedRun("session-third", createRunHandle(), "agent:main:main");

    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(false);
  });

  it("ignores timeout abandonment from a stale replaced handle", () => {
    const oldHandle = createRunHandle();
    const newHandle = createRunHandle();

    setActiveEmbeddedRun("session-replaced", oldHandle, "agent:main:main");
    setActiveEmbeddedRun("session-replaced", newHandle, "agent:main:main");

    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-replaced",
        handle: oldHandle,
        sessionKey: "agent:main:main",
        reason: "timeout",
      }),
    ).toBe(false);

    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(false);
  });

  it("treats repeated clears for a completed run handle as idempotent", () => {
    const debugSpy = vi.spyOn(diagnosticLogger, "debug").mockImplementation(() => undefined);
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-repeat-clear", handle, "agent:main:main");
    clearActiveEmbeddedRun("session-repeat-clear", handle, "agent:main:main");
    clearActiveEmbeddedRun("session-repeat-clear", handle, "agent:main:main");

    expect(isEmbeddedAgentRunHandleActive("session-repeat-clear")).toBe(false);
    expect(resolveActiveEmbeddedRunHandleSessionId("agent:main:main")).toBeUndefined();
    expect(
      debugSpy.mock.calls.some(([message]) => message.includes("reason=handle_mismatch")),
    ).toBe(false);
  });

  it("still logs handle mismatches when another run owns the session", () => {
    const debugSpy = vi.spyOn(diagnosticLogger, "debug").mockImplementation(() => undefined);
    const staleHandle = createRunHandle();
    const activeHandle = createRunHandle();

    setActiveEmbeddedRun("session-handle-replaced", activeHandle);
    clearActiveEmbeddedRun("session-handle-replaced", staleHandle);

    expect(isEmbeddedAgentRunHandleActive("session-handle-replaced")).toBe(true);
    expect(
      debugSpy.mock.calls.some(([message]) => message.includes("reason=handle_mismatch")),
    ).toBe(true);
  });

  it("tracks and clears per-session transcript snapshots for active runs", () => {
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-snapshot", handle);
    updateActiveEmbeddedRunSnapshot("session-snapshot", {
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toEqual({
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });

    clearActiveEmbeddedRun("session-snapshot", handle);
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toBeUndefined();
  });
});
