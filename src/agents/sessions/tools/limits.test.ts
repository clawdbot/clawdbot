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

  it.each([
    { chunks: ["old-", "middle-", "recent"], cap: 12, tail: "iddle-recent", dropped: 5 },
    { chunks: ["ignored", "x".repeat(128)], cap: 16, tail: "x".repeat(16), dropped: 119 },
    { chunks: ["é"], cap: 1, tail: "", dropped: 2 },
    { chunks: ["prefix", "aé"], cap: 2, tail: "é", dropped: 7 },
    // The cap cuts inside the emoji; orphan continuation bytes must also be counted.
    { chunks: ["aaaa😀ccccccc", "dddddd"], cap: 16, tail: "cccccccdddddd", dropped: 8 },
    { chunks: ["short", " note"], cap: 16, tail: "short note", dropped: 0 },
  ])(
    "retains $tail and accounts for $dropped discarded bytes",
    ({ chunks, cap, tail, dropped }) => {
      let retained = "";
      let discarded = 0;
      for (const chunk of chunks) {
        const appended = appendBoundedTextTail(retained, chunk, cap);
        retained = appended.tail;
        discarded += appended.droppedBytes;
      }
      expect(retained).toBe(tail);
      expect(retained).not.toContain("�");
      expect(discarded).toBe(dropped);
      expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(cap);
      expect(Buffer.byteLength(retained) + discarded).toBe(Buffer.byteLength(chunks.join("")));
    },
  );

  it("uses the session stderr tail limit by default", () => {
    const output = appendBoundedTextTail("", "x".repeat(SESSION_TOOL_STDERR_TAIL_BYTES + 1));

    expect(Buffer.byteLength(output.tail, "utf8")).toBe(SESSION_TOOL_STDERR_TAIL_BYTES);
    expect(output.droppedBytes).toBe(1);
  });
});
