import { describe, expect, it } from "vitest";
import {
  MEMORY_BATCH_FAILURE_LIMIT,
  recordMemoryBatchFailure,
  resetMemoryBatchFailureState,
} from "./manager-batch-state.js";

describe("memory batch state", () => {
  it("resets failures after recovery", () => {
    expect(
      resetMemoryBatchFailureState({
        enabled: true,
        count: 1,
        lastError: "batch failed",
        lastProvider: "openai",
      }),
    ).toEqual({
      enabled: true,
      count: 0,
      lastError: undefined,
      lastProvider: undefined,
    });
  });

  it("disables batching after repeated failures", () => {
    const once = recordMemoryBatchFailure(
      { enabled: true, count: 0 },
      { provider: "openai", message: "batch failed", attempts: 1 },
    );
    expect(once).toEqual({
      enabled: true,
      count: 1,
      lastError: "batch failed",
      lastProvider: "openai",
    });

    const twice = recordMemoryBatchFailure(once, {
      provider: "openai",
      message: "batch failed again",
      attempts: 1,
    });
    expect(twice).toEqual({
      enabled: false,
      count: MEMORY_BATCH_FAILURE_LIMIT,
      lastError: "batch failed again",
      lastProvider: "openai",
    });
  });

  it("force-disables batching immediately", () => {
    expect(
      recordMemoryBatchFailure(
        { enabled: true, count: 0 },
        { provider: "gemini", message: "not available", forceDisable: true },
      ),
    ).toEqual({
      enabled: false,
      count: MEMORY_BATCH_FAILURE_LIMIT,
      lastError: "not available",
      lastProvider: "gemini",
    });
  });

  it("leaves disabled state unchanged", () => {
    expect(
      recordMemoryBatchFailure(
        { enabled: false, count: MEMORY_BATCH_FAILURE_LIMIT, lastError: "x", lastProvider: "y" },
        { provider: "openai", message: "ignored" },
      ),
    ).toEqual({
      enabled: false,
      count: MEMORY_BATCH_FAILURE_LIMIT,
      lastError: "x",
      lastProvider: "y",
    });
  });
});
