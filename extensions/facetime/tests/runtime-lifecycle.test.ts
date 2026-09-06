import { describe, expect, it, vi } from "vitest";
import { stopRetainedRuntime } from "../src/runtime-lifecycle.js";

describe("FaceTime runtime lifecycle", () => {
  it("clears the runtime reference even when the host will swallow ordinary stop failure", async () => {
    const runtime = Promise.resolve({
      stop: vi.fn(async () => {
        throw new Error("carrier hangup pending");
      }),
    });
    const clearIfCurrent = vi.fn();

    await expect(stopRetainedRuntime(runtime, clearIfCurrent)).rejects.toThrow(
      "carrier hangup pending",
    );
    expect(clearIfCurrent).toHaveBeenCalledWith(runtime);
  });

  it("clears a rejected runtime-construction promise so startup can recover", async () => {
    const runtime = Promise.reject(new Error("startup failed"));
    const clearIfCurrent = vi.fn();

    await expect(stopRetainedRuntime(runtime, clearIfCurrent)).rejects.toThrow("startup failed");
    expect(clearIfCurrent).toHaveBeenCalledWith(runtime);
  });

  it("clears the same runtime only after stop succeeds", async () => {
    const runtime = Promise.resolve({ stop: vi.fn(async () => {}) });
    const clearIfCurrent = vi.fn();

    await stopRetainedRuntime(runtime, clearIfCurrent);

    expect(clearIfCurrent).toHaveBeenCalledWith(runtime);
  });
});
