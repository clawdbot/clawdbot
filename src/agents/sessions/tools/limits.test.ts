// Session tool limit tests cover shared numeric normalization and byte-bounded
// output tails for command-style tools.
import { describe, expect, it } from "vitest";
import {
  appendBoundedTextTail,
  normalizePositiveLimit,
  SESSION_TOOL_STDERR_TAIL_BYTES,
} from "./limits.js";

describe("session tool limits", () => {
  it.each([
    [undefined, 500],
    [Number.NaN, 500],
    [Number.POSITIVE_INFINITY, 500],
    [0, 1],
    [-12, 1],
    [2.9, 2],
    [7, 7],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePositiveLimit(input, 500)).toBe(expected);
  });

  it("keeps a bounded tail of accumulated child output", () => {
    let output = appendBoundedTextTail("old-", "middle-", 12);
    output = appendBoundedTextTail(output, "recent", 12);

    expect(output).toBe("iddle-recent");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(12);
  });

  it("clips oversized chunks to the configured tail bytes", () => {
    const output = appendBoundedTextTail("ignored", "x".repeat(128), 16);

    expect(output).toBe("x".repeat(16));
    expect(Buffer.byteLength(output, "utf8")).toBe(16);
  });

  it("does not exceed the byte cap when clipping multibyte text", () => {
    // Never return a partial UTF-8 character just to fill the final byte.
    const output = appendBoundedTextTail("ignored", "é", 1);

    expect(output).toBe("");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(1);
  });

  it("keeps complete multibyte characters at the bounded tail", () => {
    const output = appendBoundedTextTail("prefix", "aé", 2);

    expect(output).toBe("é");
    expect(Buffer.byteLength(output, "utf8")).toBe(2);
  });

  it("drops orphan continuation bytes when the byte window splits a character", () => {
    // "aaaa😀ccccccc" is 15 bytes; a 6-byte chunk under a 16-byte cap keeps a
    // 10-byte tail whose cut lands inside the 4-byte emoji. The orphan
    // continuation bytes must not surface as U+FFFD at the head of the tail.
    const output = appendBoundedTextTail("aaaa😀ccccccc", "dddddd", 16);

    expect(output).toBe("cccccccdddddd");
    expect(output).not.toContain("�");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(16);
  });

  it("uses the session stderr tail limit by default", () => {
    const output = appendBoundedTextTail("", "x".repeat(SESSION_TOOL_STDERR_TAIL_BYTES + 1));

    expect(Buffer.byteLength(output, "utf8")).toBe(SESSION_TOOL_STDERR_TAIL_BYTES);
  });
});
