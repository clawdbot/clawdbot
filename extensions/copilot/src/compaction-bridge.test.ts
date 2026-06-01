import { describe, expect, it } from "vitest";
import { createInfiniteSessionConfig } from "./compaction-bridge.js";

describe("createInfiniteSessionConfig", () => {
  it("returns undefined when no options provided", () => {
    expect(createInfiniteSessionConfig()).toBeUndefined();
    expect(createInfiniteSessionConfig(undefined)).toBeUndefined();
  });

  it("returns undefined when options is an empty object", () => {
    expect(createInfiniteSessionConfig({})).toBeUndefined();
  });

  it("preserves explicit enabled:false to disable infinite sessions", () => {
    expect(createInfiniteSessionConfig({ enabled: false })).toEqual({ enabled: false });
  });

  it("preserves explicit enabled:true", () => {
    expect(createInfiniteSessionConfig({ enabled: true })).toEqual({ enabled: true });
  });

  it("forwards threshold fields when set", () => {
    expect(
      createInfiniteSessionConfig({
        backgroundCompactionThreshold: 0.7,
        bufferExhaustionThreshold: 0.9,
      }),
    ).toEqual({
      backgroundCompactionThreshold: 0.7,
      bufferExhaustionThreshold: 0.9,
    });
  });

  it("combines enabled and thresholds", () => {
    expect(
      createInfiniteSessionConfig({
        enabled: true,
        backgroundCompactionThreshold: 0.5,
        bufferExhaustionThreshold: 0.85,
      }),
    ).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.5,
      bufferExhaustionThreshold: 0.85,
    });
  });

  it("omits undefined fields without coercing them", () => {
    const result = createInfiniteSessionConfig({
      enabled: undefined,
      backgroundCompactionThreshold: 0.6,
      bufferExhaustionThreshold: undefined,
    });
    expect(result).toEqual({ backgroundCompactionThreshold: 0.6 });
    expect(result).not.toHaveProperty("enabled");
    expect(result).not.toHaveProperty("bufferExhaustionThreshold");
  });
});
