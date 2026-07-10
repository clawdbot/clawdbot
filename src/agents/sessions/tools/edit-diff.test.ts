import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, generateDiffString, normalizeToLF } from "./edit-diff.js";

function getMismatchMessage(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  try {
    applyEditsToNormalizedContent(normalizeToLF(content), edits, "test.ts");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected edit mismatch");
}

describe("applyEditsToNormalizedContent", () => {
  it("shows the closest matching line with expected, found, and difference marker", () => {
    const message = getMismatchMessage(
      "line one\nthis is a test line\nanother line here\nconst value = 42;\nfinal line\n",
      [{ oldText: "const value = 99;", newText: "" }],
    );

    expect(message).toMatch(/near line 4 \(\d+% match\)/);
    expect(message).toContain('expected: "const value = 99;"');
    expect(message).toContain('found:    "const value = 42;"');
    expect(message).toMatch(/\^{1,12}/);
  });

  it("shows up to 3 best candidates sorted by similarity", () => {
    const message = getMismatchMessage(
      "function alpha() {}\nfunction beta() {}\nfunction bet() {}\nfunction delta() {}\n",
      [{ oldText: "function betaa() {}", newText: "" }],
    );

    expect(message.match(/near line/g)).toHaveLength(3);
    expect(message.indexOf("near line 2")).toBeLessThan(message.indexOf("near line 3"));
  });

  it("uses the most meaningful oldText line for multiline diagnostics", () => {
    const message = getMismatchMessage("header\nconst actualValue = 42;\nfooter\n", [
      { oldText: "x\nconst actualValue = 99;\n", newText: "" },
    ]);

    expect(message).toContain("near line 2");
    expect(message).toContain('expected: "const actualValue = 99;"');
  });

  it("calls out indentation differences", () => {
    const message = getMismatchMessage("      const value = 42;\n", [
      { oldText: "            const value = 42;", newText: "" },
    ]);

    expect(message).toContain("indentation differs (expected 12 spaces, found 6 spaces)");
  });

  it("calls out escaping differences", () => {
    const message = getMismatchMessage('const pattern = "\\bword\\b";\n', [
      { oldText: 'const pattern = "\\\\bword\\\\b";', newText: "" },
    ]);

    expect(message).toContain("escaping differs (expected 4 backslashes, found 2)");
  });

  it("omits candidates below the similarity threshold", () => {
    const message = getMismatchMessage("abc\nxyz\n123\n", [
      { oldText: "completely different text here", newText: "" },
    ]);

    expect(message).toContain("Could not find the exact text");
    expect(message).not.toContain("Closest matching lines");
  });

  it("bounds candidate scanning and displayed line length", () => {
    const content = `${Array.from({ length: 1000 }, () => "unrelated").join("\n")}\n${"x".repeat(
      200_000,
    )}const value = 42;`;
    const message = getMismatchMessage(content, [{ oldText: "const value = 99;", newText: "" }]);

    expect(message).not.toContain("const value = 42");
    expect(message.length).toBeLessThan(1000);
  });

  it("does not split surrogate pairs at the displayed line boundary", () => {
    const message = getMismatchMessage(`${"x".repeat(119)}🙂found\n`, [
      { oldText: `${"x".repeat(119)}🙂expected`, newText: "" },
    ]);

    expect(message).toContain("Closest matching lines");
    expect(message).not.toContain("\\ud83d");
  });

  it("includes candidate hints for multi-edit failures", () => {
    const message = getMismatchMessage("alpha\nbeta\ngamma\n", [
      { oldText: "alpha", newText: "A" },
      { oldText: "bta", newText: "B" },
    ]);

    expect(message).toMatch(/Could not find edits\[1\][\s\S]*near line 2/);
  });
});

describe("generateDiffString", () => {
  it("numbers context lines from the new file after an insertion", () => {
    const result = generateDiffString(
      "first\nthird\nfourth\n",
      "first\nsecond\nthird\nfourth\n",
      2,
    );

    expect(result.diff).toContain("+2 second");
    expect(result.diff).toContain(" 3 third");
    expect(result.diff).toContain(" 4 fourth");
  });

  it("numbers context lines from the new file after a deletion", () => {
    const result = generateDiffString(
      "first\nsecond\nthird\nfourth\n",
      "first\nthird\nfourth\n",
      2,
    );

    expect(result.diff).toContain("-2 second");
    expect(result.diff).toContain(" 2 third");
    expect(result.diff).toContain(" 3 fourth");
  });
});
