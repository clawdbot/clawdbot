import { describe, expect, it } from "vitest";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml,
} from "./format.js";

type TelegramChunk = ReturnType<typeof markdownToTelegramChunks>[number];

function expectHtmlChunkLengthsAtMost(chunks: TelegramChunk[], limit: number) {
  expect(chunks.some((chunk) => chunk.html.length > limit)).toBe(false);
}

function expectNonBlankTextChunks(chunks: TelegramChunk[]) {
  expect(chunks.some((chunk) => chunk.text.trim().length === 0)).toBe(false);
}

function expectHtmlChunksWrappedWith(chunks: TelegramChunk[], prefix: string, suffix: string) {
  expect(
    chunks.every((chunk) => chunk.html.startsWith(prefix) && chunk.html.endsWith(suffix)),
  ).toBe(true);
}

describe("wrapFileReferencesInHtml", () => {
  it("wraps supported file references and paths", () => {
    const cases = [
      ["Check README.md", "Check <code>README.md</code>"],
      ["See HEARTBEAT.md for status", "See <code>HEARTBEAT.md</code> for status"],
      ["Check main.go", "Check <code>main.go</code>"],
      ["Run script.py", "Run <code>script.py</code>"],
      ["Check backup.pl", "Check <code>backup.pl</code>"],
      ["Run backup.sh", "Run <code>backup.sh</code>"],
      ["Look at squad/friday/HEARTBEAT.md", "Look at <code>squad/friday/HEARTBEAT.md</code>"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(wrapFileReferencesInHtml(input), input).toContain(expected);
    }
  });

  it("does not wrap inside protected html contexts", () => {
    const cases = [
      "Already <code>wrapped.md</code> here",
      "<pre><code>README.md</code></pre>",
      '<a href="README.md">Link</a>',
      'Visit <a href="https://example.com/README.md">example.com/README.md</a>',
    ] as const;
    for (const input of cases) {
      const result = wrapFileReferencesInHtml(input);
      expect(result, input).toBe(input);
    }
    expect(wrapFileReferencesInHtml(cases[0])).not.toContain("<code><code>");
  });

  it("handles mixed content correctly", () => {
    const result = wrapFileReferencesInHtml("Check README.md and CONTRIBUTING.md");
    expect(result).toContain("<code>README.md</code>");
    expect(result).toContain("<code>CONTRIBUTING.md</code>");
  });

  it("handles boundary and punctuation wrapping cases", () => {
    const cases = [
      { input: "No markdown files here", contains: undefined },
      { input: "File.md at start", contains: "<code>File.md</code>" },
      { input: "Ends with file.md", contains: "<code>file.md</code>" },
      { input: "See README.md.", contains: "<code>README.md</code>." },
      { input: "See README.md,", contains: "<code>README.md</code>," },
      { input: "(README.md)", contains: "(<code>README.md</code>)" },
      { input: "README.md:", contains: "<code>README.md</code>:" },
    ] as const;

    for (const testCase of cases) {
      const result = wrapFileReferencesInHtml(testCase.input);
      if (!testCase.contains) {
        expect(result).not.toContain("<code>");
        continue;
      }
      expect(result).toContain(testCase.contains);
    }
  });

  it("de-linkifies auto-linkified anchors for plain files and paths", () => {
    const cases = [
      {
        input: '<a href="http://README.md">README.md</a>',
        expected: "<code>README.md</code>",
      },
      {
        input: '<a href="http://squad/friday/HEARTBEAT.md">squad/friday/HEARTBEAT.md</a>',
        expected: "<code>squad/friday/HEARTBEAT.md</code>",
      },
    ] as const;
    for (const testCase of cases) {
      expect(wrapFileReferencesInHtml(testCase.input)).toBe(testCase.expected);
    }
  });

  it("preserves explicit links where label differs from href", () => {
    const cases = [
      '<a href="http://README.md">click here</a>',
      '<a href="http://other.md">README.md</a>',
    ] as const;
    for (const input of cases) {
      expect(wrapFileReferencesInHtml(input)).toBe(input);
    }
  });

  it("wraps file ref after closing anchor tag", () => {
    const input = '<a href="https://example.com">link</a> then README.md';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toContain("</a> then <code>README.md</code>");
  });
});

describe("renderTelegramHtmlText - file reference wrapping", () => {
  it("wraps file references in markdown mode", () => {
    const result = renderTelegramHtmlText("Check README.md");
    expect(result).toContain("<code>README.md</code>");
  });

  it("does not wrap in HTML mode (trusts caller markup)", () => {
    // textMode: "html" should pass through unchanged - caller owns the markup
    const result = renderTelegramHtmlText("Check README.md", { textMode: "html" });
    expect(result).toBe("Check README.md");
    expect(result).not.toContain("<code>");
  });

  it("does not double-wrap already code-formatted content", () => {
    const result = renderTelegramHtmlText("Already `wrapped.md` here");
    // Should have code tags but not nested
    expect(result).toContain("<code>");
    expect(result).not.toContain("<code><code>");
  });
});

describe("markdownToTelegramHtml - file reference wrapping", () => {
  it("wraps file references by default", () => {
    const result = markdownToTelegramHtml("Check README.md");
    expect(result).toContain("<code>README.md</code>");
  });

  it("can skip wrapping when requested", () => {
    const result = markdownToTelegramHtml("Check README.md", { wrapFileRefs: false });
    expect(result).not.toContain("<code>README.md</code>");
  });

  it("wraps multiple file types in a single message", () => {
    const result = markdownToTelegramHtml("Edit main.go and script.py");
    expect(result).toContain("<code>main.go</code>");
    expect(result).toContain("<code>script.py</code>");
  });

  it("preserves real URLs as anchor tags", () => {
    const result = markdownToTelegramHtml("Visit https://example.com");
    expect(result).toContain('<a href="https://example.com">');
  });

  it("preserves explicit markdown links even when href looks like a file ref", () => {
    const result = markdownToTelegramHtml("[docs](http://README.md)");
    expect(result).toContain('<a href="http://README.md">docs</a>');
  });

  it("wraps file ref after real URL in same message", () => {
    const result = markdownToTelegramHtml("Visit https://example.com and README.md");
    expect(result).toContain('<a href="https://example.com">');
    expect(result).toContain("<code>README.md</code>");
  });
});

describe("markdownToTelegramChunks - file reference wrapping", () => {
  it("wraps file references in chunked output", () => {
    const chunks = markdownToTelegramChunks("Check README.md and backup.sh", 4096);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].html).toContain("<code>README.md</code>");
    expect(chunks[0].html).toContain("<code>backup.sh</code>");
  });

  it("keeps rendered html chunks within the provided limit", () => {
    const input = "<".repeat(1500);
    const chunks = markdownToTelegramChunks(input, 512);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    expectHtmlChunkLengthsAtMost(chunks, 512);
  });

  it("preserves whitespace when html-limit retry splitting runs", () => {
    const input = "a < b";
    const chunks = markdownToTelegramChunks(input, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    expectHtmlChunkLengthsAtMost(chunks, 5);
  });

  it("prefers word boundaries when escaped html shrinks the retry window", () => {
    const input = "alpha <<";
    const chunks = markdownToTelegramChunks(input, 8);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    expect(chunks[0]?.text).toBe("alpha ");
    expectHtmlChunkLengthsAtMost(chunks, 8);
  });

  it("prefers word boundaries when html-limit retry splits formatted prose", () => {
    const input = "**Which of these**";
    const chunks = markdownToTelegramChunks(input, 16);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Which of ", "these"]);
    expectHtmlChunkLengthsAtMost(chunks, 16);
  });

  it("preserves formatting while splitting at word boundaries", () => {
    const input = "**alpha <<**";
    const chunks = markdownToTelegramChunks(input, 13);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("alpha <<");
    expect(chunks[0]?.text).toBe("alpha ");
    expectHtmlChunkLengthsAtMost(chunks, 13);
    expectHtmlChunksWrappedWith(chunks, "<b>", "</b>");
  });

  it("does not rely on monotonic html length for sliced file refs", () => {
    const input = "README.md<";
    const chunks = markdownToTelegramChunks(input, 22);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    expect(chunks[0]?.text).toBe("README.md");
    expect(chunks[0]?.html).toBe("<code>README.md</code>");
    expectHtmlChunkLengthsAtMost(chunks, 22);
  });

  it("gracefully returns the original chunk when tag overhead exceeds the limit", () => {
    const input = "**ab**";
    const chunks = markdownToTelegramChunks(input, 6);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe("ab");
    expect(chunks[0]?.html).toBe("<b>ab</b>");
  });

  it("falls back to in-paren word boundaries when the parenthesis is unbalanced", () => {
    const input = "**foo (bar baz qux quux**";
    const chunks = markdownToTelegramChunks(input, 20);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["foo", "(bar baz qux ", "quux"]);
    expectHtmlChunkLengthsAtMost(chunks, 20);
  });

  it("falls back to hard splits when a single word exceeds the limit", () => {
    const input = "supercalifragilistic";
    const chunks = markdownToTelegramChunks(input, 8);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["supercal", "ifragili", "stic"]);
    expectHtmlChunkLengthsAtMost(chunks, 8);
  });

  it("does not emit whitespace-only chunks during html-limit retry splitting", () => {
    const input = "**ab  <<**";
    const chunks = markdownToTelegramChunks(input, 11);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("ab  <<");
    expectNonBlankTextChunks(chunks);
    expectHtmlChunkLengthsAtMost(chunks, 11);
  });

  it("preserves paragraph separators when retry chunking produces whitespace-only spans", () => {
    const input = "ab\n\n<<";
    const chunks = markdownToTelegramChunks(input, 6);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    expectHtmlChunkLengthsAtMost(chunks, 6);
  });
});

describe("edge cases", () => {
  it("wraps file refs inside emphasis tags", () => {
    const cases = [
      ["**README.md**", "<b><code>README.md</code></b>"],
      ["*script.py*", "<i><code>script.py</code></i>"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(markdownToTelegramHtml(input), input).toBe(expected);
    }
  });

  it("does not wrap inside fenced code blocks", () => {
    const result = markdownToTelegramHtml("```\nREADME.md\n```");
    expect(result).toBe("<pre><code>README.md\n</code></pre>");
    expect(result).not.toContain("<code><code>");
  });

  it("preserves real URL/domain paths as anchors", () => {
    const cases = [
      {
        input: "example.com/README.md",
        href: 'href="http://example.com/README.md"',
      },
      {
        input: "https://github.com/foo/README.md",
        href: 'href="https://github.com/foo/README.md"',
      },
    ] as const;
    for (const testCase of cases) {
      const result = markdownToTelegramHtml(testCase.input);
      expect(result).toContain(`<a ${testCase.href}>`);
      expect(result).not.toContain("<code>");
    }
  });

  it("handles wrapFileRefs: false (plain text output)", () => {
    const result = markdownToTelegramHtml("README.md", { wrapFileRefs: false });
    // buildTelegramLink returns null, so no <a> tag; wrapFileRefs: false skips <code>
    expect(result).toBe("README.md");
  });

  it("classifies extension-like tokens as file refs or domains", () => {
    const cases = [
      {
        name: "supported file-style extensions",
        input: "Makefile.am and code.at and app.be and main.cc",
        contains: [
          "<code>Makefile.am</code>",
          "<code>code.at</code>",
          "<code>app.be</code>",
          "<code>main.cc</code>",
        ],
      },
      {
        name: "popular domain TLDs stay links",
        input: "Check x.ai and vercel.io and app.tv and radio.fm",
        contains: [
          '<a href="http://x.ai">',
          '<a href="http://vercel.io">',
          '<a href="http://app.tv">',
          '<a href="http://radio.fm">',
        ],
      },
      {
        name: ".co stays links",
        input: "Visit t.co and openclaw.co",
        contains: ['<a href="http://t.co">', '<a href="http://openclaw.co">'],
        notContains: ["<code>t.co</code>", "<code>openclaw.co</code>"],
      },
      {
        name: "non-target extensions stay plain text",
        input: "image.png and style.css and script.js",
        notContains: ["<code>image.png</code>", "<code>style.css</code>", "<code>script.js</code>"],
      },
    ] as const;
    for (const testCase of cases) {
      const result = markdownToTelegramHtml(testCase.input);
      if ("contains" in testCase && testCase.contains) {
        for (const expected of testCase.contains) {
          expect(result, testCase.name).toContain(expected);
        }
      }
      if ("notContains" in testCase && testCase.notContains) {
        for (const unexpected of testCase.notContains) {
          expect(result, testCase.name).not.toContain(unexpected);
        }
      }
    }
  });

  it("wraps file refs across boundaries, sequences, and path variants", () => {
    const cases = [
      {
        name: "message start boundary",
        input: "README.md is important",
        expectedExact: "<code>README.md</code> is important",
      },
      {
        name: "message end boundary",
        input: "Check the README.md",
        expectedExact: "Check the <code>README.md</code>",
      },
      {
        name: "multiple file refs",
        input: "README.md CHANGELOG.md LICENSE.md",
        contains: [
          "<code>README.md</code>",
          "<code>CHANGELOG.md</code>",
          "<code>LICENSE.md</code>",
        ],
      },
      {
        name: "nested path",
        input: "src/utils/helpers/format.go",
        contains: ["<code>src/utils/helpers/format.go</code>"],
      },
      {
        name: "version-like non-domain path",
        input: "v1.0/README.md",
        contains: ["<code>v1.0/README.md</code>"],
      },
      {
        name: "domain with version path",
        input: "example.com/v1.0/README.md",
        contains: ['<a href="http://example.com/v1.0/README.md">'],
      },
      {
        name: "hyphen underscore and uppercase extensions",
        input: "my-file_name.md README.MD and SCRIPT.PY",
        contains: [
          "<code>my-file_name.md</code>",
          "<code>README.MD</code>",
          "<code>SCRIPT.PY</code>",
        ],
      },
    ] as const;
    for (const testCase of cases) {
      const result = markdownToTelegramHtml(testCase.input);
      if ("expectedExact" in testCase) {
        expect(result, testCase.name).toBe(testCase.expectedExact);
      }
      if ("contains" in testCase && testCase.contains) {
        for (const expected of testCase.contains) {
          expect(result, testCase.name).toContain(expected);
        }
      }
    }
  });

  it("handles nested code tags (depth tracking)", () => {
    // Nested <code> inside <pre> - should not wrap inner content
    const input = "<pre><code>README.md</code></pre> then script.py";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe("<pre><code>README.md</code></pre> then <code>script.py</code>");
  });

  it("handles multiple anchor tags in sequence", () => {
    const input =
      '<a href="https://a.com">link1</a> README.md <a href="https://b.com">link2</a> script.py';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toContain("</a> <code>README.md</code> <a");
    expect(result).toContain("</a> <code>script.py</code>");
  });

  it("wraps orphaned TLD pattern after special character", () => {
    // R&D.md - the & breaks the main pattern, but D.md could be auto-linked
    // So we wrap the orphaned D.md part to prevent Telegram linking it
    const input = "R&D.md";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe("R&<code>D.md</code>");
  });

  it("wraps orphaned single-letter TLD patterns", () => {
    // Use extensions still in the set (md, sh, py, go)
    const result1 = wrapFileReferencesInHtml("X.md is cool");
    expect(result1).toContain("<code>X.md</code>");

    const result2 = wrapFileReferencesInHtml("Check R.sh");
    expect(result2).toContain("<code>R.sh</code>");
  });

  it("does not match filenames containing angle brackets", () => {
    // The regex character class [a-zA-Z0-9_.\\-./] doesn't include < >
    // so these won't be matched and wrapped (which is correct/safe)
    const input = "file<script>.md";
    const result = wrapFileReferencesInHtml(input);
    // Not wrapped because < breaks the filename pattern
    expect(result).toBe(input);
  });

  it("wraps file ref before unrelated HTML tags", () => {
    // x.md followed by unrelated closing tag and bold - wrap the file ref only
    const input = "x.md <b>bold</b>";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe("<code>x.md</code> <b>bold</b>");
  });

  it("handles malformed HTML with stray closing tags (negative depth)", () => {
    // Stray </code> before content shouldn't break protection logic
    // (depth should clamp at 0, not go negative)
    const input = "</code>README.md<code>inside</code> after.md";
    const result = wrapFileReferencesInHtml(input);
    // README.md should be wrapped (codeDepth = 0 after clamping stray close)
    expect(result).toContain("<code>README.md</code>");
    // after.md should be wrapped (codeDepth = 0 after proper close)
    expect(result).toContain("<code>after.md</code>");
    // Should not have nested code tags
    expect(result).not.toContain("<code><code>");
  });

  it("does not wrap orphaned TLD fragments inside protected HTML contexts", () => {
    const cases = [
      "<code>R&D.md</code>",
      '<a href="https://example.com">R&D.md</a>',
      '<a href="http://example.com/R&D.md">link</a>',
      '<img src="logo/R&D.md" alt="R&D.md">',
    ] as const;
    for (const input of cases) {
      const result = wrapFileReferencesInHtml(input);
      expect(result, input).toBe(input);
      expect(result, input).not.toContain("<code>D.md</code>");
      expect(result, input).not.toContain("<code><code>");
      expect(result, input).not.toContain("</code></code>");
    }
  });

  it("handles multiple orphaned TLDs with HTML tags (offset stability)", () => {
    // This tests the bug where offset is relative to pre-replacement string
    // but we were checking against the mutating result string
    const input = '<a href="http://A.md">link</a> B.md <span title="C.sh">text</span> D.py';
    const result = wrapFileReferencesInHtml(input);
    // A.md in href should NOT be wrapped (inside attribute)
    // B.md outside tags SHOULD be wrapped
    // C.sh in title attribute should NOT be wrapped
    // D.py outside tags SHOULD be wrapped
    expect(result).toContain("<code>B.md</code>");
    expect(result).toContain("<code>D.py</code>");
    expect(result).not.toContain("<code>A.md</code>");
    expect(result).not.toContain("<code>C.sh</code>");
    // Attributes should be unchanged
    expect(result).toContain('href="http://A.md"');
    expect(result).toContain('title="C.sh"');
  });
});
