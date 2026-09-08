import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Embedded run lifecycle tests cover drain/wait behavior, process-global
// ownership, abandonment tracking, and snapshots.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { diagnosticLogger } from "../../logging/diagnostic.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedAgentRunHandleActive,
  markEmbeddedRunRecoveringTimeout,
  markActiveEmbeddedRunAbandoned,
  resolveEmbeddedRunAbandonment,
  resolveActiveEmbeddedRunOwner,
  resolveActiveEmbeddedRunOwnerByRunId,
  restoreEmbeddedRunTimeoutAbandonment,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForEmbeddedAgentRunEnd,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    isAbortable?: boolean;
    isAborted?: () => boolean;
    isCompacting?: boolean;
    isStreaming?: boolean;
    isStopped?: () => boolean;
    messageInjection?: RunHandle["messageInjection"];
    runId?: string;
    startedAtMs?: number;
    queueMessage?: RunHandle["queueMessage"];
    supportsQueueMessageImages?: boolean;
    supportsTranscriptCommitWait?: boolean;
  } = {},
): RunHandle {
  // Minimal handle fixture with overrideable lifecycle probes for registry
  // behavior; individual tests supply queue/abort behavior when needed.
  const abort = overrides.abort ?? (() => {});
  return {
    runId: overrides.runId,
    startedAtMs: overrides.startedAtMs,
    queueMessage: overrides.queueMessage ?? (async () => {}),
    ...(overrides.messageInjection ? { messageInjection: overrides.messageInjection } : {}),
    isStreaming: () => overrides.isStreaming ?? true,
    ...(overrides.isStopped ? { isStopped: overrides.isStopped } : {}),
    ...(overrides.isAborted ? { isAborted: overrides.isAborted } : {}),
    ...(overrides.isAbortable !== undefined
      ? { isAbortable: () => overrides.isAbortable !== false }
      : {}),
    isCompacting: () => overrides.isCompacting ?? false,
    supportsQueueMessageImages: overrides.supportsQueueMessageImages,
    supportsTranscriptCommitWait: overrides.supportsTranscriptCommitWait,
    abort,
  };
}

describe("embedded-agent runner run lifecycle", () => {
  afterEach(() => {
    // Registry state is process-global so imported module instances can share
    // it; every test must reset both embedded and reply-run registries.
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticSessionStateForTest();
    setDiagnosticsEnabledForProcess(false);
    vi.restoreAllMocks();
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
    const firstHandle = createRunHandle({ runId: "run-first" });
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

  it("does not let a marker from another module instance restore a replacement recovery", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=recovery-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=recovery-b",
    );
    const sessionId = "session-cross-module-recovery";
    const sessionKey = "agent:main:cross-module-recovery";
    const firstHandle = createRunHandle({ runId: "run-first" });
    runsA.setActiveEmbeddedRun(sessionId, firstHandle, sessionKey);
    expect(
      runsA.markActiveEmbeddedRunAbandoned({
        sessionId,
        handle: firstHandle,
        sessionKey,
        reason: "timeout",
      }),
    ).toBe(true);
    const staleMarker = runsA.markEmbeddedRunRecoveringTimeout({
      sessionId,
      runId: "run-first",
    });
    expect(staleMarker).toBeDefined();

    const replacementHandle = createRunHandle({ runId: "run-second" });
    runsB.setActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    expect(
      runsB.markActiveEmbeddedRunAbandoned({
        sessionId,
        handle: replacementHandle,
        sessionKey,
        reason: "timeout",
      }),
    ).toBe(true);
    const currentMarker = runsB.markEmbeddedRunRecoveringTimeout({
      sessionId,
      runId: "run-second",
    });
    expect(currentMarker).toBeDefined();

    expect(runsA.restoreEmbeddedRunTimeoutAbandonment(staleMarker!)).toBe(false);
    expect(runsB.resolveEmbeddedRunAbandonment({ sessionId })).toBe("recovering_timeout");
    expect(runsB.restoreEmbeddedRunTimeoutAbandonment(currentMarker!)).toBe(true);
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

    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-timeout" })).toBe("timeout");
    expect(resolveEmbeddedRunAbandonment({ sessionKey: "agent:main:main" })).toBe("timeout");
    expect(resolveEmbeddedRunAbandonment({ sessionFile })).toBe("timeout");

    const nextHandle = createRunHandle();
    setActiveEmbeddedRun("session-next", nextHandle, "agent:main:main", sessionFile);

    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-timeout" })).toBeUndefined();
    expect(resolveEmbeddedRunAbandonment({ sessionKey: "agent:main:main" })).toBeUndefined();
    expect(resolveEmbeddedRunAbandonment({ sessionFile })).toBeUndefined();

    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-next",
        handle: nextHandle,
        sessionKey: "agent:main:main",
        reason: "timeout",
      }),
    ).toBe(true);
    setActiveEmbeddedRun("session-third", createRunHandle(), "agent:main:main");

    expect(resolveEmbeddedRunAbandonment({ sessionKey: "agent:main:main" })).toBeUndefined();
  });

  it("does not reject completions while a timeout is recovering", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-recovering", handle, "agent:main:recovering");
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-recovering",
        handle,
        sessionKey: "agent:main:recovering",
        reason: "timeout",
      }),
    ).toBe(true);

    const recoveryMarker = markEmbeddedRunRecoveringTimeout({ sessionId: "session-recovering" });
    expect(recoveryMarker).toMatchObject({ sessionId: "session-recovering" });
    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-recovering" })).toBe(
      "recovering_timeout",
    );
    expect(restoreEmbeddedRunTimeoutAbandonment(recoveryMarker!)).toBe(true);
    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-recovering" })).toBe("timeout");
  });

  it("does not let a stale recovery marker mutate a replacement timeout", () => {
    const firstHandle = createRunHandle({ runId: "run-first" });
    setActiveEmbeddedRun("session-recovery-replaced", firstHandle, "agent:main:replaced");
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-recovery-replaced",
        handle: firstHandle,
        sessionKey: "agent:main:replaced",
        reason: "timeout",
      }),
    ).toBe(true);
    expect(
      markEmbeddedRunRecoveringTimeout({
        sessionId: "session-recovery-replaced",
        runId: "run-other",
      }),
    ).toBeUndefined();
    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-recovery-replaced" })).toBe(
      "timeout",
    );
    const staleMarker = markEmbeddedRunRecoveringTimeout({
      sessionId: "session-recovery-replaced",
      runId: "run-first",
    });
    expect(staleMarker).toBeDefined();

    const replacementHandle = createRunHandle({ runId: "run-second" });
    setActiveEmbeddedRun("session-recovery-replaced", replacementHandle, "agent:main:replaced");
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-recovery-replaced",
        handle: replacementHandle,
        sessionKey: "agent:main:replaced",
        reason: "timeout",
      }),
    ).toBe(true);

    expect(restoreEmbeddedRunTimeoutAbandonment(staleMarker!)).toBe(false);
    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-recovery-replaced" })).toBe(
      "timeout",
    );
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

    expect(resolveEmbeddedRunAbandonment({ sessionKey: "agent:main:main" })).toBeUndefined();
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

  it("projects one active run identity from either registry key", () => {
    const handle = createRunHandle({
      runId: "run-recovery",
      startedAtMs: 1_700_000_000_000,
    });
    setActiveEmbeddedRun("session-recovery", handle, "agent:main:main");

    const expected = {
      runId: "run-recovery",
      sessionId: "session-recovery",
      sessionKey: "agent:main:main",
      startedAtMs: 1_700_000_000_000,
    };
    expect(resolveActiveEmbeddedRunOwner("session-recovery")).toMatchObject(expected);
    expect(resolveActiveEmbeddedRunOwnerByRunId("run-recovery")).toMatchObject(expected);
  });

  it("rejects a stale recovered Stop after the session owner changes", () => {
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    const first = createRunHandle({ runId: "run-first", abort: firstAbort });
    const second = createRunHandle({ runId: "run-second", abort: secondAbort });
    setActiveEmbeddedRun("session-recovery", first, "agent:main:main");
    const identity = resolveActiveEmbeddedRunOwnerByRunId("run-first");
    setActiveEmbeddedRun("session-recovery", second, "agent:main:main");

    expect(identity?.abort()).toBe(false);
    expect(firstAbort).not.toHaveBeenCalled();
    expect(secondAbort).not.toHaveBeenCalled();
  });
});
