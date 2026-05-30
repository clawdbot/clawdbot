import { describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS, setSafeTimeout } from "./timer-delay.js";

describe("setSafeTimeout", () => {
  it("arms setTimeout with the clamped delay", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const callback = () => undefined;

    const timer = setSafeTimeout(callback, 3_000_000_000);
    clearTimeout(timer);

    expect(timeoutSpy).toHaveBeenCalledWith(callback, MAX_SAFE_TIMEOUT_DELAY_MS);
    timeoutSpy.mockRestore();
  });
});
