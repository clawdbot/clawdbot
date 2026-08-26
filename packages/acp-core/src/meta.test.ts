// ACP Core tests cover meta behavior.
import { describe, expect, it } from "vitest";
import {
  readBool,
  readMetadataNumber,
  readMetadataString,
  readNonNegativeInteger,
} from "./meta.js";

describe("ACP metadata readers", () => {
  it("returns the first normalized string value", () => {
    expect(readMetadataString({ old: "  ", current: " session-1 " }, ["old", "current"])).toBe(
      "session-1",
    );
  });

  it("preserves false boolean values", () => {
    expect(readBool({ enabled: false, fallback: true }, ["enabled", "fallback"])).toBe(false);
  });

  it("accepts finite numbers and rejects non-numeric values", () => {
    expect(readMetadataNumber({ first: "1", second: 0 }, ["first", "second"])).toBe(0);
    expect(readMetadataNumber({ first: Number.POSITIVE_INFINITY }, ["first"])).toBeUndefined();
  });

  it("accepts zero as a non-negative integer", () => {
    expect(readNonNegativeInteger({ count: 0, fallback: 2 }, ["count", "fallback"])).toBe(0);
    expect(
      readNonNegativeInteger({ count: -1, fallback: 2.5 }, ["count", "fallback"]),
    ).toBeUndefined();
  });
});
