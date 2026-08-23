// Tests agent-runner-steer-adoption queue lifecycle ownership transfer.
import { describe, expect, it, vi } from "vitest";
import { parkSteerCandidate } from "./queue.js";

const mocks = vi.hoisted(() => ({
  parkedConsume: vi.fn(),
  parkedAdmit: vi.fn(async () => "steer" as const),
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(async () => ({
    queued: true,
    steerSessionId: "session-1",
  })),
  admitFollowupRunLifecycle: vi.fn(),
  completeFollowupRunLifecycle: vi.fn(),
  refreshReplyOperationTyping: vi.fn(),
  touchActiveSessionEntry: vi.fn(),
  typingCleanup: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  parkSteerCandidate: vi.fn(() => ({
    consume: mocks.parkedConsume,
    admit: mocks.parkedAdmit,
    fallback: vi.fn(),
  })),
  admitFollowupRunLifecycle: mocks.admitFollowupRunLifecycle,
  completeFollowupRunLifecycle: mocks.completeFollowupRunLifecycle,
  resolveFollowupAbortSignal: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  queueEmbeddedAgentMessageWithOutcomeAsync: mocks.queueEmbeddedAgentMessageWithOutcomeAsync,
  formatEmbeddedAgentQueueFailureSummary: vi.fn(),
}));

vi.mock("./reply-run-typing.js", () => ({
  refreshReplyOperationTyping: mocks.refreshReplyOperationTyping,
}));

vi.mock("./agent-runner-core.js", () => ({
  scheduleFollowupDrainAfterReplyOperationClear: vi.fn(),
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    get: vi.fn(),
    resolveCurrentMessageInjectionTarget: vi.fn(() => ({})),
  },
  beginReplyMessageInjectionTarget: vi.fn(() => ({})),
  finalizeReplyMessageInjectionAttempt: vi.fn(() => ({ status: "accepted", outcome: {} })),
  runAfterReplyOperationClear: vi.fn(),
}));

const { runActiveReplySteer } = await import("./agent-runner-steer-adoption.js");

describe("runActiveReplySteer", () => {
  it("transfers cleanup ownership of accepted steer from queued followup to active operation terminal callback", async () => {
    let capturedTerminalCallback: (() => void) | undefined;

    const activeReplyOperation = {
      completeThen: (fn: () => void) => {
        capturedTerminalCallback = fn;
      },
      recordActivity: vi.fn(),
      markAcceptedSteeredInboundAudio: vi.fn(),
    };

    const followupRun = {
      hostWorkspaceStagingDir: "/tmp/steer-staging",
      turnAdoptionLifecycle: { onAdopted: vi.fn() },
      run: {
        sessionId: "steer-session",
        messageProvenance: { Provider: "test-provider", Surface: "test-surface" },
      },
    };

    await runActiveReplySteer({
      providedReplyOperation: activeReplyOperation as any,
      followupRun: followupRun as any,
      typing: { cleanup: mocks.typingCleanup } as any,
      queueKey: "queue-1",
      sessionKey: "session-1",
      sessionCtx: { Provider: "telegram", AccountId: "default", MessageSid: "msg-1" } as any,
      replyOperationRunState: {} as any,
      touchActiveSessionEntry: mocks.touchActiveSessionEntry,
      typingSignals: { shouldStartImmediately: false } as any,
      releaseAdmissionTicket: vi.fn(),
      resolvedQueue: { debounceMs: 100 } as any,
    });

    expect(mocks.parkedConsume).toHaveBeenCalled();

    // Check that properties were removed so parked.consume() doesn't clean them up
    expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
    expect(followupRun.turnAdoptionLifecycle).toBeUndefined();

    // Check that completeThen callback was registered and completeFollowupRunLifecycle wasn't called yet
    expect(capturedTerminalCallback).toBeDefined();
    expect(mocks.completeFollowupRunLifecycle).not.toHaveBeenCalled();

    // Call terminal callback
    capturedTerminalCallback!();

    expect(mocks.completeFollowupRunLifecycle).toHaveBeenCalledWith({
      hostWorkspaceStagingDir: "/tmp/steer-staging",
      turnAdoptionLifecycle: expect.any(Object),
    });
  });

  it("retains staging and delegates fallback when steer is rejected", async () => {
    // Mock the injection attempt to reject
    mocks.finalizeReplyMessageInjectionAttempt.mockResolvedValueOnce({
      status: "rejected",
      outcome: { reason: "steer rejected by model" },
    });

    const activeReplyOperation = {
      completeThen: vi.fn(),
      recordActivity: vi.fn(),
      markAcceptedSteeredInboundAudio: vi.fn(),
    };

    const followupRun = {
      hostWorkspaceStagingDir: "/tmp/steer-staging",
      turnAdoptionLifecycle: { onAdopted: vi.fn() },
      run: {
        sessionId: "steer-session",
        messageProvenance: { Provider: "test-provider", Surface: "test-surface" },
      },
    };

    const fallbackMock = vi.fn();
    vi.mocked(parkSteerCandidate).mockReturnValueOnce({
      consume: mocks.parkedConsume,
      admit: mocks.parkedAdmit,
      fallback: fallbackMock,
    } as any);

    await runActiveReplySteer({
      providedReplyOperation: activeReplyOperation as any,
      followupRun: followupRun as any,
      typing: { cleanup: mocks.typingCleanup } as any,
      queueKey: "queue-1",
      sessionKey: "session-1",
      sessionCtx: { Provider: "telegram", AccountId: "default", MessageSid: "msg-1" } as any,
      replyOperationRunState: {} as any,
      touchActiveSessionEntry: mocks.touchActiveSessionEntry,
      typingSignals: { shouldStartImmediately: false } as any,
      releaseAdmissionTicket: vi.fn(),
      resolvedQueue: { debounceMs: 100 } as any,
    });

    // Check that fallback was called
    expect(fallbackMock).toHaveBeenCalled();

    // Properties should NOT be removed if rejected, so fallback can consume them
    expect(followupRun.hostWorkspaceStagingDir).toBe("/tmp/steer-staging");
    expect(followupRun.turnAdoptionLifecycle).toBeDefined();
  });
});
