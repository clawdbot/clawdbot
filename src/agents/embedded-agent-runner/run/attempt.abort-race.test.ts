import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt abort races", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("stops before session creation when aborted during eager lock acquisition", async () => {
    const abortController = new AbortController();
    const prompt = vi.fn(async () => {});
    const abortError = new Error("stopped during lock acquisition");
    abortError.name = "AbortError";
    let markLockRequested!: () => void;
    let observedSignal: AbortSignal | undefined;
    const lockRequested = new Promise<void>((resolve) => {
      markLockRequested = resolve;
    });
    hoisted.acquireSessionWriteLockMock.mockImplementationOnce(async (params) => {
      observedSignal = params.signal;
      markLockRequested();
      await new Promise<void>((resolve) => {
        params.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw params.signal?.reason;
    });

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:123",
      tempPaths,
      sessionPrompt: prompt,
      attemptOverrides: {
        abortSignal: abortController.signal,
      },
    });
    await lockRequested;
    abortController.abort(abortError);

    await expect(attempt).rejects.toBe(abortError);

    expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(observedSignal).toBe(abortController.signal);
  });
});
