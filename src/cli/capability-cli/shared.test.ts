import { describe, expect, it } from "vitest";
import {
  parseOptionalFiniteNumber,
  parseOptionalPositiveInteger,
  parseOptionalTimeoutMs,
} from "./shared.js";

describe("capability CLI numeric option parsing", () => {
  it("keeps omitted optional values absent and parses valid values", () => {
    expect(parseOptionalFiniteNumber(undefined, "--duration")).toBeUndefined();
    expect(parseOptionalFiniteNumber("2.5", "--duration")).toBe(2.5);

    expect(parseOptionalPositiveInteger(undefined, "--limit")).toBeUndefined();
    expect(parseOptionalPositiveInteger("3", "--limit")).toBe(3);

    expect(parseOptionalTimeoutMs(undefined)).toBeUndefined();
    expect(parseOptionalTimeoutMs("1200")).toBe(1200);
  });

  it.each([
    ["--duration", () => parseOptionalFiniteNumber("", "--duration")],
    ["--duration", () => parseOptionalFiniteNumber("  ", "--duration")],
    ["--limit", () => parseOptionalPositiveInteger("", "--limit")],
    ["--limit", () => parseOptionalPositiveInteger("  ", "--limit")],
  ])("rejects explicit blank %s values", (label, parse) => {
    expect(parse).toThrow(`${label} must be`);
  });

  it.each(["", "  "])("rejects explicit blank --timeout-ms value %j", (raw) => {
    expect(() => parseOptionalTimeoutMs(raw)).toThrow("Invalid --timeout");
  });
});
