import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  it("parses positive epoch milliseconds", () => {
    expect(parseAbsoluteTimeMs("1700000000000")).toBe(1_700_000_000_000);
  });

  it("rejects digit-only timestamps outside the Date range", () => {
    expect(parseAbsoluteTimeMs(String(Number.MAX_SAFE_INTEGER))).toBeNull();
  });
});
