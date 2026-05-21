import { describe, expect, it } from "vitest";
import { parsePort } from "./parse-port.js";

describe("parsePort (#83899, #83900)", () => {
  it("returns null for nullish inputs", () => {
    expect(parsePort(undefined)).toBeNull();
    expect(parsePort(null)).toBeNull();
  });

  it("returns null for zero and negative values", () => {
    expect(parsePort(0)).toBeNull();
    expect(parsePort(-1)).toBeNull();
    expect(parsePort("0")).toBeNull();
  });

  it("accepts valid TCP port values", () => {
    expect(parsePort(1)).toBe(1);
    expect(parsePort(8080)).toBe(8080);
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort(" 65535 ")).toBe(65_535);
  });

  it("rejects port numbers above 65535", () => {
    expect(parsePort(65_536)).toBeNull();
    expect(parsePort(99999)).toBeNull();
    expect(parsePort("100000")).toBeNull();
    expect(parsePort(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    // Largest 16-bit value is the inclusive boundary.
    expect(parsePort(65_535)).toBe(65_535);
  });

  it("rejects non-integer and non-finite inputs", () => {
    expect(parsePort(1.5)).toBeNull();
    expect(parsePort("1.5")).toBeNull();
    expect(parsePort(Number.NaN)).toBeNull();
    expect(parsePort(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("8080ms")).toBeNull();
  });
});
