import { describe, expect, it } from "vitest";
import { applyEditsPreservingLineEndings, generateDiffString } from "./edit-diff.js";

function getMismatchMessage(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  try {
    applyEditsPreservingLineEndings(content, edits, "test.ts");
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

    expect(result).toEqual({
      diff: " 1 first\n+2 second\n 3 third\n 4 fourth",
      firstChangedLine: 2,
    });
  });

  it("numbers context lines from the new file after a deletion", () => {
    const result = generateDiffString(
      "first\nsecond\nthird\nfourth\n",
      "first\nthird\nfourth\n",
      2,
    );

    expect(result).toEqual({
      diff: " 1 first\n-2 second\n 2 third\n 3 fourth",
      firstChangedLine: 2,
    });
  });

  it("separates distant hunks without displaying dependency EOF markers", () => {
    const oldContent = Array.from({ length: 10 }, (_, index) => String(index + 1)).join("\n");
    const newContent = oldContent.replace(/^2$/m, "TWO").replace(/^9$/m, "NINE");

    expect(generateDiffString(oldContent, newContent, 1)).toEqual({
      diff: "  1 1\n- 2 2\n+ 2 TWO\n  3 3\n    ...\n  8 8\n- 9 9\n+ 9 NINE\n 10 10",
      firstChangedLine: 2,
    });
  });
});

describe("applyEditsToNormalizedContent uniqueness", () => {
  it("replaces an exactly unique match when trailing whitespace makes a sibling line fuzzy-identical", () => {
    const content = "foo();  \nfoo();\nbar();\n";

    const result = applyEditsPreservingLineEndings(
      content,
      [{ oldText: "foo();\n", newText: "baz();\n" }],
      "test.ts",
    );

    expect(result.newContent).toBe("foo();  \nbaz();\nbar();\n");
  });
});

describe("fuzzy edit — byte preservation on matched line", () => {
  it("preserves unicode bytes outside the edited span when fuzzy matching", () => {
    // Line has NBSP (U+00A0 between RETRY and MAX), fullwidth parens,
    // fullwidth digit, halfwidth katakana, and em-dash — all outside
    // the span being replaced.
    const content =
      'export const RETRY MAX = 3; // 再試行（最大３回）ｱｲｳ — 設定\nexport const OTHER = 1;\n';

    // oldText uses plain space instead of NBSP → triggers fuzzy match
    const edits = [
      { oldText: "export const RETRY MAX = 3;", newText: "export const RETRY_MAX = 5;" },
    ];

    const result = applyEditsPreservingLineEndings(content, edits, "config.ts");

    // The replacement itself must be applied
    expect(result.finalContent).toContain("RETRY_MAX = 5;");

    // The comment must remain byte-identical (no NFKC normalization)
    const originalComment = content.slice(content.indexOf("//"));
    const afterComment = result.finalContent.slice(result.finalContent.indexOf("//"));
    expect(afterComment).toBe(originalComment);

    // The exact-match path on the same file must produce the same result
    const exactContent =
      'export const RETRY MAX = 3; // 再試行（最大３回）ｱｲｳ — 設定\nexport const OTHER = 1;\n';
    const exactEdits = [
      {
        oldText: "export const RETRY MAX = 3;",
        newText: "export const RETRY_MAX = 5;",
      },
    ];
    const exactResult = applyEditsPreservingLineEndings(
      exactContent,
      exactEdits,
      "config.ts",
    );
    expect(result.finalContent).toBe(exactResult.finalContent);
  });

  it("preserves smart quotes in comments during fuzzy edit", () => {
    const content = 'let x = "hello"; // says "hello world" — nice\nlet y = 2;\n';
    // Use straight quotes in oldText while the file has smart quotes
    const edits = [{ oldText: 'let x = "hello";', newText: "let x = 'hi';" }];
    const result = applyEditsPreservingLineEndings(content, edits, "test.ts");

    expect(result.finalContent).toContain("let x = 'hi';");
    expect(result.finalContent).toContain('// says "hello world" — nice');
  });
});

describe("applyEditsToNormalizedContent fuzzy uniqueness", () => {
  it("still rejects a fuzzy match that is ambiguous once normalization is applied", () => {
    const content = "foo();  \nfoo();\t\nbar();\n";

    expect(() =>
      applyEditsPreservingLineEndings(
        content,
        [{ oldText: "foo();\n", newText: "baz();\n" }],
        "test.ts",
      ),
    ).toThrow(/Found 2 occurrences/);
  });
});
