// Memory Host SDK tests cover read retry behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryTransientMemoryRead } from "./read-retry.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("retryTransientMemoryRead", () => {
  it("uses a short two-retry budget for transient file read errors", async () => {
    const err = new Error("Unknown system error -11: Unknown system error -11, read");
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(err);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await expect(retryTransientMemoryRead(run)).rejects.toThrow("Unknown system error -11");

    expect(run).toHaveBeenCalledTimes(3);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 25);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 50);
  });
});
