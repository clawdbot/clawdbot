import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMediaCleanupDrain } from "./server-media-cleanup-lifecycle.js";
import { createGatewayServerMutableState } from "./server-runtime-handles.js";

describe("createGatewayServerMutableState", () => {
  afterEach(() => vi.useRealTimers());

  it("fences prior-generation media cleanup before maintenance installs", async () => {
    vi.useFakeTimers();
    let resolveDrain = () => {};
    registerMediaCleanupDrain(
      new Promise<void>((resolve) => {
        resolveDrain = resolve;
      }),
    );
    const state = createGatewayServerMutableState();

    const stopping = state.stopMediaCleanup();
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopping).resolves.toBe("timed-out");

    resolveDrain();
    await vi.advanceTimersByTimeAsync(0);
    const restartedState = createGatewayServerMutableState();
    await expect(restartedState.stopMediaCleanup()).resolves.toBe("drained");
    for (const runtimeState of [state, restartedState]) {
      clearInterval(runtimeState.tickInterval);
      clearInterval(runtimeState.healthInterval);
      clearInterval(runtimeState.dedupeCleanup);
    }
  });
});
