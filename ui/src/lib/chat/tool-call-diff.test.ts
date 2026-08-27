// @vitest-environment node
// Control UI tests cover inline diff parsing and computation for tool-call rows.
import { describe, expect, it } from "vitest";
import {
  buildWriteDiffLines,
  computeLineDiff,
  countTextLines,
  joinDiffSections,
  parseDiffDetailsString,
  type DiffLine,
} from "./tool-call-diff.ts";

describe("parseDiffDetailsString", () => {
  it("parses numbered add/del/ctx lines and skip markers", () => {
    const diff = [" 455 before", "-456 old line", "+456 new line", "    ...", " 460 after"].join(
      "\n",
    );

    expect(parseDiffDetailsString(diff)).toEqual({
      kind: "complete",
      lines: [
        { kind: "ctx", lineNo: 455, text: "before" },
        { kind: "del", lineNo: 456, text: "old line" },
        { kind: "add", lineNo: 456, text: "new line" },
        { kind: "skip", text: "" },
        { kind: "ctx", lineNo: 460, text: "after" },
      ],
      stat: { added: 1, removed: 1 },
    });
  });

  it("accepts the persisted history truncation marker", () => {
    expect(parseDiffDetailsString("+12 kept line\n...(truncated)...")).toEqual({
      kind: "truncated",
      lines: [
        { kind: "add", lineNo: 12, text: "kept line" },
        { kind: "skip", text: "" },
      ],
    });
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

    expect(lines).toMatchObject({ kind: "truncated" });
    expect(lines?.lines).toHaveLength(402);
    expect(lines?.lines.at(-1)).toEqual({ kind: "skip", text: "" });
  });
});

describe("computeLineDiff", () => {
  it("reports an incomplete comparison when the only change is beyond the work budget", () => {
    const oldLines = Array.from({ length: 700 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[650] = "outside budget";

    expect(computeLineDiff(oldLines.join("\n"), newLines.join("\n"))).toMatchObject({
      kind: "truncated",
      lines: [{ kind: "skip", text: "" }],
    });
  });

  it("reports an incomplete comparison when visible changes precede a truncated tail", () => {
    const oldLines = Array.from({ length: 700 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[500] = "visible change";
    newLines[650] = "outside budget";

    expect(computeLineDiff(oldLines.join("\n"), newLines.join("\n"))).toMatchObject({
      kind: "truncated",
      lines: expect.arrayContaining([
        { kind: "del", text: "line 500" },
        { kind: "add", text: "visible change" },
      ]),
    });
  });

  it("returns exact zero statistics for a normal unchanged comparison", () => {
    expect(computeLineDiff("alpha\nbeta", "alpha\nbeta", { compactUnchanged: true })).toEqual({
      kind: "complete",
      lines: [],
      stat: { added: 0, removed: 0 },
    });

    const longBody = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
    expect(computeLineDiff(longBody, longBody, { compactUnchanged: true })).toEqual({
      kind: "complete",
      lines: [],
      stat: { added: 0, removed: 0 },
    });
  });

  it("returns exact statistics for a normal changed comparison", () => {
    expect(computeLineDiff("alpha\nbeta", "alpha\ngamma")).toEqual({
      kind: "complete",
      lines: [
        { kind: "ctx", text: "alpha" },
        { kind: "del", text: "beta" },
        { kind: "add", text: "gamma" },
      ],
      stat: { added: 1, removed: 1 },
    });
  });

  it("treats a trailing newline as no extra line", () => {
    expect(computeLineDiff("foo\n", "bar\n").lines).toEqual([
      { kind: "del", text: "foo" },
      { kind: "add", text: "bar" },
    ]);
  });

  it("normalizes CRLF endings before diffing", () => {
    expect(computeLineDiff("a\r\nb", "a\nb").lines).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "ctx", text: "b" },
    ]);
  });

  it("caps rendered output with a trailing skip line", () => {
    const newText = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");

    const lines = computeLineDiff("only old line", newText).lines;

    expect(lines).toHaveLength(401);
    expect(lines.at(-1)).toEqual({ kind: "skip", text: "" });
  });

  it("keeps a late change instead of spending the preview budget on context", () => {
    const oldLines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[450] = "changed late";

    const lines = computeLineDiff(oldLines.join("\n"), newLines.join("\n")).lines;

    expect(lines).toContainEqual({ kind: "add", text: "changed late" });
    expect(lines).toContainEqual({ kind: "del", text: "line 450" });
    expect(lines.length).toBeLessThanOrEqual(401);
  });

  it("collapses unchanged runs to three context lines when asked", () => {
    const oldLines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const newLines = [...oldLines];
    newLines[20] = "changed";

    const full = computeLineDiff(oldLines.join("\n"), newLines.join("\n"));
    const compact = computeLineDiff(oldLines.join("\n"), newLines.join("\n"), {
      compactUnchanged: true,
    });

    expect(full.lines).toHaveLength(41);
    expect(compact.lines.filter((line) => line.kind === "ctx").map((line) => line.text)).toEqual([
      "line 17",
      "line 18",
      "line 19",
      "line 21",
      "line 22",
      "line 23",
    ]);
    expect(compact.lines.filter((line) => line.kind === "skip")).toHaveLength(2);
  });

  it("compacts an identical pair to nothing so callers can say unchanged", () => {
    const text = "alpha\nbeta\ngamma";

    expect(computeLineDiff(text, text, { compactUnchanged: true }).lines).toEqual([]);
    expect(computeLineDiff(text, text).lines).toHaveLength(3);
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

describe("joinDiffSections", () => {
  it("separates non-empty sections with skip lines and drops empty ones", () => {
    const first: DiffLine[] = [{ kind: "del", text: "old" }];
    const second: DiffLine[] = [{ kind: "add", text: "new" }];

    expect(
      joinDiffSections([
        { kind: "complete", lines: first, stat: { added: 0, removed: 1 } },
        { kind: "complete", lines: [], stat: { added: 0, removed: 0 } },
        { kind: "complete", lines: second, stat: { added: 1, removed: 0 } },
      ]),
    ).toEqual({
      kind: "complete",
      lines: [
        { kind: "del", text: "old" },
        { kind: "skip", text: "" },
        { kind: "add", text: "new" },
      ],
      stat: { added: 1, removed: 1 },
    });
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

    const joined = joinDiffSections([
      { kind: "complete", lines: first, stat: { added: 250, removed: 0 } },
      { kind: "complete", lines: second, stat: { added: 0, removed: 250 } },
    ]);

    expect(joined).toMatchObject({ kind: "complete", stat: { added: 250, removed: 250 } });
    expect(joined.lines).toHaveLength(401);
    expect(joined.lines.at(-1)).toEqual({ kind: "skip", text: "" });
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
