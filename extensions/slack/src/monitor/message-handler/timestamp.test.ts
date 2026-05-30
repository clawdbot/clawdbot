import { describe, expect, it } from "vitest";
import { resolveSlackTimestampMs } from "./timestamp.js";

describe("resolveSlackTimestampMs", () => {
  it("parses Slack decimal timestamps as milliseconds", () => {
    expect(resolveSlackTimestampMs("171234.567")).toBe(171_234_567);
    expect(resolveSlackTimestampMs(" 171234.567 ")).toBe(171_234_567);
  });

  it("rejects non-decimal JavaScript number spellings", () => {
    expect(resolveSlackTimestampMs("0x65")).toBeUndefined();
    expect(resolveSlackTimestampMs("1e3")).toBeUndefined();
    expect(resolveSlackTimestampMs("Infinity")).toBeUndefined();
  });

  it("rejects timestamps that would produce unsafe millisecond values", () => {
    expect(resolveSlackTimestampMs("9007199254741")).toBeUndefined();
    expect(resolveSlackTimestampMs("9007199254740993")).toBeUndefined();
  });
});
