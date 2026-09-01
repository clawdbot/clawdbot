import { afterEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn }),
}));

import { createMediaGenerationAsyncStartCallback } from "./openclaw-tools.media-yield.js";

describe("createMediaGenerationAsyncStartCallback", () => {
  afterEach(() => {
    vi.useRealTimers();
    warn.mockClear();
  });

  it("contains synchronous onYield failures", async () => {
    vi.useFakeTimers();
    const callback = createMediaGenerationAsyncStartCallback({
      onYield: () => {
        throw new Error("yield failed synchronously");
      },
    });

    expect(callback).toBeTypeOf("function");
    callback?.("media generation started");
    expect(() => vi.runAllTimers()).not.toThrow();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Failed to yield foreground media generation turn",
      { error: "yield failed synchronously" },
    );
  });
});
