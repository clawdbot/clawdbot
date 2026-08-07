import { beforeEach, describe, expect, it } from "vitest";
import { createLlamaCppInferenceRuntimeToken } from "./inference-runtime-coordinator.js";

const testApi = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.llamaCppInferenceTestApi")
] as {
  resetInferenceRuntimeCoordinator: () => void;
};

function createLiveToken() {
  let live = true;
  const token = createLlamaCppInferenceRuntimeToken();
  return {
    acquire: (signal?: AbortSignal) =>
      token.acquire({ signal, isLive: () => live, onRestartRequired: () => undefined }),
    dispose: () => {
      live = false;
      token.close();
    },
    fail: token.fail,
    release: token.release,
  };
}

beforeEach(() => {
  testApi.resetInferenceRuntimeCoordinator();
});

describe("llama.cpp inference runtime coordinator", () => {
  it("does not reserve native ownership until a runtime acquires it", async () => {
    createLiveToken();
    const replacement = createLiveToken();

    await expect(replacement.acquire()).resolves.toBeUndefined();
  });

  it("hands native ownership to rapid contenders one generation at a time", async () => {
    const first = createLiveToken();
    const second = createLiveToken();
    const third = createLiveToken();
    await first.acquire();
    let secondAcquired = false;
    let thirdAcquired = false;
    const secondAcquisition = second.acquire().then(() => {
      secondAcquired = true;
    });
    const thirdAcquisition = third.acquire().then(() => {
      thirdAcquired = true;
    });

    first.release();
    await secondAcquisition;
    expect(secondAcquired).toBe(true);
    expect(thirdAcquired).toBe(false);

    second.release();
    await thirdAcquisition;
    expect(thirdAcquired).toBe(true);
  });

  it("skips a disposed waiter before handing ownership to the next runtime", async () => {
    const first = createLiveToken();
    const disposed = createLiveToken();
    const replacement = createLiveToken();
    await first.acquire();
    const disposedAcquisition = disposed.acquire();
    let replacementAcquired = false;
    const replacementAcquisition = replacement.acquire().then(() => {
      replacementAcquired = true;
    });

    disposed.dispose();

    await expect(disposedAcquisition).rejects.toThrow("runtime is stopping");
    expect(replacementAcquired).toBe(false);

    first.release();
    await expect(replacementAcquisition).resolves.toBeUndefined();
  });

  it("removes an aborted waiter without letting it claim ownership", async () => {
    const first = createLiveToken();
    const aborted = createLiveToken();
    const replacement = createLiveToken();
    const abortController = new AbortController();
    await first.acquire();
    const abortedAcquisition = aborted.acquire(abortController.signal);
    const replacementAcquisition = replacement.acquire();

    abortController.abort();
    first.release();

    await expect(abortedAcquisition).rejects.toThrow();
    await expect(replacementAcquisition).resolves.toBeUndefined();
  });

  it("latches cleanup failure for current and future waiters", async () => {
    const first = createLiveToken();
    const waiting = createLiveToken();
    await first.acquire();
    const waitingAcquisition = waiting.acquire();

    first.fail(new Error("native cleanup failed"));

    await expect(waitingAcquisition).rejects.toMatchObject({
      name: "LlamaCppInferenceRestartRequiredError",
      code: "LLAMA_CPP_INFERENCE_RESTART_REQUIRED",
    });
    await expect(createLiveToken().acquire()).rejects.toMatchObject({
      name: "LlamaCppInferenceRestartRequiredError",
      code: "LLAMA_CPP_INFERENCE_RESTART_REQUIRED",
    });
  });
});
