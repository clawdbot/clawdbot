import { describe, expect, it } from "vitest";
import { parseHttpIdleTimeoutMs } from "./http-dispatcher.js";

describe("parseHttpIdleTimeoutMs", () => {
  it("parses configured idle timeout strings", () => {
    expect(parseHttpIdleTimeoutMs("30000")).toBe(30_000);
    expect(parseHttpIdleTimeoutMs("disabled")).toBe(0);
    expect(parseHttpIdleTimeoutMs("  ")).toBeUndefined();
  });

  it("rejects non-decimal idle timeout strings", () => {
    expect(parseHttpIdleTimeoutMs("1e3")).toBeUndefined();
    expect(parseHttpIdleTimeoutMs("0x10")).toBeUndefined();
  });

  it("preserves numeric idle timeout normalization", () => {
    expect(parseHttpIdleTimeoutMs(42.8)).toBe(42);
    expect(parseHttpIdleTimeoutMs(-1)).toBeUndefined();
  });
});
