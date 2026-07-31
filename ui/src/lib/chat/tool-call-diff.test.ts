// @vitest-environment node
// Control UI tests cover inline diff parsing and computation for tool-call rows.
import { describe, expect, it } from "vitest";
import {
  buildWriteDiffLines,
  computeLineDiff,
  countTextLines,
  diffStat,
  joinDiffSections,
  parseDiffDetailsString,
  type DiffLine,
} from "./tool-call-diff.ts";

describe("parseDiffDetailsString", () => {
  it("parses numbered add/del/ctx lines and skip markers", () => {
    const diff = [" 455 before", "-456 old line", "+456 new line", "    ...", " 460 after"].join(
      "\n",
    );

    expect(parseDiffDetailsString(diff)).toEqual([
      { kind: "ctx", lineNo: 455, text: "before" },
      { kind: "del", lineNo: 456, text: "old line" },
      { kind: "add", lineNo: 456, text: "new line" },
      { kind: "skip", text: "" },
      { kind: "ctx", lineNo: 460, text: "after" },
    ]);
  });

  it("accepts the persisted history truncation marker", () => {
    expect(parseDiffDetailsString("+12 kept line\n...(truncated)...")).toEqual([
      { kind: "add", lineNo: 12, text: "kept line" },
      { kind: "skip", text: "" },
    ]);
  });

  it.each([
    ["empty input", ""],
    ["whitespace-only input", "   \n  "],
    ["unrecognized format", "not a numbered diff"],
    ["no added or removed lines", " 1 only context\n 2 more context"],
  ])("returns null for %s", (_label, diff) => {
    expect(parseDiffDetailsString(diff)).toBeNull();
  });

  it("truncates oversized diffs with a trailing skip line", () => {
    const diff = Array.from({ length: 450 }, (_, i) => `+${i + 1} line ${i + 1}`).join("\n");

    const lines = parseDiffDetailsString(diff);

    expect(lines).toHaveLength(402);
    expect(lines?.at(-1)).toEqual({ kind: "skip", text: "" });
  });
});

describe("computeLineDiff", () => {
  it("diffs changed lines with surrounding context", () => {
    expect(computeLineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "ctx", text: "c" },
    ]);
  });

  it("treats a trailing newline as no extra line", () => {
    expect(computeLineDiff("foo\n", "bar\n")).toEqual([
      { kind: "del", text: "foo" },
      { kind: "add", text: "bar" },
    ]);
  });

  it("normalizes CRLF endings before diffing", () => {
    expect(computeLineDiff("a\r\nb", "a\nb")).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "ctx", text: "b" },
    ]);
  });

  it("caps rendered output with a trailing skip line", () => {
    const newText = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");

    const lines = computeLineDiff("only old line", newText);

    expect(lines).toHaveLength(401);
    expect(lines.at(-1)).toEqual({ kind: "skip", text: "" });
  });

  it("keeps a late change instead of spending the preview budget on context", () => {
    const oldLines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[450] = "changed late";

    const lines = computeLineDiff(oldLines.join("\n"), newLines.join("\n"));

    expect(lines).toContainEqual({ kind: "add", text: "changed late" });
    expect(lines).toContainEqual({ kind: "del", text: "line 450" });
    expect(lines.length).toBeLessThanOrEqual(401);
  });

  it("shows only truncation when the change is beyond the input work budget", () => {
    const oldLines = Array.from({ length: 700 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[650] = "outside budget";

    expect(computeLineDiff(oldLines.join("\n"), newLines.join("\n"))).toEqual([
      { kind: "skip", text: "" },
    ]);
  });
});

describe("buildWriteDiffLines", () => {
  it("numbers every content line as an addition from line 1", () => {
    expect(buildWriteDiffLines("one\ntwo\nthree\n")).toEqual([
      { kind: "add", lineNo: 1, text: "one" },
      { kind: "add", lineNo: 2, text: "two" },
      { kind: "add", lineNo: 3, text: "three" },
    ]);
  });

  it("truncates past maxLines with a skip marker", () => {
    expect(buildWriteDiffLines("a\nb\nc\nd", 2)).toEqual([
      { kind: "add", lineNo: 1, text: "a" },
      { kind: "add", lineNo: 2, text: "b" },
      { kind: "skip", text: "" },
    ]);
  });
});

describe("diffStat", () => {
  it("counts only added and removed lines", () => {
    const lines: DiffLine[] = [
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
      { kind: "del", text: "c" },
      { kind: "ctx", text: "d" },
      { kind: "skip", text: "" },
    ];

    expect(diffStat(lines)).toEqual({ added: 2, removed: 1 });
  });
});

describe("joinDiffSections", () => {
  it("separates non-empty sections with skip lines and drops empty ones", () => {
    const first: DiffLine[] = [{ kind: "del", text: "old" }];
    const second: DiffLine[] = [{ kind: "add", text: "new" }];

    expect(joinDiffSections([first, [], second])).toEqual([
      { kind: "del", text: "old" },
      { kind: "skip", text: "" },
      { kind: "add", text: "new" },
    ]);
  });

  it("enforces one render-row budget across every section", () => {
    const first = Array.from<unknown, DiffLine>({ length: 250 }, (_, index) => ({
      kind: "add",
      text: `first ${index}`,
    }));
    const second = Array.from<unknown, DiffLine>({ length: 250 }, (_, index) => ({
      kind: "del",
      text: `second ${index}`,
    }));

    const joined = joinDiffSections([first, second]);

    expect(joined).toHaveLength(401);
    expect(joined.at(-1)).toEqual({ kind: "skip", text: "" });
  });
});

describe("countTextLines", () => {
  it.each([
    ["a", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
  ])("counts %j as %d lines", (content, expected) => {
    expect(countTextLines(content)).toBe(expected);
  });
});
