import { describe, expect, it } from "vitest";
import { parseDurationMs } from "./config-utils.js";

describe("parseDurationMs", () => {
  it("parses decimal durations into milliseconds", () => {
    expect(parseDurationMs("1.5s")).toBe(1_500);
    expect(parseDurationMs("1h30m")).toBe(5_400_000);
  });

  it("rejects unsafe millisecond results", () => {
    expect(() => parseDurationMs("9007199254740993ms")).toThrow(/invalid duration/u);
    expect(() => parseDurationMs("9007199254740990ms10ms")).toThrow(/invalid duration/u);
  });
});
