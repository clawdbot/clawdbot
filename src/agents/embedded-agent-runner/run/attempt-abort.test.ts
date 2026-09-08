// Coverage for external cancellation and timeout paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { EmbeddedAgentQueueHandle } from "../runs.js";
import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
} from "./attempt-finalize.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./attempt-session-settle.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import type { EmbeddedAttemptExecutionState } from "./types.js";

const mocks = vi.hoisted(() => ({
  countActiveToolExecutions: vi.fn(() => 0),
  markActiveEmbeddedRunAbandoned: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.handlers.tools.js", () => ({
  countActiveToolExecutions: mocks.countActiveToolExecutions,
}));

vi.mock("../runs.js", () => ({
  markActiveEmbeddedRunAbandoned: mocks.markActiveEmbeddedRunAbandoned,
}));

function createAbortState(): Pick<EmbeddedAttemptExecutionState, "terminal"> {
  return { terminal: { kind: "ok" } };
}

function createTrackedSessionAbort() {
  const abort = vi.fn(async (_reason?: unknown) => {});
  const tracker = createEmbeddedAttemptSessionSettleTracker({ abort });
  return { abort, tracker };
}

beforeEach(() => {
  mocks.countActiveToolExecutions.mockReset().mockReturnValue(0);
  mocks.markActiveEmbeddedRunAbandoned.mockReset();
});

describe("createEmbeddedAttemptExternalAbortController", () => {
  it("preserves external cancellation through active session settlement", async () => {
    const source = new AbortController();
    const runAbortController = new AbortController();
    const state = createAbortState();
    const session = createTrackedSessionAbort();
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: "run-external",
      state,
    });
    controller.setActiveSessionAbort(session.tracker.abortActiveSession);
    controller.arm();
    const reason = new Error("cancelled");

    source.abort(reason);

    expect(state.terminal).toEqual({
      kind: "aborted",
      source: "external",
      failure: { source: "prompt", error: reason },
    });
    expect(runAbortController.signal.reason).toBe(reason);
    expect(session.abort).toHaveBeenCalledExactlyOnceWith(reason);
    await session.tracker.buildAbortSettlePromise();
    controller.dispose();
  });

  it("classifies timeout during compaction without also blaming a tool", () => {
    const source = new AbortController();
    const runAbortController = new AbortController();
    const state = createAbortState();
    mocks.countActiveToolExecutions.mockReturnValue(1);
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: "run-compaction-timeout",
      state,
    });
    controller.setCompactionState({
      isPendingOrRetrying: () => true,
      isInFlight: () => false,
    });
    controller.arm();
    const reason = new Error("deadline");
    reason.name = "TimeoutError";

    source.abort(reason);

    expect(projectAgentRunAttemptTerminal(state.terminal)).toMatchObject({
      aborted: true,
      externalAbort: true,
      timedOut: true,
      timedOutDuringCompaction: true,
      timedOutDuringToolExecution: false,
    });
    expect(runAbortController.signal.reason).toBe(reason);
    controller.dispose();
  });

  it("hands cancellation to the live run handler once installed", () => {
    const source = new AbortController();
    const state = createAbortState();
    const abortRun = vi.fn();
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController: new AbortController(),
      runId: "run-live",
      state,
    });
    controller.setRunAbort(abortRun);
    controller.arm();
    const reason = new Error("cancelled live run");

    source.abort(reason);

    expect(state.terminal).toEqual({ kind: "aborted", source: "external" });
    expect(abortRun).toHaveBeenCalledExactlyOnceWith(false, reason);
    controller.dispose();
  });

  it("hands an external timeout to the live attempt exactly once", async () => {
    const source = new AbortController();
    const runAbortController = new AbortController();
    const state = createAbortState();
    const session = createTrackedSessionAbort();
    const onAttemptTimeout = vi.fn();
    const attempt = {
      abortSignal: source.signal,
      onAttemptTimeout,
      runId: "run-external-timeout",
      sessionFile: "agent:main:main",
      sessionId: "session-external-timeout",
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    };
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: attempt.runId,
      state,
    });
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession: session.tracker.abortActiveSession,
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt,
      getQueueHandle: () => ({}) as EmbeddedAgentQueueHandle,
      isProbeSession: true,
      log: { warn: vi.fn() },
      runAbortController,
      state,
    });
    controller.setRunAbort(abortRun);
    controller.setCompactionState({
      isPendingOrRetrying: () => false,
      isInFlight: () => false,
    });
    controller.arm();
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt,
      runAbortSignal: runAbortController.signal,
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 1_000,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });

    try {
      const reason = new Error("upstream request timed out");
      reason.name = "TimeoutError";
      source.abort(reason);
      await session.tracker.buildAbortSettlePromise();

      expect(state.terminal).toEqual({
        kind: "timeout",
        phase: "prompt",
        source: "external",
        aborted: true,
      });
      expect(onAttemptTimeout).toHaveBeenCalledOnce();
      expect(session.abort).toHaveBeenCalledExactlyOnceWith(reason);
      expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledOnce();
    } finally {
      timeout.clearTimers();
      controller.dispose();
    }
  });

  it.each([
    ["stage-start", false],
    ["prep-cleanup", false],
    ["stage-start", true],
    ["prep-cleanup", true],
  ] as const)("classifies abort at %s (timeout=%s)", async (checkpoint, timeout) => {
    const source = new AbortController();
    const reason = new Error("cancelled during setup");
    reason.name = timeout ? "TimeoutError" : "AbortError";
    source.abort(reason);
    const cleanupAfterEarlyAbort = vi.fn(async () => {});
    const state = createAbortState();
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort,
      runAbortController: new AbortController(),
      runId: "run-setup",
      state,
    });

    if (checkpoint === "stage-start") {
      expect(() => controller.throwIfFired()).toThrow(reason);
    } else {
      await expect(controller.throwIfFiredAfterPrepCleanup()).rejects.toBe(reason);
    }

    expect(cleanupAfterEarlyAbort).toHaveBeenCalledTimes(checkpoint === "stage-start" ? 0 : 1);
    expect(projectAgentRunAttemptTerminal(state.terminal)).toMatchObject({
      aborted: true,
      externalAbort: true,
      promptError: reason,
      timedOut: timeout,
    });
    const firstTerminal = state.terminal;
    controller.arm();
    expect(() => controller.throwIfFired()).toThrow(reason);
    expect(state.terminal).toBe(firstTerminal);
    controller.dispose();
  });
});

describe("createEmbeddedAttemptRunAbort", () => {
  it("settles timeout state, session work, and queue ownership", async () => {
    const state = createAbortState();
    const timeoutReason = new Error("attempt deadline");
    timeoutReason.name = "TimeoutError";
    const abortCompaction = vi.fn();
    const abortActiveSession = vi.fn(async () => {});
    const onAttemptTimeout = vi.fn();
    const queueHandle = {} as EmbeddedAgentQueueHandle;
    const runAbortController = new AbortController();
    mocks.countActiveToolExecutions.mockReturnValue(1);
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession,
      activeSession: { abortCompaction, isCompacting: true },
      attempt: {
        onAttemptTimeout,
        runId: "run-timeout",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-timeout",
        sessionKey: "agent:main",
      },
      getQueueHandle: () => queueHandle,
      isProbeSession: false,
      log: { warn: vi.fn() },
      runAbortController,
      state,
    });

    abortRun(true, timeoutReason);
    await Promise.resolve();

    expect(state.terminal).toEqual({
      kind: "timeout",
      phase: "tool_execution",
      source: "runtime",
      aborted: true,
    });
    expect(onAttemptTimeout).toHaveBeenCalledWith(timeoutReason);
    expect(runAbortController.signal.reason).toBe(timeoutReason);
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(abortActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledWith({
      sessionId: "session-timeout",
      handle: queueHandle,
      sessionKey: "agent:main",
      sessionFile: "/tmp/session.jsonl",
      reason: "timeout",
    });
  });

  it("preserves a manual abort reason", () => {
    const abortReason = new Error("manual abort");
    const runAbortController = new AbortController();
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession: vi.fn(async () => {}),
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt: {
        runId: "run-manual",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-manual",
        sessionKey: "agent:main",
      },
      getQueueHandle: () => undefined,
      isProbeSession: false,
      log: { warn: vi.fn() },
      runAbortController,
      state: createAbortState(),
    });

    abortRun(false, abortReason);

    expect(runAbortController.signal.reason).toBe(abortReason);
  });
});
