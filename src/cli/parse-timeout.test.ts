import { describe, expect, it } from "vitest";
import { parseTimeoutMs, parseTimeoutMsWithFallback } from "./parse-timeout.js";

describe("parseTimeoutMs", () => {
  it("parses positive string values", () => {
    expect(parseTimeoutMs("1500")).toBe(1500);
  });

  it("returns undefined for empty or invalid values", () => {
    expect(parseTimeoutMs(undefined)).toBeUndefined();
    expect(parseTimeoutMs("")).toBeUndefined();
    expect(parseTimeoutMs("nope")).toBeUndefined();
  });
});

describe("parseTimeoutMsWithFallback", () => {
  it("returns the fallback for missing or empty values", () => {
    expect(parseTimeoutMsWithFallback(undefined, 3000)).toBe(3000);
    expect(parseTimeoutMsWithFallback(null, 3000)).toBe(3000);
    expect(parseTimeoutMsWithFallback("  ", 3000)).toBe(3000);
  });

  it("parses positive numbers and strings", () => {
    expect(parseTimeoutMsWithFallback(2500, 3000)).toBe(2500);
    expect(parseTimeoutMsWithFallback(2500n, 3000)).toBe(2500);
    expect(parseTimeoutMsWithFallback("2500", 3000)).toBe(2500);
  });

  it("falls back on unsupported types by default", () => {
    expect(parseTimeoutMsWithFallback({}, 3000)).toBe(3000);
  });

  it("throws on unsupported types when requested", () => {
    expect(() => parseTimeoutMsWithFallback({}, 3000, { invalidType: "error" })).toThrow(
      "Invalid --timeout",
    );
  });

  it("throws on non-positive parsed values", () => {
    expect(() => parseTimeoutMsWithFallback("0", 3000)).toThrow('Received: "0"');
    expect(() => parseTimeoutMsWithFallback("-1", 3000)).toThrow('Received: "-1"');
  });
});
