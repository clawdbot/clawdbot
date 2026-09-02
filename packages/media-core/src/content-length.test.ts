import { describe, expect, it } from "vitest";
import { parseMediaContentLength } from "./content-length.js";

describe("parseMediaContentLength", () => {
  it.each([
    { raw: null, expected: null },
    { raw: "0", expected: 0 },
    { raw: " 42\t", expected: 42 },
    { raw: "42, 42", expected: 42 },
    { raw: "42,\t42, 42", expected: 42 },
    { raw: "042, 042", expected: 42 },
  ])("parses $raw", ({ raw, expected }) => {
    expect(parseMediaContentLength(raw)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "0x2a",
    "42,",
    ",42",
    "42, 43",
    "042, 42",
    "42,\u00a042",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("rejects %j", (raw) => {
    expect(() => parseMediaContentLength(raw)).toThrow(`invalid content-length header: ${raw}`);
  });
});
