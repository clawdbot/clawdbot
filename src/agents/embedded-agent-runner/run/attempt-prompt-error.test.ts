import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  handleMidTurnPrecheckRequest: vi.fn(),
  isMidTurnPrecheckSignal: vi.fn(() => false),
  isSessionsYieldAbortError: vi.fn(() => false),
  markYieldAborted: vi.fn(),
  persistSessionsYieldContextMessage: vi.fn(async () => undefined),
  releaseHeldLockForAbort: vi.fn(async () => undefined),
  releaseLeasedSteering: vi.fn(),
  stripSessionsYieldArtifacts: vi.fn(),
  waitForSessionEvents: vi.fn(async () => undefined),
  waitForSessionsYieldAbortSettle: vi.fn(async () => undefined),
  withOwnedSessionWriteLock: vi.fn(async (operation: () => unknown) => await operation()),
}));

vi.mock("./attempt.sessions-yield.js", () => ({
  isSessionsYieldAbortError: hoisted.isSessionsYieldAbortError,
  persistSessionsYieldContextMessage: hoisted.persistSessionsYieldContextMessage,
  stripSessionsYieldArtifacts: hoisted.stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle: hoisted.waitForSessionsYieldAbortSettle,
}));
vi.mock("./midturn-precheck.js", () => ({
  isMidTurnPrecheckSignal: hoisted.isMidTurnPrecheckSignal,
}));

import { handleEmbeddedAttemptPromptError } from "./attempt-prompt-error.js";

type PromptErrorInput = Parameters<typeof handleEmbeddedAttemptPromptError>[0];

function createInput(overrides: Partial<PromptErrorInput> = {}): PromptErrorInput {
  return {
    activeSession: { agent: { state: { messages: [] } }, messages: [] },
    attempt: { runId: "run-1", sessionId: "session-1" },
    error: new Error("prompt failed"),
    handleMidTurnPrecheckRequest: hoisted.handleMidTurnPrecheckRequest,
    markYieldAborted: hoisted.markYieldAborted,
    releaseLeasedSteering: hoisted.releaseLeasedSteering,
    sessionLockController: {
      releaseHeldLockForAbort: hoisted.releaseHeldLockForAbort,
      waitForSessionEvents: hoisted.waitForSessionEvents,
    },
    withOwnedSessionWriteLock: hoisted.withOwnedSessionWriteLock,
    yieldAbortSettled: null,
    yieldDetected: false,
    yieldMessage: null,
    ...overrides,
  } as PromptErrorInput;
}

describe("handleEmbeddedAttemptPromptError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.isMidTurnPrecheckSignal.mockReturnValue(false);
    hoisted.isSessionsYieldAbortError.mockReturnValue(false);
  });

  it("returns ordinary provider failures to the prompt state owner", async () => {
    const error = new Error("provider failed");

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({
      promptFailure: { error, source: "prompt" },
    });

    expect(hoisted.releaseLeasedSteering).toHaveBeenCalledWith(error);
    expect(hoisted.waitForSessionEvents).not.toHaveBeenCalled();
  });

  it("routes mid-turn prechecks under the owned session lock", async () => {
    const request = {
      route: "compact_only",
      estimatedPromptTokens: 12,
      promptBudgetBeforeReserve: 10,
      overflowTokens: 2,
      toolResultReducibleChars: 0,
      effectiveReserveTokens: 1,
    } as const;
    const error = { request };
    hoisted.isMidTurnPrecheckSignal.mockReturnValue(true);

    await expect(handleEmbeddedAttemptPromptError(createInput({ error }))).resolves.toEqual({});

    expect(hoisted.waitForSessionEvents).toHaveBeenCalledOnce();
    expect(hoisted.withOwnedSessionWriteLock).toHaveBeenCalledOnce();
    expect(hoisted.handleMidTurnPrecheckRequest).toHaveBeenCalledWith(request);
  });

  it("settles yield aborts, strips artifacts, and persists handoff context", async () => {
    const settlePromise = Promise.resolve();
    const error = new Error("yield handoff");
    const input = createInput({
      error,
      yieldAbortSettled: settlePromise,
      yieldDetected: true,
      yieldMessage: "wait for follow-up",
    });
    hoisted.isSessionsYieldAbortError.mockReturnValue(true);

    await expect(handleEmbeddedAttemptPromptError(input)).resolves.toEqual({});

    expect(hoisted.markYieldAborted).toHaveBeenCalledOnce();
    expect(hoisted.waitForSessionsYieldAbortSettle).toHaveBeenCalledWith({
      settlePromise,
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(hoisted.releaseHeldLockForAbort).toHaveBeenCalledOnce();
    expect(hoisted.waitForSessionEvents).toHaveBeenCalledWith(input.activeSession);
    expect(hoisted.stripSessionsYieldArtifacts).toHaveBeenCalledWith(input.activeSession);
    expect(hoisted.persistSessionsYieldContextMessage).toHaveBeenCalledWith(
      input.activeSession,
      "wait for follow-up",
    );
  });

  it("marks yield state before fallible recovery begins", async () => {
    const recoveryError = new Error("settle failed");
    let marked = false;
    hoisted.isSessionsYieldAbortError.mockReturnValue(true);
    hoisted.waitForSessionsYieldAbortSettle.mockImplementationOnce(async () => {
      expect(marked).toBe(true);
      throw recoveryError;
    });

    await expect(
      handleEmbeddedAttemptPromptError(
        createInput({
          error: new Error("yield handoff"),
          markYieldAborted: () => {
            marked = true;
          },
          yieldDetected: true,
        }),
      ),
    ).rejects.toBe(recoveryError);
  });
});
