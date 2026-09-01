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
  clearActiveEmbeddedRun,
  formatEmbeddedAgentQueueFailureSummary,
  preemptAndDrainEmbeddedHeartbeatRun,
  queueEmbeddedAgentMessageWithOutcome,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
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

  it("aborts and drains the exact heartbeat handle through session replacement", async () => {
    const heartbeatPreempt = vi.fn(() => true);
    const finalizingHeartbeatPreempt = vi.fn(() => true);
    const visibleAbort = vi.fn();
    const heartbeatHandle: EmbeddedAgentQueueHandle = {
      ...createEmbeddedRunHandle(),
      preemptByVisibleTurn: heartbeatPreempt,
    };
    const replacementHandle: EmbeddedAgentQueueHandle = {
      ...createEmbeddedRunHandle({ abort: visibleAbort }),
    };
    const finalizingHeartbeatHandle: EmbeddedAgentQueueHandle = {
      ...createEmbeddedRunHandle({ isAbortable: false }),
      preemptByVisibleTurn: finalizingHeartbeatPreempt,
    };
    setActiveEmbeddedRun("heartbeat-session", heartbeatHandle);
    setActiveEmbeddedRun("visible-session", replacementHandle);
    setActiveEmbeddedRun("finalizing-heartbeat-session", finalizingHeartbeatHandle);

    const heartbeatPreemption = preemptAndDrainEmbeddedHeartbeatRun("heartbeat-session", 1_000);
    const finalizingPreemption = preemptAndDrainEmbeddedHeartbeatRun(
      "finalizing-heartbeat-session",
      1_000,
    );
    await expect(preemptAndDrainEmbeddedHeartbeatRun("visible-session", 1_000)).resolves.toBe(
      "not-heartbeat",
    );

    let heartbeatDrained = false;
    void heartbeatPreemption.then(() => {
      heartbeatDrained = true;
    });
    setActiveEmbeddedRun("heartbeat-session", replacementHandle);
    await Promise.resolve();
    expect(heartbeatDrained).toBe(false);

    clearActiveEmbeddedRun("heartbeat-session", heartbeatHandle);
    clearActiveEmbeddedRun("finalizing-heartbeat-session", finalizingHeartbeatHandle);

    await expect(heartbeatPreemption).resolves.toBe("drained");
    await expect(finalizingPreemption).resolves.toBe("drained");
    expect(heartbeatPreempt).toHaveBeenCalledOnce();
    expect(finalizingHeartbeatPreempt).toHaveBeenCalledOnce();
    expect(visibleAbort).not.toHaveBeenCalled();
  });

  it("leaves a heartbeat in another session running", async () => {
    const preemptIsolatedHeartbeat = vi.fn(() => true);
    setActiveEmbeddedRun("base-session:heartbeat", {
      ...createEmbeddedRunHandle(),
      preemptByVisibleTurn: preemptIsolatedHeartbeat,
    });

    await expect(preemptAndDrainEmbeddedHeartbeatRun("base-session", 1_000)).resolves.toBe(
      "not-heartbeat",
    );
    expect(preemptIsolatedHeartbeat).not.toHaveBeenCalled();
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

  // A session with a live reply operation and no embedded handle is exactly the
  // state isEmbeddedAgentRunActive reports as active. Serving it here is what
  // keeps the activity gate and the injector from disagreeing.
  //
  // The handle below is the shape attempt-stream-prepare.ts attaches, field for
  // field. It is deliberately NOT a CLI handle: no CLI execution owner exposes
  // messageInjection or queueMessage, so writing one here would assert a
  // capability production does not have.
  it("injects into a reply-backed run whose backend really exposes injection", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:injectable-opt-in-steer",
      sessionId: "session-injectable-opt-in-steer",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "embedded-run-1",
      cancel: () => {},
      isStreaming: () => true,
      isStopped: () => false,
      queueMessage,
      messageInjection: { isAvailable: () => true, queueMessage },
    });
    operation.setPhase("running");

    try {
      const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        "session-injectable-opt-in-steer",
        "child done",
        { steeringMode: "all", debounceMs: 0, allowReplyRunInjection: true },
      );

      expect(outcome).toMatchObject({
        queued: true,
        sessionId: "session-injectable-opt-in-steer",
        target: "reply_run",
        gatewayHealth: "live",
      });
      // The routing flag is ours, not the backend's.
      expect(queueMessage).toHaveBeenCalledWith("child done", {
        steeringMode: "all",
        debounceMs: 0,
      });
    } finally {
      operation.complete();
    }
  });

  // The honest counterpart to the test above, and the one that pins the limit
  // review found: every production CLI attachment site (execute-process.ts,
  // execute-plugin.ts, execute-node-claude.ts) builds exactly these four fields
  // and no injection transport. Such a parent must keep the direct handoff.
  it("keeps the direct fallback for a CLI backend, which exposes no injection transport", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:cli-no-injection-steer",
      sessionId: "session-cli-no-injection-steer",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "cli",
      runId: "cli-run-1",
      toolAuthorityFingerprint: "fp-cli",
      cancel: () => {},
    });
    operation.setPhase("running");

    try {
      const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        "session-cli-no-injection-steer",
        "child done",
        { steeringMode: "all", debounceMs: 0, allowReplyRunInjection: true },
      );

      expect(outcome).toMatchObject({
        queued: false,
        sessionId: "session-cli-no-injection-steer",
        reason: "not_streaming",
      });
      // The point of the route for this shape is truthfulness, not delivery:
      // the same state used to answer `no_active_run`, which is false — the
      // parent is emphatically running, it just cannot take an in-flight steer.
      expect(outcome).not.toMatchObject({ reason: "no_active_run" });
    } finally {
      operation.complete();
    }
  });

  // A backend that declares its injection unavailable must be refused rather
  // than attempted. This is the cloud worker turn shape
  // (worker-turn-run-owner.ts), whose queueMessage always throws.
  it("refuses a reply backend that declares injection unavailable", async () => {
    const queueMessage = vi.fn(async () => {
      throw new Error("Cloud worker turns do not support message injection");
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:worker-unavailable-steer",
      sessionId: "session-worker-unavailable-steer",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "worker-run-1",
      cancel: () => {},
      isStopped: () => false,
      queueMessage,
      messageInjection: { isAvailable: () => false, queueMessage },
    });
    operation.setPhase("running");

    try {
      const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        "session-worker-unavailable-steer",
        "child done",
        { steeringMode: "all", debounceMs: 0, allowReplyRunInjection: true },
      );

      expect(outcome).toMatchObject({
        queued: false,
        sessionId: "session-worker-unavailable-steer",
        reason: "not_streaming",
      });
      expect(queueMessage).not.toHaveBeenCalled();
    } finally {
      operation.complete();
    }
  });

  // Uses a genuinely injectable backend so the assertion isolates the opt-in
  // flag rather than also depending on a missing capability.
  it("refuses reply-backed steering for callers that did not opt in", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:cli-no-opt-in-steer",
      sessionId: "session-cli-no-opt-in-steer",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {},
      isStreaming: () => true,
      isStopped: () => false,
      queueMessage,
      messageInjection: { isAvailable: () => true, queueMessage },
    });
    operation.setPhase("running");

    try {
      expect(
        queueEmbeddedAgentMessageWithOutcome("session-cli-no-opt-in-steer", "child done"),
      ).toEqual({
        queued: false,
        sessionId: "session-cli-no-opt-in-steer",
        reason: "no_active_run",
        gatewayHealth: "live",
      });
      expect(queueMessage).not.toHaveBeenCalled();
    } finally {
      operation.complete();
    }
  });

  it("reports transcript-commit wait as unsupported before consulting a reply-backed run", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:cli-transcript-steer",
      sessionId: "session-cli-transcript-steer",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: () => {},
      isStreaming: () => true,
      isStopped: () => false,
      queueMessage,
      messageInjection: { isAvailable: () => true, queueMessage },
    });
    operation.setPhase("running");

    try {
      // A reply backend has no supportsTranscriptCommitWait capability, so a
      // caller demanding transcript commitment must be refused and retry
      // best-effort rather than be told the injection was committed.
      expect(
        await queueEmbeddedAgentMessageWithOutcomeAsync(
          "session-cli-transcript-steer",
          "child done",
          { steeringMode: "all", waitForTranscriptCommit: true, allowReplyRunInjection: true },
        ),
      ).toEqual({
        queued: false,
        sessionId: "session-cli-transcript-steer",
        reason: "transcript_commit_wait_unsupported",
        gatewayHealth: "live",
      });
      expect(queueMessage).not.toHaveBeenCalled();

      const bestEffort = await queueEmbeddedAgentMessageWithOutcomeAsync(
        "session-cli-transcript-steer",
        "child done",
        { steeringMode: "all", allowReplyRunInjection: true },
      );
      expect(bestEffort).toMatchObject({ queued: true, target: "reply_run" });
      // No transcript commitment was proven, so no deliveredAtMs may be claimed.
      expect(bestEffort).not.toHaveProperty("deliveredAtMs");
    } finally {
      operation.complete();
    }
  });

  it("surfaces reply-backed injection rejections instead of collapsing them to no_active_run", async () => {
    const queueMessage = vi.fn(async () => {});
    const mismatched = createReplyOperation({
      sessionKey: "agent:main:cli-mismatch-steer",
      sessionId: "session-cli-mismatch-steer",
      resetTriggered: false,
    });
    mismatched.attachBackend({
      kind: "cli",
      cancel: () => {},
      isStreaming: () => true,
      queueMessage,
    });
    mismatched.setPhase("running");

    const unavailable = createReplyOperation({
      sessionKey: "agent:main:cli-unavailable-steer",
      sessionId: "session-cli-unavailable-steer",
      resetTriggered: false,
    });
    // No queueMessage and no messageInjection: the backend cannot take input.
    unavailable.attachBackend({ kind: "cli", cancel: () => {}, isStreaming: () => true });
    unavailable.setPhase("running");

    try {
      expect(
        await queueEmbeddedAgentMessageWithOutcomeAsync(
          "session-cli-mismatch-steer",
          "child done",
          {
            steeringMode: "all",
            sourceReplyDeliveryMode: "message_tool_only",
            allowReplyRunInjection: true,
          },
        ),
      ).toEqual({
        queued: false,
        sessionId: "session-cli-mismatch-steer",
        reason: "source_reply_delivery_mode_mismatch",
        gatewayHealth: "live",
      });
      expect(queueMessage).not.toHaveBeenCalled();

      expect(
        await queueEmbeddedAgentMessageWithOutcomeAsync(
          "session-cli-unavailable-steer",
          "child done",
          { steeringMode: "all", allowReplyRunInjection: true },
        ),
      ).toEqual({
        queued: false,
        sessionId: "session-cli-unavailable-steer",
        reason: "not_streaming",
        gatewayHealth: "live",
      });
    } finally {
      mismatched.complete();
      unavailable.complete();
    }
  });

  // allowReplyRunInjection is a routing flag consumed by the injector itself. The
  // embedded path must strip it too, not just the reply path: announce delivery
  // now sets it for EVERY requester, so an embedded backend would otherwise start
  // receiving a queue option that means nothing to it.
  it("strips the reply-run routing flag before an embedded backend sees it", async () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-strip-routing-flag", createEmbeddedRunHandle({ queueMessage }));

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-strip-routing-flag", "child done", {
        steeringMode: "all",
        allowReplyRunInjection: true,
      }),
    ).toMatchObject({ queued: true, target: "embedded_run" });
    expect(queueMessage).toHaveBeenCalledWith("child done", { steeringMode: "all" });

    const asyncQueueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      "session-strip-routing-flag-async",
      createEmbeddedRunHandle({ queueMessage: asyncQueueMessage }),
    );

    expect(
      await queueEmbeddedAgentMessageWithOutcomeAsync(
        "session-strip-routing-flag-async",
        "child done",
        { steeringMode: "all", debounceMs: 0, allowReplyRunInjection: true },
      ),
    ).toMatchObject({ queued: true, target: "embedded_run" });
    expect(asyncQueueMessage).toHaveBeenCalledWith("child done", {
      steeringMode: "all",
      debounceMs: 0,
    });
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

  it("atomically claims pending plain-text input across an authority mismatch", async () => {
    const claimPendingUserInputAnswer = vi.fn(async () => true);
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("session-pending-question", {
      ...createEmbeddedRunHandle(),
      toolAuthorityFingerprint: "fallback-authority",
      claimPendingUserInputAnswer,
      queueMessage,
    });

    const options = {
      isInboundUserMessage: true,
      onQueueAccepted: vi.fn(),
      pendingInputAuthorityFingerprint: "fallback-authority",
      toolAuthorityFingerprint: "default-authority",
    } as const;
    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-pending-question",
      "2",
      options,
    );

    expect(outcome).toMatchObject({ queued: true, target: "embedded_run" });
    expect(claimPendingUserInputAnswer).toHaveBeenCalledWith("2", options);
    expect(options.onQueueAccepted).toHaveBeenCalledWith(true);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a proven route-only mismatch without a pending question",
      claimed: false,
      images: undefined,
      pendingInputAuthorityFingerprint: "fallback-authority",
      expectedClaimCalls: 1,
      expectedCancelCalls: 0,
    },
    {
      label: "unproven plain text",
      claimed: true,
      images: undefined,
      pendingInputAuthorityFingerprint: undefined,
      expectedClaimCalls: 0,
      expectedCancelCalls: 0,
    },
    {
      label: "unproven image input",
      claimed: true,
      images: [{ type: "image" as const, data: "png", mimeType: "image/png" as const }],
      pendingInputAuthorityFingerprint: undefined,
      expectedClaimCalls: 0,
      expectedCancelCalls: 0,
    },
  ])(
    "preserves authority mismatch for $label",
    async ({
      claimed,
      images,
      pendingInputAuthorityFingerprint,
      expectedClaimCalls,
      expectedCancelCalls,
    }) => {
      const claimPendingUserInputAnswer = vi.fn(async () => claimed);
      const cancelPendingUserInput = vi.fn(async () => true);
      const queueMessage = vi.fn(async () => {});
      setActiveEmbeddedRun("session-pending-question-rejected", {
        ...createEmbeddedRunHandle(),
        toolAuthorityFingerprint: "fallback-authority",
        claimPendingUserInputAnswer,
        cancelPendingUserInput,
        queueMessage,
      });

      const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        "session-pending-question-rejected",
        "continue",
        {
          isInboundUserMessage: true,
          pendingInputAuthorityFingerprint,
          toolAuthorityFingerprint: "default-authority",
          images,
        },
      );

      expect(outcome).toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
      expect(claimPendingUserInputAnswer).toHaveBeenCalledTimes(expectedClaimCalls);
      expect(cancelPendingUserInput).toHaveBeenCalledTimes(expectedCancelCalls);
      expect(queueMessage).not.toHaveBeenCalled();
    },
  );

  it("cancels pending input for a proven route-only image mismatch", async () => {
    const cancelPendingUserInput = vi.fn(async () => true);
    setActiveEmbeddedRun("session-route-image", {
      ...createEmbeddedRunHandle(),
      toolAuthorityFingerprint: "fallback-authority",
      cancelPendingUserInput,
    });

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-route-image",
      "inspect",
      {
        isInboundUserMessage: true,
        pendingInputAuthorityFingerprint: "fallback-authority",
        toolAuthorityFingerprint: "default-authority",
        images: [{ type: "image", data: "png", mimeType: "image/png" }],
      },
    );

    expect(outcome).toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
    expect(cancelPendingUserInput).toHaveBeenCalledWith("image-reply");
  });

  it("cancels pending input before rejecting an unsupported queued image", async () => {
    const cancelPendingUserInput = vi.fn(async () => true);
    setActiveEmbeddedRun("session-unsupported-question-image", {
      ...createEmbeddedRunHandle(),
      toolAuthorityFingerprint: "same-authority",
      cancelPendingUserInput,
    });

    const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      "session-unsupported-question-image",
      "inspect",
      {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "same-authority",
        images: [{ type: "image", data: "png", mimeType: "image/png" }],
      },
    );

    expect(outcome).toMatchObject({ queued: false, reason: "image_input_unsupported" });
    expect(cancelPendingUserInput).toHaveBeenCalledWith("image-reply");
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
