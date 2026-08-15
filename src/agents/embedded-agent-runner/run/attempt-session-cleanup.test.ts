import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  cleanupEmbeddedAttemptResources: vi.fn(),
  clearToolSearchCatalog: vi.fn(),
  flushEmbeddedAttemptTrajectoryRecorder: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../tool-search.js", () => ({
  clearToolSearchCatalog: hoisted.clearToolSearchCatalog,
}));
vi.mock("../logger.js", () => ({
  log: { warn: hoisted.warn },
}));
vi.mock("./attempt-finalize.js", () => ({
  flushEmbeddedAttemptTrajectoryRecorder: hoisted.flushEmbeddedAttemptTrajectoryRecorder,
}));
vi.mock("./attempt-subscription-cleanup.js", () => ({
  cleanupEmbeddedAttemptResources: hoisted.cleanupEmbeddedAttemptResources,
}));

import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-settle.js";

const attempt = {
  runId: "run-1",
  sessionId: "session-1",
  sessionFile: "/tmp/session.jsonl",
} as never;

function createInput(overrides: Record<string, unknown> = {}) {
  const transcriptLifecycle = {
    beginCleanup: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const emitDiagnosticRunCompleted = vi.fn();
  const trajectoryRecorder = {
    recordEvent: vi.fn(),
    describeFlushState: vi.fn(),
    flush: vi.fn(),
  };
  const state = {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    promptError: null,
  };
  return {
    attempt,
    transcriptLifecycle,
    sessionAgentId: "main",
    buildAbortSettlePromise: () => null,
    trajectoryRecorder,
    trajectoryEndRecorded: false,
    cleanupYieldAborted: false,
    emitDiagnosticRunCompleted,
    readState: () => state,
    ...overrides,
  };
}

describe("cleanupEmbeddedAttemptSessionPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.cleanupEmbeddedAttemptResources.mockResolvedValue(undefined);
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockResolvedValue(undefined);
  });

  it("records the terminal event before transcript-safe resource cleanup", async () => {
    const input = createInput();

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(input.trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "session.ended",
      expect.objectContaining({ status: "cleanup", aborted: false }),
    );
    expect(hoisted.flushEmbeddedAttemptTrajectoryRecorder).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        trajectoryRecorder: input.trajectoryRecorder,
      }),
    );
    expect(hoisted.clearToolSearchCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", sessionId: "session-1", agentId: "main" }),
    );
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: false }),
    );
    expect(input.transcriptLifecycle.beginCleanup).toHaveBeenCalledOnce();
    expect(input.transcriptLifecycle.dispose).toHaveBeenCalledOnce();
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("completed", null, undefined);
  });

  it("keeps compaction timeout observations abort-like only for cleanup", async () => {
    const input = createInput();
    const readState = input.readState;
    input.readState = () => ({ ...readState(), timedOutDuringCompaction: true });

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true }),
    );
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("completed", null, undefined);
  });

  it("emits the before-agent blocked status and owner", async () => {
    const input = createInput({
      readState: () => ({
        aborted: false,
        externalAbort: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        promptError: null,
        beforeAgentRunBlockedBy: "before_agent",
      }),
    });

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("blocked", null, {
      blockedBy: "before_agent",
    });
  });

  it("re-reads abort state after trajectory flushing", async () => {
    let aborted = false;
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockImplementation(async () => {
      aborted = true;
    });
    const input = createInput({
      readState: () => ({
        aborted,
        externalAbort: aborted,
        timedOut: aborted,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        promptError: aborted ? new Error("request aborted") : null,
      }),
    });

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true }),
    );
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ message: "request aborted" }),
      undefined,
    );
  });
});
