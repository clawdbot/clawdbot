import { expectDefined } from "@openclaw/normalization-core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { countLines, hasBalancedFences } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { chunkDiscordTextWithMode } from "./chunk.js";

type ChunkOptions = Omit<Parameters<typeof chunkDiscordTextWithMode>[1], "chunkMode">;

function chunkDiscordText(text: string, options: ChunkOptions = {}) {
  return chunkDiscordTextWithMode(text, { ...options, chunkMode: "length" });
}

function inlineCodeSpans(markdown: string) {
  type Node = { type: string; value?: string; depth?: number; children?: Node[] };
  const values: Array<{ value: string; containers: string[] }> = [];
  const visit = (node: Node, containers: string[]) => {
    if (node.type === "inlineCode") {
      values.push({ value: (node.value ?? "").replace(/\r\n|[\r\n]/g, " "), containers });
    }
    const kind = node.type === "heading" ? `heading:${node.depth}` : node.type;
    const nested = ["blockquote", "list", "listItem", "heading", "paragraph"].includes(node.type)
      ? [...containers, kind]
      : containers;
    for (const child of node.children ?? []) {
      visit(child, nested);
    }
  };
  visit(fromMarkdown(markdown), []);
  return values;
}

describe("chunkDiscordText", () => {
  it("splits tall messages even when under 2000 chars", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("counts the first line after each flush toward maxLines", () => {
    expect(chunkDiscordText("first\nsecond", { maxChars: 2000, maxLines: 1 })).toEqual([
      "first",
      "second",
    ]);
    expect(chunkDiscordText(`${"x".repeat(35)}\nz`, { maxChars: 30, maxLines: 1 })).toEqual([
      "x".repeat(30),
      "x".repeat(5),
      "z",
    ]);
  });

  it("uses default chunk limits for non-finite options", () => {
    const text = "x".repeat(2500);
    const chunks = chunkDiscordText(text, {
      maxChars: Number.NaN,
      maxLines: Number.POSITIVE_INFINITY,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });

  it("keeps fenced blocks intact when chunkMode is newline", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: 2000,
      maxLines: 50,
      chunkMode: "newline",
    });
    expect(chunks).toEqual([text]);
  });

  it("uses default newline chunk limits for non-finite max chars", () => {
    const text = "x".repeat(2500);
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: Number.NaN,
      maxLines: 50,
      chunkMode: "newline",
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("reserves space for closing fences when chunking", () => {
    const body = "a".repeat(120);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("keeps chunks within maxChars when a closing fence line carries trailing text", () => {
    // A line that both closes the fence and carries a long tail must still reserve closing-fence
    // space; otherwise a mid-line flush appended "```" and overflowed maxChars (e.g. 2004 > 2000).
    for (let pad = 1990; pad <= 2000; pad++) {
      const text = "hi\n```lang\n```" + "z".repeat(pad);
      for (const chunk of chunkDiscordText(text, { maxChars: 2000, maxLines: 100 })) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it("keeps chunks within maxChars when a fenced block's opening line is very long", () => {
    // Sibling of the closing-fence test above, on the OPENING/reopen side. flush() reopened
    // continuation chunks with the FULL opening line (info string included), so reopen prefix +
    // body + closing marker overflowed maxChars (observed 2108 > 2000). Balance is not asserted:
    // an opening fence line longer than maxChars must be split, orphaning its marker, so no
    // chunking can keep that physical line both within maxChars and balanced.
    for (let pad = 1990; pad <= 2010; pad++) {
      const text = "```" + "a".repeat(pad) + "\nbody line one\nbody line two\n```";
      for (const chunk of chunkDiscordText(text, { maxChars: 2000, maxLines: 100 })) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it("keeps chunks within maxChars when a fence-open line exceeds a small maxChars", () => {
    // Minimal repro mirroring the existing 50-char reserve test above.
    for (let len = 44; len <= 80; len++) {
      const text = "```" + "a".repeat(len) + "\nbody\nmore body\n```";
      for (const chunk of chunkDiscordText(text, { maxChars: 50, maxLines: 50 })) {
        expect(chunk.length).toBeLessThanOrEqual(50);
      }
    }
  });

  it("puts continued code on the line after a reopened fence", () => {
    const text = `\`\`\`ts\nconst value = '${"x".repeat(80)}';\n\`\`\``;
    const chunks = chunkDiscordText(text, { maxChars: 30, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    const fencedBodyChunks = chunks.filter((chunk) => /^```(?:ts)?\n[^`]/.test(chunk));
    expect(fencedBodyChunks.length).toBeGreaterThan(1);
    expect(
      chunks
        .filter((chunk) => chunk.startsWith("```"))
        .every((chunk) => /^```(?:ts)?(?:\n|$)/.test(chunk)),
    ).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
  });

  it("keeps the hard size limit when synthetic fence balancing cannot fit", () => {
    const cases = [
      { text: "```\nabcdefghij\n```", maxChars: 8 },
      { text: "~~~~~~~~\nabcdefghij\n~~~~~~~~", maxChars: 18 },
    ];

    for (const { text, maxChars } of cases) {
      const chunks = chunkDiscordText(text, { maxChars, maxLines: 50 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
    }
  });

  it("preserves whitespace when splitting long lines", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves mixed whitespace across chunk boundaries", () => {
    const text = "alpha  beta\tgamma   delta epsilon  zeta";
    const chunks = chunkDiscordText(text, { maxChars: 12, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps leading whitespace when splitting long lines", () => {
    const text = "    indented line with words that force splits";
    const chunks = chunkDiscordText(text, { maxChars: 14, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("uses CJK punctuation as a safe long-line split point", () => {
    const text = "一二三四五。六七八九十。甲乙丙丁戊。";
    const chunks = chunkDiscordText(text, { maxChars: 10, maxLines: 50 });

    expect(chunks).toEqual(["一二三四五。", "六七八九十。", "甲乙丙丁戊。"]);
    expect(chunks.join("")).toBe(text);
  });

  it("still prefers whitespace before CJK punctuation", () => {
    const text = "alpha beta。gamma delta";
    const chunks = chunkDiscordText(text, { maxChars: 13, maxLines: 50 });

    expect(chunks[0]).toBe("alpha");
    expect(chunks.join("")).toBe(text);
  });

  it("does not split surrogate pairs at hard fallback boundaries", () => {
    const text = "ab😀cd😀ef";
    const chunks = chunkDiscordText(text, { maxChars: 3, maxLines: 50 });

    expect(chunks).toEqual(["ab", "😀c", "d😀", "ef"]);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Each chunk should have balanced italics markers (even count).
      const count = (chunk.match(/_/g) || []).length;
      expect(count % 2).toBe(0);
    }

    // Ensure italics reopen on subsequent chunks
    expect(expectDefined(chunks[0], "first Discord chunk")).toContain("_1. line");
    // Second chunk should reopen italics at the start
    expect(expectDefined(chunks[1], "second Discord chunk").trimStart().startsWith("_")).toBe(true);
  });

  it("keeps reasoning italics balanced when chunks split by char limit", () => {
    const longLine = "This is a very long reasoning line that forces char splits.";
    const body = Array.from({ length: 5 }, () => longLine).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxChars: 80, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const underscoreCount = (chunk.match(/_/g) || []).length;
      expect(underscoreCount % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(80);
    }
  });

  it("reserves the Discord transport limit for reasoning italic markers", () => {
    const maxChars = 2000;
    const text = `Reasoning:\n_${"a".repeat(maxChars * 2)}_`;

    const chunks = chunkDiscordText(text, { maxChars, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxChars);
      expect((chunk.match(/_/g) || []).length % 2).toBe(0);
    }
  });

  it("keeps newline-mode reasoning chunks within the Discord transport limit", () => {
    const maxChars = 2000;
    const text = `Reasoning:\n_${"a".repeat(maxChars * 2)}_`;

    const chunks = chunkDiscordTextWithMode(text, {
      chunkMode: "newline",
      maxChars,
      maxLines: 50,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
  });

  it.each([1, 2, 3, 4, 20])("never exceeds a %i-character reasoning chunk limit", (maxChars) => {
    const text = `Reasoning:\n_${"abcdef".repeat(8)}_`;

    const chunks = chunkDiscordText(text, { maxChars, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
  });

  it("does not split surrogate pairs when reserving reasoning italic markers", () => {
    const text = `Reasoning:\n_${"😀".repeat(24)}_`;
    const maxChars = 4;

    const chunks = chunkDiscordText(text, { maxChars, maxLines: 50 });

    expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
      expect(chunk).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  });

  it("keeps thinking-prefixed reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Thinking\n\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const underscoreCount = (chunk.match(/_/g) || []).length;
      expect(underscoreCount % 2).toBe(0);
    }
  });

  it("reopens italics while preserving leading whitespace on following chunk", () => {
    const body = [
      "1. line",
      "2. line",
      "3. line",
      "4. line",
      "5. line",
      "6. line",
      "7. line",
      "8. line",
      "9. line",
      "10. line",
      "  11. indented line",
      "12. line",
    ].join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    const second = expectDefined(chunks[1], "second Discord chunk");
    expect(second.startsWith("_")).toBe(true);
    expect(second).toContain("  11. indented line");
  });

  it.each([
    ["a backtick fence", ["```python", "print(1)", "```"], "```python\nprint(1)\n```"],
    [
      "a backtick fence followed by reasoning",
      ["```python", "print(1)", "```", "more reasoning"],
      "```python\nprint(1)\n```\n_more reasoning_",
    ],
    ["a tilde fence", ["~~~python", "print(1)", "~~~"], "~~~python\nprint(1)\n~~~"],
    [
      "a tilde fence followed by reasoning",
      ["~~~python", "print(1)", "~~~", "more reasoning"],
      "~~~python\nprint(1)\n~~~\n_more reasoning_",
    ],
    [
      "an indented fence",
      ["  ```python", "print(1)", "  ```", "more reasoning"],
      "  ```python\nprint(1)\n  ```\n_more reasoning_",
    ],
    [
      "a longer closing fence",
      ["```python", "print(1)", "````", "more reasoning"],
      "```python\nprint(1)\n````\n_more reasoning_",
    ],
    [
      "inline code followed by reasoning",
      ["`inline_code_token`", "10. after"],
      "`inline_code_token`\n_10. after_",
    ],
    [
      "inline code with a longer interior backtick run",
      ["``a```b``", "10. after"],
      "``a```b``\n_10. after_",
    ],
    ["inline code across a blank line", ["`one", "", "two`", "more"], "`one\n\ntwo`\n_more_"],
    ["a CRLF code fence", ["```ts\r", "body\r", "```\r", "more"], "```ts\r\nbody\r\n```\r\n_more_"],
    [
      "consecutive leading code spans",
      ["```js", "one()", "```", "~~~sh", "two", "~~~", "more reasoning"],
      "```js\none()\n```\n~~~sh\ntwo\n~~~\n_more reasoning_",
    ],
  ] as const)("preserves %s at a reasoning chunk boundary", (_name, continuation, expected) => {
    const body = [
      ...Array.from({ length: 9 }, (_, index) => `${index + 1}. line`),
      ...continuation,
    ].join("\n");
    const chunks = chunkDiscordText(`Reasoning:\n_${body}_`, {
      maxLines: 10,
      maxChars: 2000,
    });

    expect(chunks.length).toBeGreaterThan(1);
    const second = expectDefined(chunks[1], "second Discord chunk");
    expect(second).toBe(expected);
    expect(second.trimStart()).not.toMatch(/^_(```|~~~|`)/u);
    for (const chunk of chunks) {
      expect((chunk.match(/_/g) || []).length % 2).toBe(0);
    }
  });

  it("treats an unmatched inline delimiter as reasoning prose", () => {
    const body = [
      ...Array.from({ length: 9 }, (_, index) => `${index + 1}. line`),
      "`unclosed",
      "10. after",
    ].join("\n");
    const chunks = chunkDiscordText(`Reasoning:\n_${body}_`, {
      maxLines: 10,
      maxChars: 2000,
    });

    expect(expectDefined(chunks[1], "second Discord chunk")).toBe("_`unclosed\n10. after_");
    expect(chunks.every((chunk) => (chunk.match(/_/g) || []).length % 2 === 0)).toBe(true);
  });
});

function inlineCodeValue(text: string): string | undefined {
  const nodes = fromMarkdown(text).children;
  const paragraph = nodes[0];
  if (nodes.length !== 1 || paragraph?.type !== "paragraph" || paragraph.children.length !== 1) {
    return undefined;
  }
  const code = paragraph.children[0];
  return code?.type === "inlineCode" ? code.value : undefined;
}

describe("Discord inline-code chunk boundaries", () => {
  it.each([
    {
      name: "default character limit",
      text: "`command " + "--argument=value ".repeat(160) + "`",
      maxChars: 2000,
      maxLines: 17,
      chunkMode: "length" as const,
    },
    {
      name: "newline mode",
      text: "`command " + "--argument=value ".repeat(160) + "`",
      maxChars: 2000,
      maxLines: 17,
      chunkMode: "newline" as const,
    },
    {
      name: "code padding",
      text: "` " + "value ".repeat(40) + " `",
      maxChars: 50,
      maxLines: 17,
      chunkMode: "length" as const,
    },
    {
      name: "interior backticks",
      text: "`` " + "a`b ".repeat(40) + " ``",
      maxChars: 30,
      maxLines: 17,
      chunkMode: "length" as const,
    },
    {
      name: "Unicode at a small limit",
      text: "`" + "😀".repeat(20) + "`",
      maxChars: 5,
      maxLines: 17,
      chunkMode: "length" as const,
    },
    {
      name: "closing delimiter at a small limit",
      text: "`a😀b`",
      maxChars: 5,
      maxLines: 17,
      chunkMode: "length" as const,
    },
    {
      name: "padded closing delimiter at a small limit",
      text: "`` a`b😀c ``",
      maxChars: 8,
      maxLines: 17,
      chunkMode: "length" as const,
    },
    {
      name: "default line limit",
      text: "`" + Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n") + "`",
      maxChars: 2000,
      maxLines: 17,
      chunkMode: "length" as const,
    },
    {
      name: "CRLF line boundaries",
      text: "`" + Array.from({ length: 12 }, (_, i) => `line${i}`).join("\r\n") + "`",
      maxChars: 2000,
      maxLines: 3,
      chunkMode: "length" as const,
    },
  ])("preserves code content across $name", ({ text, maxChars, maxLines, chunkMode }) => {
    const expected = inlineCodeValue(text);
    const chunks = chunkDiscordTextWithMode(text, { maxChars, maxLines, chunkMode });
    const values = chunks.map(inlineCodeValue);
    expect(expected).toBeDefined();
    expect(chunks.length).toBeGreaterThan(1);
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(values.join("")).toBe(expected);
    expect(chunks.every((chunk) => chunk.length <= maxChars && countLines(chunk) <= maxLines)).toBe(
      true,
    );
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    }
  });

  it("leaves an already bounded native message byte-identical", () => {
    const text =
      "  ` padded code ` <@123> <:wave:456> </command:789> https://example.test/?q=__x__  ";
    expect(chunkDiscordTextWithMode(text, {})).toEqual([text]);
  });

  it.each([
    { text: "``" + "a".repeat(1993) + "```" + "b".repeat(10) + "``", maxChars: 2000, maxLines: 17 },
    { text: "`a\r\nb\r\nc`", maxChars: 2000, maxLines: 2 },
    { text: "`a\n😀b`", maxChars: 4, maxLines: 17 },
    { text: "`\na\nb\n`", maxChars: 2000, maxLines: 3 },
    { text: "`aaaa``b`", maxChars: 6, maxLines: 17 },
    { text: "`\naaaa\r\nbbbb `", maxChars: 6, maxLines: 17 },
    {
      text: "`\n" + "a".repeat(1998) + "\r\n" + "b".repeat(1998) + " `",
      maxChars: 2000,
      maxLines: 17,
    },
    { text: "```aa`\r\n``b```", maxChars: 9, maxLines: 2 },
  ])("preserves rendered inline content at $maxChars chars and $maxLines lines", (options) => {
    const chunks = chunkDiscordTextWithMode(options.text, options);
    const values = chunks.map(inlineCodeValue);
    const normalize = (value: string) => value.replace(/\r\n|[\r\n]/g, " ");
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(values.map((value) => normalize(value ?? "")).join("")).toBe(
      normalize(expectDefined(inlineCodeValue(options.text), "source inline code")),
    );
    expect(
      chunks.every(
        (chunk) => chunk.length <= options.maxChars && countLines(chunk) <= options.maxLines,
      ),
    ).toBe(true);
  });

  it("retains raw source when no inline backtick fragment fits the hard cap", () => {
    expect(chunkDiscordText("`aaaa``b`", { maxChars: 5 })).toEqual(["`aaaa", "``b`"]);
  });

  it("sizes an oversized fence opener retained after inline code", () => {
    const source = "`a`\n```" + "x".repeat(1997) + "\ny\n```";
    const chunks = chunkDiscordText(source);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });

  it("keeps inline source offsets separate from reopened fences", () => {
    const chunks = chunkDiscordText("`a\nb\nc\nd\ne`\n```\nx\ny\n```", { maxLines: 4 });
    const nodes = chunks.flatMap((chunk) => fromMarkdown(chunk).children);
    const inline = nodes.flatMap((node) => (node.type === "paragraph" ? node.children : []));
    const blocks = nodes.filter((node) => node.type === "code");
    expect(inline.every((node) => node.type === "inlineCode")).toBe(true);
    expect(
      inline
        .flatMap((node) => (node.type === "inlineCode" ? [node.value] : []))
        .join("")
        .replace(/\n/g, " "),
    ).toBe("a b c d e");
    expect(blocks.every((node) => node.value.length > 0)).toBe(true);
    expect(blocks.map((node) => node.value).join("\n")).toBe("x\ny");
    expect(chunks.every((chunk) => chunk.length <= 2000 && countLines(chunk) <= 4)).toBe(true);
  });

  it("does not reserve a second closing fence after the original closer fits", () => {
    const chunks = chunkDiscordText("prefix\nline\n```\nx\ny\n```", { maxLines: 4 });
    expect(fromMarkdown(expectDefined(chunks.at(-1), "last Discord chunk")).children).toMatchObject(
      [{ type: "code", value: "x\ny" }],
    );
    expect(chunks.every((chunk) => countLines(chunk) <= 4)).toBe(true);
  });

  it.each([
    ["quote", "> ", "> "],
    ["nested quote", "> > ", "> > "],
    ["bullet", "- ", "  "],
    ["ordered", "1. ", "   "],
    ["nested list", "- - ", "    "],
    ["quote in list", "- > ", "  > "],
    ["list in quote", "> - ", ">   "],
    ["lazy quote", "> ", ""],
    ["lazy list", "- ", ""],
    ["tab list", "-\t", "\t"],
    ["tab quote", ">\t", ">\t"],
    ["lazy nested quote", "> > ", "> "],
  ])("keeps inline content and containers when splitting %s", (_name, first, next) => {
    for (const ending of ["\n", "\r\n"]) {
      const intro = Array.from({ length: 16 }, (_, index) => `Intro${index}`).join(ending);
      const source = `${intro}${ending}${first}\`a${ending}${next}b\``;
      const expected = expectDefined(inlineCodeSpans(source)[0], "source inline code");
      const chunks = chunkDiscordText(source);
      const actual = chunks.flatMap(inlineCodeSpans);
      expect(chunks.length).toBeGreaterThan(1);
      expect(actual.map(({ value }) => value).join("")).toBe(expected.value);
      expect(
        actual.every(({ containers }) => containers.join(",") === expected.containers.join(",")),
      ).toBe(true);
      expect(chunks.every((chunk) => chunk.length <= 2000 && countLines(chunk) <= 17)).toBe(true);
    }
  });

  it.each(["a\\|b", "a\\\\|b", "a|b"])(
    "uses CommonMark code ownership for raw table text containing %s",
    (unit) => {
      const source = "| Head |\n| --- |\n| `" + unit.repeat(900) + "` |";
      const chunks = chunkDiscordText(source);
      expect(chunks.length).toBeGreaterThan(1);
      expect(
        chunks
          .flatMap(inlineCodeSpans)
          .map(({ value }) => value)
          .join(""),
      ).toBe(
        inlineCodeSpans(source)
          .map(({ value }) => value)
          .join(""),
      );
      expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    },
  );
  it.each([
    { maxChars: 12, maxLines: 1 },
    { maxChars: 12, maxLines: 2 },
    { maxChars: 12, maxLines: 17 },
    { maxChars: 30, maxLines: 1 },
    { maxChars: 30, maxLines: 2 },
  ])("keeps original closing markers out of code at $maxChars chars/$maxLines lines", (options) => {
    const body = "abc ".repeat(14);
    const chunks = chunkDiscordText(`\`\`\`txt\n${body}\n\`\`\``, options);
    const blocks = chunks.flatMap((chunk) => fromMarkdown(chunk).children);
    expect(blocks.every((block) => block.type === "code")).toBe(true);
    expect(blocks.flatMap((block) => (block.type === "code" ? [block.value] : [])).join("")).toBe(
      body,
    );
    expect(chunks.every((chunk) => chunk.length <= options.maxChars)).toBe(true);
  });
  it.each([
    "> ## ",
    "> > ### ",
    "- ## ",
    "> - # ",
    "- item\n\n    ",
    "- parent\n  - item\n\n    ",
    "7. item\n\n   ",
    "> - item\n>\n>   ",
    "- > item\n  >\n  > ",
    "- item\n\n\t",
  ])("retains inline ownership after container prefix %j", (prefix) => {
    for (const ending of ["\n", "\r\n"]) {
      const source =
        "Intro" + ending + prefix.replaceAll("\n", ending) + "`" + "a".repeat(2400) + "`";
      const expected = expectDefined(inlineCodeSpans(source)[0], "source container code");
      const chunks = chunkDiscordText(source);
      const actual = chunks.flatMap(inlineCodeSpans);
      expect(actual.map(({ value }) => value).join("")).toBe(expected.value);
      for (const span of actual) {
        expect(span.containers).toEqual(expected.containers);
      }
      expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    }
  });
  it("preserves impossible fence packing including whitespace", () => {
    expect(chunkDiscordText("```txt\n \r\n \n```", { maxChars: 3, maxLines: 2 })).toEqual([
      "```",
      "txt",
      " \n`",
      "``",
    ]);
  });
});
