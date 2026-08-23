import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import {
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcome,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

describe("embedded-agent active-run steering", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticSessionStateForTest();
    setDiagnosticsEnabledForProcess(false);
    vi.restoreAllMocks();
  });

  it("passes steering options to active embedded runs", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-steer", {
      ...createEmbeddedRunHandle(),
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
      ...createEmbeddedRunHandle(),
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
      createEmbeddedRunHandle({ queueMessage, supportsQueueMessageImages: true }),
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
      ...createEmbeddedRunHandle(),
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
      ...createEmbeddedRunHandle(),
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
      ...createEmbeddedRunHandle(),
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
      createEmbeddedRunHandle({
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
      setActiveEmbeddedRun("session-stale-steer", createEmbeddedRunHandle({ queueMessage }));

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
      setActiveEmbeddedRun("session-quiet-tool-steer", createEmbeddedRunHandle({ queueMessage }));
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
      createEmbeddedRunHandle({ queueMessage: freshQueueMessage }),
    );

    expect(queueEmbeddedAgentMessageWithOutcome("session-fresh-steer", "continue").queued).toBe(
      true,
    );
    expect(freshQueueMessage).toHaveBeenCalledWith("continue", { steeringMode: "all" });

    const missingSnapshotQueueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-no-diagnostic-snapshot",
      createEmbeddedRunHandle({ queueMessage: missingSnapshotQueueMessage }),
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
      createEmbeddedRunHandle({
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
      createEmbeddedRunHandle({
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
      createEmbeddedRunHandle({ isStreaming: false, queueMessage: legacyQueue }),
    );
    setActiveEmbeddedRun(
      "session-unavailable",
      createEmbeddedRunHandle({
        messageInjection: { isAvailable: () => false, queueMessage: unavailableQueue },
      }),
    );
    setActiveEmbeddedRun("session-compacting", createEmbeddedRunHandle({ isCompacting: true }));

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
      ...createEmbeddedRunHandle(),
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
      ...createEmbeddedRunHandle(),
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
      ...createEmbeddedRunHandle(),
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
