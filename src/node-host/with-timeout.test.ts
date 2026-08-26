/** Tests node-host timeout handling, abort reasons, and cleanup behavior. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAbortableTimeout } from "./with-timeout.js";

describe("runAbortableTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps huge finite timeoutMs before scheduling the timer", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await expect(
      runAbortableTimeout(async (signal) => {
        expect(signal?.aborted).toBe(false);
        return "ok";
      }, Number.MAX_SAFE_INTEGER),
    ).resolves.toBe("ok");

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
