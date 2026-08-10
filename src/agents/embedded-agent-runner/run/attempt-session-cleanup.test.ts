import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  cleanupEmbeddedAttemptResources: vi.fn(),
  clearToolSearchCatalog: vi.fn(),
  logError: vi.fn(),
  flushEmbeddedAttemptTrajectoryRecorder: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../tool-search.js", () => ({
  clearToolSearchCatalog: hoisted.clearToolSearchCatalog,
}));
vi.mock("../logger.js", () => ({
  log: { error: hoisted.logError, warn: hoisted.warn },
}));
vi.mock("./attempt-trajectory-flush-cleanup.js", () => ({
  flushEmbeddedAttemptTrajectoryRecorder: hoisted.flushEmbeddedAttemptTrajectoryRecorder,
}));
vi.mock("./attempt.subscription-cleanup.js", () => ({
  cleanupEmbeddedAttemptResources: hoisted.cleanupEmbeddedAttemptResources,
}));

import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-cleanup.js";

const attempt = {
  runId: "run-1",
  sessionId: "session-1",
  sessionFile: "/tmp/session.jsonl",
} as never;

function createState(overrides: Record<string, unknown> = {}) {
  const state = {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    failed: false,
    promptError: null,
    promptFailure: null as { error: unknown } | null,
    beforeAgentRunBlocked: false,
    ...overrides,
  };
  if (
    !Object.hasOwn(overrides, "failed") &&
    state.promptError !== null &&
    state.promptError !== undefined
  ) {
    state.failed = true;
  }
  if (state.failed && !Object.hasOwn(overrides, "promptFailure")) {
    state.promptFailure = { error: state.promptError };
  }
  return state;
}

function createInput(overrides: Record<string, unknown> = {}) {
  const sessionLockController = {
    acquireForCleanup: vi.fn(async () => ({ release: vi.fn() })),
    hasSessionTakeover: vi.fn(() => false),
  };
  const emitDiagnosticRunCompleted = vi.fn();
  const trajectoryRecorder = {
    recordEvent: vi.fn(),
    describeFlushState: vi.fn(),
    flush: vi.fn(),
  };
  const state = createState();
  return {
    attempt,
    sessionLockController,
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

  it("records the terminal event before lock-safe resource cleanup", async () => {
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
      expect.objectContaining({ aborted: false, skipSessionFlush: false }),
    );
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("completed", null, undefined);
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
        failed: aborted,
        promptError: aborted ? new Error("request aborted") : null,
        promptFailure: aborted ? { error: new Error("request aborted") } : null,
        beforeAgentRunBlocked: false,
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

  it("still acquires cleanup ownership and releases resources after trajectory flush fails", async () => {
    const trajectoryError = new Error("trajectory flush failed");
    const disposeSession = vi.fn();
    const disposeMcp = vi.fn(async () => undefined);
    const disposeLsp = vi.fn(async () => undefined);
    const input = createInput({
      session: { dispose: disposeSession },
      bundleMcpRuntime: { dispose: disposeMcp },
      bundleLspRuntime: { dispose: disposeLsp },
    });
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockRejectedValueOnce(trajectoryError);
    hoisted.cleanupEmbeddedAttemptResources.mockImplementationOnce(async (cleanupInput) => {
      cleanupInput.session?.dispose();
      await cleanupInput.bundleMcpRuntime?.dispose();
      await cleanupInput.bundleLspRuntime?.dispose();
    });

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toBe(trajectoryError);

    expect(hoisted.clearToolSearchCatalog).toHaveBeenCalledOnce();
    expect(input.sessionLockController.acquireForCleanup).toHaveBeenCalledOnce();
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledOnce();
    expect(disposeMcp).toHaveBeenCalledOnce();
    expect(disposeLsp).toHaveBeenCalledOnce();
  });

  it("uses one no-flush disposer path when cleanup lock acquisition fails", async () => {
    const acquireError = new Error("cleanup lock failed");
    const disposeSession = vi.fn();
    const disposeMcp = vi.fn(async () => undefined);
    const disposeLsp = vi.fn(async () => undefined);
    const input = createInput({
      session: { dispose: disposeSession },
      bundleMcpRuntime: { dispose: disposeMcp },
      bundleLspRuntime: { dispose: disposeLsp },
    });
    input.sessionLockController.acquireForCleanup.mockRejectedValueOnce(acquireError);
    hoisted.cleanupEmbeddedAttemptResources.mockImplementationOnce(async (cleanupInput) => {
      expect(cleanupInput.skipSessionFlush).toBe(true);
      cleanupInput.session?.dispose();
      await cleanupInput.bundleMcpRuntime?.dispose();
      await cleanupInput.bundleLspRuntime?.dispose();
    });

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toBe(acquireError);

    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledOnce();
    expect(disposeMcp).toHaveBeenCalledOnce();
    expect(disposeLsp).toHaveBeenCalledOnce();
  });

  it("keeps the first cleanup failure while attempting every later owner", async () => {
    const recordError = new Error("trajectory record failed");
    const flushError = new Error("trajectory flush failed");
    const catalogError = new Error("catalog cleanup failed");
    const resourceError = new Error("resource cleanup failed");
    const input = createInput();
    input.trajectoryRecorder.recordEvent.mockImplementationOnce(() => {
      throw recordError;
    });
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockRejectedValueOnce(flushError);
    hoisted.clearToolSearchCatalog.mockImplementationOnce(() => {
      throw catalogError;
    });
    hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(resourceError);

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toBe(recordError);

    expect(hoisted.flushEmbeddedAttemptTrajectoryRecorder).toHaveBeenCalledOnce();
    expect(hoisted.clearToolSearchCatalog).toHaveBeenCalledOnce();
    expect(input.sessionLockController.acquireForCleanup).toHaveBeenCalledOnce();
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledOnce();
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledOnce();
  });

  it("contains diagnostic observer failures after successful cleanup", async () => {
    const diagnosticError = new Error("diagnostic failed");
    const input = createInput({
      emitDiagnosticRunCompleted: vi.fn(() => {
        throw diagnosticError;
      }),
    });

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).resolves.toBeUndefined();

    expect(hoisted.logError).toHaveBeenCalledWith(expect.stringContaining("diagnostic failed"));
  });

  it("preserves the prompt error when cleanup detects session takeover", async () => {
    const promptError = new Error("prompt failed");
    const sessionLockController = {
      acquireForCleanup: vi.fn(async () => ({ release: vi.fn() })),
      hasSessionTakeover: vi.fn(() => true),
    };
    const emitDiagnosticRunCompleted = vi.fn();
    const input = createInput({
      sessionLockController,
      emitDiagnosticRunCompleted,
      trajectoryRecorder: null,
      readState: () => ({
        aborted: false,
        externalAbort: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        failed: true,
        promptError,
        promptFailure: { error: promptError },
        beforeAgentRunBlocked: false,
      }),
    });

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).resolves.toBeUndefined();
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ skipSessionFlush: true }),
    );
    expect(emitDiagnosticRunCompleted).toHaveBeenCalledWith("error", promptError, undefined);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining("preserving terminal result"),
    );
  });

  it("keeps a terminal prompt result primary when ordinary resource cleanup fails", async () => {
    const promptError = new Error("prompt failed");
    const cleanupError = new Error("resource cleanup failed");
    const input = createInput({
      trajectoryRecorder: null,
      readState: () => ({
        aborted: false,
        externalAbort: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        failed: true,
        promptError,
        promptFailure: { error: promptError },
        beforeAgentRunBlocked: false,
      }),
    });
    hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(cleanupError);

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).resolves.toBeUndefined();

    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("error", promptError, undefined);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining("cleanupError=resource cleanup failed"),
    );
  });

  it.each([
    {
      label: "abort",
      state: { aborted: true },
      status: "aborted",
      details: undefined,
    },
    {
      label: "external cancellation",
      state: { externalAbort: true },
      status: "aborted",
      details: undefined,
    },
    {
      label: "hard timeout",
      state: { timedOut: true },
      status: "aborted",
      details: undefined,
    },
    {
      label: "idle timeout",
      state: { idleTimedOut: true },
      status: "aborted",
      details: undefined,
    },
    {
      label: "run-budget timeout",
      state: { timedOutByRunBudget: true },
      status: "aborted",
      details: undefined,
    },
    {
      label: "sessions_yield",
      state: {},
      cleanupYieldAborted: true,
      status: "completed",
      details: undefined,
    },
    {
      label: "before-agent block",
      state: { beforeAgentRunBlocked: true, beforeAgentRunBlockedBy: "policy-hook" },
      status: "blocked",
      details: { blockedBy: "policy-hook" },
    },
  ])(
    "keeps a terminal $label primary when cleanup fails",
    async ({ state, cleanupYieldAborted = false, status, details }) => {
      const cleanupError = new Error("resource cleanup failed");
      const input = createInput({
        trajectoryRecorder: null,
        cleanupYieldAborted,
        readState: () => createState(state as Record<string, unknown>),
      });
      hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(cleanupError);

      await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).resolves.toBeUndefined();

      expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(status, null, details);
      expect(hoisted.warn).toHaveBeenCalledWith(
        expect.stringContaining("preserving terminal result"),
      );
      expect(hoisted.warn).toHaveBeenCalledWith(
        expect.stringContaining("cleanupError=resource cleanup failed"),
      );
    },
  );

  it("keeps an already-fired abort signal primary when cleanup fails", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const input = createInput({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        abortSignal: controller.signal,
      } as never,
      trajectoryRecorder: null,
      readState: () => createState(),
    });
    hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(
      new Error("resource cleanup failed"),
    );

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).resolves.toBeUndefined();

    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("aborted", null, undefined);
    expect(hoisted.warn).toHaveBeenCalledWith(expect.stringContaining("terminalStatus=aborted"));
  });

  it("does not promote observation-only timeout flags over cleanup failure", async () => {
    const cleanupError = new Error("resource cleanup failed");
    const input = createInput({
      trajectoryRecorder: null,
      readState: () =>
        createState({
          timedOutDuringCompaction: true,
          timedOutDuringToolExecution: true,
        }),
    });
    hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(cleanupError);

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toBe(cleanupError);

    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("error", cleanupError, undefined);
    expect(hoisted.warn).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    false,
    0,
    -0,
    0n,
    Number.NaN,
    "",
    Symbol("cleanup"),
    { code: "E_CLEANUP" },
  ])("normalizes a falsy or non-Error session-phase cleanup rejection %#", async (reason) => {
    const input = createInput({ trajectoryRecorder: null });
    hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(reason);

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toBeInstanceOf(Error);
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(
      "error",
      expect.any(Error),
      undefined,
    );
  });

  it.each([false, 0, "", null, undefined])(
    "keeps a falsy prompt failure primary when cleanup fails %#",
    async (promptError) => {
      const cleanupError = new Error("resource cleanup failed");
      const input = createInput({
        trajectoryRecorder: null,
        readState: () => createState({ failed: true, promptError }),
      });
      hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(cleanupError);

      await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).resolves.toBeUndefined();

      expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(
        "error",
        promptError,
        undefined,
      );
      expect(hoisted.warn).toHaveBeenCalledWith(
        expect.stringContaining("preserving terminal result"),
      );
    },
  );

  it.each([null, undefined])(
    "treats an absent prompt failure as absent when cleanup fails %#",
    async (promptError) => {
      const cleanupError = new Error("resource cleanup failed");
      const input = createInput({
        trajectoryRecorder: null,
        readState: () => createState({ promptError }),
      });
      hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(cleanupError);

      await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toBe(cleanupError);
      expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(
        "error",
        cleanupError,
        undefined,
      );
    },
  );

  it("keeps the primary terminal error across multiple cleanup failures", async () => {
    const promptError = new Error("prompt failed");
    const recordError = new Error("trajectory record failed");
    const flushError = new Error("trajectory flush failed");
    const catalogError = new Error("catalog cleanup failed");
    const resourceError = new Error("resource cleanup failed");
    const input = createInput({
      readState: () => createState({ aborted: true, promptError }),
    });
    input.trajectoryRecorder.recordEvent.mockImplementationOnce(() => {
      throw recordError;
    });
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockRejectedValueOnce(flushError);
    hoisted.clearToolSearchCatalog.mockImplementationOnce(() => {
      throw catalogError;
    });
    hoisted.cleanupEmbeddedAttemptResources.mockRejectedValueOnce(resourceError);

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).resolves.toBeUndefined();

    expect(hoisted.flushEmbeddedAttemptTrajectoryRecorder).toHaveBeenCalledOnce();
    expect(hoisted.clearToolSearchCatalog).toHaveBeenCalledOnce();
    expect(input.sessionLockController.acquireForCleanup).toHaveBeenCalledOnce();
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledOnce();
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("error", promptError, undefined);
    expect(hoisted.warn).toHaveBeenCalledWith(
      expect.stringContaining("cleanupError=trajectory record failed"),
    );
  });
});
