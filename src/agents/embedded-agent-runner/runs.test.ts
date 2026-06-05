// Embedded run registry tests cover active run handles, queueing, abort/drain,
// abandonment tracking, diagnostics, snapshots, and live model-switch state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing as replyRunTesting,
  createReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import { diagnosticLogger } from "../../logging/diagnostic.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import {
  testing,
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  clearEmbeddedRunAbandonment,
  consumeEmbeddedRunModelSwitch,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedAgentRunHandleActive,
  isEmbeddedRunAbandoned,
  formatEmbeddedAgentQueueFailureSummary,
  markActiveEmbeddedRunAbandoned,
  markEmbeddedRunAbandoned,
  queueEmbeddedAgentMessageWithOutcome,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  requestEmbeddedRunModelSwitch,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  updateActiveEmbeddedRunSessionFile,
  waitForActiveEmbeddedRuns,
  waitForEmbeddedAgentRunEnd,
} from "./runs.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    isCompacting?: boolean;
    isStreaming?: boolean;
    supportsTranscriptCommitWait?: boolean;
  } = {},
): RunHandle {
  // Minimal handle fixture with overrideable lifecycle probes for registry
  // behavior; individual tests supply queue/abort behavior when needed.
  const abort = overrides.abort ?? (() => {});
  return {
    queueMessage: async () => {},
    isStreaming: () => overrides.isStreaming ?? true,
    isCompacting: () => overrides.isCompacting ?? false,
    supportsTranscriptCommitWait: overrides.supportsTranscriptCommitWait,
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

  it("resolves active embedded runs by canonical session file", async () => {
    // Session-file lookup canonicalizes symlinks so heartbeat/diagnostic callers
    // can find the active handle from the file path they observe.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-registry-"));
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const symlinkFile = path.join(tempDir, "session-link.jsonl");
      await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
      await fs.symlink(sessionFile, symlinkFile);
      const handle = createRunHandle();

      setActiveEmbeddedRun("session-file-run", handle, "agent:main:visible", sessionFile);

      expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(symlinkFile)).toBe(
        "session-file-run",
      );

      clearActiveEmbeddedRun("session-file-run", handle, "agent:main:visible", sessionFile);
      expect(resolveActiveEmbeddedRunHandleSessionIdBySessionFile(symlinkFile)).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records active run session files in diagnostic state for heartbeat recovery", () => {
    setDiagnosticsEnabledForProcess(true);
    const sessionFile = "/tmp/openclaw-run-registry-session.jsonl";
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-file-diagnostics", handle, "agent:main:visible", sessionFile);

    expect(getDiagnosticSessionState({ sessionId: "session-file-diagnostics" }).sessionFile).toBe(
      sessionFile,
    );

    updateActiveEmbeddedRunSessionFile(
      "session-file-diagnostics",
      "/tmp/openclaw-run-registry-rotated.jsonl",
    );

    expect(getDiagnosticSessionState({ sessionId: "session-file-diagnostics" }).sessionFile).toBe(
      "/tmp/openclaw-run-registry-rotated.jsonl",
    );
  });

  it("passes steering options to active embedded runs", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-steer", {
      ...createRunHandle(),
      sourceReplyDeliveryMode: "message_tool_only",
      queueMessage,
    });

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-steer", "continue", {
        steeringMode: "all",
        sourceReplyDeliveryMode: "message_tool_only",
      }).queued,
    ).toBe(true);

    expect(queueMessage).toHaveBeenCalledWith("continue", {
      steeringMode: "all",
      sourceReplyDeliveryMode: "message_tool_only",
    });
  });

  it("rejects message-tool-only steering for active runs created without that mode", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-automatic-source-reply", {
      ...createRunHandle(),
      queueMessage,
    });

    const outcome = queueEmbeddedAgentMessageWithOutcome(
      "session-automatic-source-reply",
      "continue",
      {
        steeringMode: "all",
        sourceReplyDeliveryMode: "message_tool_only",
      },
    );

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-automatic-source-reply",
      reason: "source_reply_delivery_mode_mismatch",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("defaults active embedded steering to all pending messages", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-default-steer", {
      ...createRunHandle(),
      queueMessage,
    });

    expect(queueEmbeddedAgentMessageWithOutcome("session-default-steer", "continue").queued).toBe(
      true,
    );

    expect(queueMessage).toHaveBeenCalledWith("continue", { steeringMode: "all" });
  });

  it("returns a structured no-active-run queue failure", () => {
    const outcome = queueEmbeddedAgentMessageWithOutcome("session-missing", "continue");

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-missing",
      reason: "no_active_run",
      gatewayHealth: "live",
    });
    expect(formatEmbeddedAgentQueueFailureSummary(outcome)).toBe(
      "queue_message_failed reason=no_active_run sessionId=session-missing gatewayHealth=live",
    );
  });

  it("returns structured queue failures for inactive active-run states", () => {
    setActiveEmbeddedRun("session-not-streaming", createRunHandle({ isStreaming: false }));
    setActiveEmbeddedRun("session-compacting", createRunHandle({ isCompacting: true }));

    expect(queueEmbeddedAgentMessageWithOutcome("session-not-streaming", "continue")).toEqual({
      queued: false,
      sessionId: "session-not-streaming",
      reason: "not_streaming",
      gatewayHealth: "live",
    });
    expect(queueEmbeddedAgentMessageWithOutcome("session-compacting", "continue")).toEqual({
      queued: false,
      sessionId: "session-compacting",
      reason: "compacting",
      gatewayHealth: "live",
    });
  });

  it("returns runtime rejection details when async queue delivery fails", async () => {
    setActiveEmbeddedRun("session-rejected", {
      ...createRunHandle(),
      queueMessage: async () => {
        throw new Error("cannot steer a compact turn");
      },
    });

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync("session-rejected", "continue");

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-rejected",
      reason: "runtime_rejected",
      gatewayHealth: "live",
      errorMessage: "cannot steer a compact turn",
    });
    expect(formatEmbeddedAgentQueueFailureSummary(outcome)).toBe(
      "queue_message_failed reason=runtime_rejected sessionId=session-rejected gatewayHealth=live error=cannot steer a compact turn",
    );
  });

  it("rejects transcript-commit waits for active handles without support", async () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-no-transcript-wait", {
      ...createRunHandle(),
      queueMessage,
    });

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-no-transcript-wait",
      "continue",
      { waitForTranscriptCommit: true },
    );

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-no-transcript-wait",
      reason: "transcript_commit_wait_unsupported",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("keeps reply-run fallback reachable for transcript-commit wait requests", async () => {
    // Some callers queue through the broader reply-run operation when the
    // embedded handle cannot prove transcript commit support directly.
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-reply-run",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-reply-run",
      "completion from child",
      { waitForTranscriptCommit: true },
    );

    expect(outcome.queued).toBe(true);
    if (!outcome.queued) {
      throw new Error("expected reply-run fallback to queue");
    }
    expect(outcome).toMatchObject({
      queued: true,
      sessionId: "session-reply-run",
      target: "reply_run",
      gatewayHealth: "live",
    });
    expect(outcome.enqueuedAtMs).toEqual(expect.any(Number));
    expect(outcome.deliveredAtMs).toBeUndefined();
    expect(queueMessage).toHaveBeenCalledWith("completion from child");
  });

  it("force-clears an aborted run that does not drain", async () => {
    vi.useFakeTimers();
    try {
      const abortRun = vi.fn();
      setActiveEmbeddedRun("session-stuck", createRunHandle({ abort: abortRun }), "agent:main");

      const resultPromise = abortAndDrainEmbeddedAgentRun({
        sessionId: "session-stuck",
        sessionKey: "agent:main",
        settleMs: 100,
        forceClear: true,
        reason: "test_timeout",
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result).toEqual({ aborted: true, drained: false, forceCleared: true });
      expect(abortRun).toHaveBeenCalledTimes(1);
      expect(isEmbeddedAgentRunHandleActive("session-stuck")).toBe(false);
      expect(resolveActiveEmbeddedRunHandleSessionId("agent:main")).toBeUndefined();
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

    runsA.testing.resetActiveEmbeddedRuns();
    runsB.testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedAgentRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedAgentRunActive("session-shared")).toBe(false);
    } finally {
      runsA.testing.resetActiveEmbeddedRuns();
      runsB.testing.resetActiveEmbeddedRuns();
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

  it("tracks timeout abandonment by session id, key, and file until a new run starts", () => {
    // Abandonment markers must catch retries addressed by any durable identity,
    // then clear once a new run owns the same session key/file.
    const sessionFile = "/tmp/openclaw-abandoned-session.jsonl";
    const handle = createRunHandle();

    markEmbeddedRunAbandoned({
      sessionId: "session-timeout",
      sessionKey: "agent:main:main",
      sessionFile,
      reason: "timeout",
    });

    expect(isEmbeddedRunAbandoned({ sessionId: "session-timeout" })).toBe(true);
    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(true);
    expect(isEmbeddedRunAbandoned({ sessionFile })).toBe(true);

    setActiveEmbeddedRun("session-next", handle, "agent:main:main", sessionFile);

    expect(isEmbeddedRunAbandoned({ sessionId: "session-timeout" })).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionKey: "agent:main:main" })).toBe(false);
    expect(isEmbeddedRunAbandoned({ sessionFile })).toBe(false);

    markEmbeddedRunAbandoned({
      sessionId: "session-next",
      sessionKey: "agent:main:main",
      reason: "timeout",
    });
    clearEmbeddedRunAbandonment({ sessionId: "session-next" });

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

  it("stores and consumes pending live model switch requests", () => {
    expect(
      requestEmbeddedRunModelSwitch("session-switch", {
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toBe(true);

    expect(consumeEmbeddedRunModelSwitch("session-switch")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(consumeEmbeddedRunModelSwitch("session-switch")).toBeUndefined();
  });

  it("drops pending live model switch requests when the run clears", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-clear-switch", handle);
    requestEmbeddedRunModelSwitch("session-clear-switch", {
      provider: "openai",
      model: "gpt-5.4",
    });

    clearActiveEmbeddedRun("session-clear-switch", handle);

    expect(consumeEmbeddedRunModelSwitch("session-clear-switch")).toBeUndefined();
  });
});
