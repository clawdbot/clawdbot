// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSessionDiffPatch } from "./session-diff.ts";

const gap = (count: number) => `${count} unmodified lines`;

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -3,3 +3,4 @@ header",
  " context",
  "-old line",
  "+new line",
  "+added line",
  "@@ -160,2 +161,2 @@",
  " more context",
  "-tail old",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseSessionDiffPatch", () => {
  it("numbers rows and inserts gap markers between hunks", () => {
    const { lines, truncated } = parseSessionDiffPatch(PATCH, gap);
    expect(truncated).toBe(false);
    // Leading gap: first hunk starts at old line 3.
    expect(lines[0]).toEqual({ kind: "skip", text: "2 unmodified lines" });
    expect(lines[1]).toEqual({ kind: "ctx", lineNo: 3, text: "context" });
    expect(lines[2]).toEqual({ kind: "del", lineNo: 4, text: "old line" });
    expect(lines[3]).toEqual({ kind: "add", lineNo: 4, text: "new line" });
    expect(lines[4]).toEqual({ kind: "add", lineNo: 5, text: "added line" });
    // Gap between hunk 1 (old lines 3-4 consumed) and hunk 2 (old line 160).
    expect(lines[5]).toEqual({ kind: "skip", text: "155 unmodified lines" });
    expect(lines[6]).toEqual({ kind: "ctx", lineNo: 161, text: "more context" });
    expect(lines[7]).toEqual({ kind: "del", lineNo: 161, text: "tail old" });
    expect(lines).toHaveLength(8);
  });

  it("skips the leading gap for new files", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");
    const { lines } = parseSessionDiffPatch(patch, gap);
    expect(lines).toEqual([
      { kind: "add", lineNo: 1, text: "one" },
      { kind: "add", lineNo: 2, text: "two" },
    ]);
  });

  it("bounds output and reports truncation", () => {
    const body = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join("\n");
    const patch = `--- a/x\n+++ b/x\n@@ -1,0 +1,50 @@\n${body}\n`;
    const { lines, truncated } = parseSessionDiffPatch(patch, gap, 10);
    expect(truncated).toBe(true);
    expect(lines).toHaveLength(10);
  });
});
