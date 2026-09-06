import { describe, expect, it } from "vitest";
import { pairSessionDiffLines } from "./session-diff-split.ts";
import type { DiffLine } from "./tool-call-diff.ts";

describe("pairSessionDiffLines", () => {
  it("pairs uneven change runs and spans context and gap rows", () => {
    const lines: DiffLine[] = [
      { kind: "ctx", lineNo: 3, text: "before" },
      { kind: "del", lineNo: 4, text: "old one" },
      { kind: "del", lineNo: 5, text: "old two" },
      { kind: "add", lineNo: 4, text: "new" },
      { kind: "skip", text: "8 unmodified lines" },
    ];

    expect(pairSessionDiffLines(lines)).toEqual([
      { kind: "span", line: lines[0] },
      { kind: "pair", left: lines[1], right: lines[3] },
      { kind: "pair", left: lines[2] },
      { kind: "span", line: lines[4] },
    ]);
  });
});
