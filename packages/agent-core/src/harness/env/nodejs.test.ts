import { describe, expect, it } from "vitest";
import { resolveExecTimeoutMs } from "./nodejs.js";

describe("NodeExecutionEnv timeout helpers", () => {
  it("converts positive timeout seconds to milliseconds", () => {
    expect(resolveExecTimeoutMs(1)).toBe(1_000);
    expect(resolveExecTimeoutMs(1.5)).toBe(1_500);
    expect(resolveExecTimeoutMs(0.0005)).toBe(1);
  });

  it("caps oversized timeout seconds to a timer-safe delay", () => {
    expect(resolveExecTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(2_147_000_000);
  });

  it("ignores absent, invalid, or non-positive timeout seconds", () => {
    expect(resolveExecTimeoutMs(undefined)).toBeUndefined();
    expect(resolveExecTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolveExecTimeoutMs(0)).toBeUndefined();
    expect(resolveExecTimeoutMs(-1)).toBeUndefined();
  });
});
