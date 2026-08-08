// Embedded run registry tests cover active run handles, queueing, abort
// ownership, and diagnostics.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  isEmbeddedAgentRunAbortableForCompaction,
  isEmbeddedAgentRunHandleActive,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcome,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  retainEmbeddedAgentRunAbortabilityForRunId,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    abort?: () => void;
    isAbortable?: boolean;
    isCompacting?: boolean;
    isStreaming?: boolean;
    isStopped?: () => boolean;
    messageInjection?: RunHandle["messageInjection"];
    runId?: string;
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
    queueMessage: overrides.queueMessage ?? (async () => {}),
    ...(overrides.messageInjection ? { messageInjection: overrides.messageInjection } : {}),
    isStreaming: () => overrides.isStreaming ?? true,
    ...(overrides.isStopped ? { isStopped: overrides.isStopped } : {}),
    ...(overrides.isAbortable !== undefined
      ? { isAbortable: () => overrides.isAbortable !== false }
      : {}),
    isCompacting: () => overrides.isCompacting ?? false,
    supportsQueueMessageImages: overrides.supportsQueueMessageImages,
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

  it("rejects images when the active run cannot preserve them", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-images", {
      ...createRunHandle(),
      queueMessage,
    });

    const outcome = queueEmbeddedAgentMessageWithOutcome("session-images", "inspect", {
      images: [{ type: "image", data: "png", mimeType: "image/png" }],
    });

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-images",
      reason: "image_input_unsupported",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();

    setActiveEmbeddedRun(
      "session-images",
      createRunHandle({ queueMessage, supportsQueueMessageImages: true }),
    );

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-images", "inspect", {
        images: [{ type: "image", data: "png", mimeType: "image/png" }],
      }).queued,
    ).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("inspect", {
      images: [{ type: "image", data: "png", mimeType: "image/png" }],
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

  it.each([
    {
      label: "capable prompt into an incapable run",
      handleMode: undefined,
      requestMode: "gateway" as const,
    },
    {
      label: "incapable prompt into a capable run",
      handleMode: "gateway" as const,
      requestMode: undefined,
    },
  ])("rejects $label", ({ handleMode, requestMode }) => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-task-suggestions", {
      ...createRunHandle(),
      taskSuggestionDeliveryMode: handleMode,
      queueMessage,
    });

    const outcome = queueEmbeddedAgentMessageWithOutcome("session-task-suggestions", "continue", {
      steeringMode: "all",
      taskSuggestionDeliveryMode: requestMode,
    });

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-task-suggestions",
      reason: "task_suggestion_delivery_mode_mismatch",
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

  it("queues into active non-streaming handles that expose live stopped state", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-active-non-streaming",
      createRunHandle({
        isStreaming: false,
        isStopped: () => false,
        queueMessage,
      }),
    );

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-active-non-streaming", "continue").queued,
    ).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("continue", { steeringMode: "all" });
  });

  it("refuses embedded steering when diagnostic evidence is stale", () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      setActiveEmbeddedRun("session-stale-steer", createRunHandle({ queueMessage }));

      vi.advanceTimersByTime(10 * 60_000 + 1);

      const outcome = queueEmbeddedAgentMessageWithOutcome("session-stale-steer", "continue");

      expect(outcome).toEqual({
        queued: false,
        sessionId: "session-stale-steer",
        reason: "stale_run",
        gatewayHealth: "live",
      });
      expect(queueMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps steering into a quiet tool phase until the blocked-tool floor", () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      setActiveEmbeddedRun("session-quiet-tool-steer", createRunHandle({ queueMessage }));
      markDiagnosticToolStartedForTest({
        sessionId: "session-quiet-tool-steer",
        toolName: "exec",
        toolCallId: "tool-quiet-steer",
      });

      vi.advanceTimersByTime(12 * 60_000);
      expect(
        queueEmbeddedAgentMessageWithOutcome("session-quiet-tool-steer", "status?").queued,
      ).toBe(true);

      vi.advanceTimersByTime(4 * 60_000);
      const late = queueEmbeddedAgentMessageWithOutcome("session-quiet-tool-steer", "status?");
      expect(late).toMatchObject({ queued: false, reason: "stale_run" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses reply-backed steering with stale registry evidence as stale_run", () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:cli-stale-steer",
        sessionId: "session-cli-stale-steer",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "cli",
        cancel: () => {},
        isStreaming: () => true,
      });
      operation.setPhase("running");

      vi.advanceTimersByTime(10 * 60_000 + 1);
      const outcome = queueEmbeddedAgentMessageWithOutcome("session-cli-stale-steer", "hello");

      expect(outcome).toEqual({
        queued: false,
        sessionId: "session-cli-stale-steer",
        reason: "stale_run",
        gatewayHealth: "live",
      });
      operation.complete();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts embedded steering with fresh or missing diagnostic evidence", () => {
    const freshQueueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-fresh-steer",
      createRunHandle({ queueMessage: freshQueueMessage }),
    );

    expect(queueEmbeddedAgentMessageWithOutcome("session-fresh-steer", "continue").queued).toBe(
      true,
    );
    expect(freshQueueMessage).toHaveBeenCalledWith("continue", { steeringMode: "all" });

    const missingSnapshotQueueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-no-diagnostic-snapshot",
      createRunHandle({ queueMessage: missingSnapshotQueueMessage }),
    );
    resetDiagnosticRunActivityForTest();

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-no-diagnostic-snapshot", "continue").queued,
    ).toBe(true);
    expect(missingSnapshotQueueMessage).toHaveBeenCalledWith("continue", { steeringMode: "all" });
  });

  it("does not queue into stopped handles", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-stopped",
      createRunHandle({
        isStreaming: true,
        isStopped: () => true,
        queueMessage,
      }),
    );

    const outcome = queueEmbeddedAgentMessageWithOutcome("session-stopped", "continue");

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-stopped",
      reason: "not_streaming",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("fails closed when stopped state checks throw", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-bad-state",
      createRunHandle({
        isStopped: () => {
          throw new Error("bad stopped state");
        },
        queueMessage,
      }),
    );

    const outcome = queueEmbeddedAgentMessageWithOutcome("session-bad-state", "continue");

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-bad-state",
      reason: "not_streaming",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();
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

  it("returns structured queue failures for legacy, unavailable, or compacting runs", () => {
    const legacyQueue = vi.fn(async () => {});
    const unavailableQueue = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-not-streaming",
      createRunHandle({ isStreaming: false, queueMessage: legacyQueue }),
    );
    setActiveEmbeddedRun(
      "session-unavailable",
      createRunHandle({
        messageInjection: { isAvailable: () => false, queueMessage: unavailableQueue },
      }),
    );
    setActiveEmbeddedRun("session-compacting", createRunHandle({ isCompacting: true }));

    expect(queueEmbeddedAgentMessageWithOutcome("session-not-streaming", "continue")).toMatchObject(
      { queued: false, reason: "not_streaming" },
    );
    expect(legacyQueue).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcome("session-unavailable", "continue")).toMatchObject({
      queued: false,
      reason: "not_streaming",
    });
    expect(unavailableQueue).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageWithOutcome("session-compacting", "continue")).toMatchObject({
      queued: false,
      reason: "compacting",
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

  it("reports accepted steering without transcript confirmation as non-replayable", async () => {
    setActiveEmbeddedRun("session-unconfirmed", {
      ...createRunHandle(),
      queueMessage: async () => ({
        transcriptCommit: "unconfirmed",
        errorMessage: "receipt unavailable",
      }),
    });

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-unconfirmed",
      "continue",
    );

    expect(outcome).toEqual({
      queued: true,
      sessionId: "session-unconfirmed",
      target: "embedded_run",
      gatewayHealth: "live",
      transcriptCommit: "unconfirmed",
      errorMessage: "receipt unavailable",
      enqueuedAtMs: expect.any(Number),
    });
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

  it("rejects transcript-commit waits before reply-run fallback without an active handle", async () => {
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
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible group prompt", sender: { id: "user-42" } },
      target: createTestUserTurnTranscriptTarget(),
    });

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-reply-run",
      "completion from child",
      { waitForTranscriptCommit: true, userTurnTranscriptRecorder: recorder },
    );

    expect(outcome).toEqual({
      queued: false,
      sessionId: "session-reply-run",
      reason: "transcript_commit_wait_unsupported",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });
});
