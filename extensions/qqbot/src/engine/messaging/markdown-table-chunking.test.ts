// QQ Bot Markdown chunking tests cover message-boundary table repair.
import { describe, expect, it } from "vitest";
import { chunkQQBotMarkdownText, createQQBotMarkdownChunker } from "./markdown-table-chunking.js";

const baseChunker = (text: string, limit: number): string[] =>
  text.length <= limit ? [text] : [text.slice(0, limit), text.slice(limit)];

describe("chunkQQBotMarkdownText", () => {
  it("falls unsupported inline code back to plain text", () => {
    expect(chunkQQBotMarkdownText("Run `openclaw status` now.", 120, baseChunker)).toEqual([
      "Run openclaw status now.",
    ]);
  });

  it("preserves transport-owned markdown images beside fallback code", () => {
    const image = "![chart #800px #600px](https://example.com/chart.png)";
    expect(chunkQQBotMarkdownText(`Run \`status\`.\n\n${image}`, 200, baseChunker)).toEqual([
      `Run status.\n\n${image}`,
    ]);
  });

  it("preserves transport-owned image URLs with balanced parentheses", () => {
    const image = "![plot](https://example.com/chart_(final).png)";
    expect(chunkQQBotMarkdownText(`Run \`status\`.\n\n${image}`, 200, baseChunker)).toEqual([
      `Run status.\n\n${image}`,
    ]);
  });

  it("preserves images containing nested opener text", () => {
    const image = "![plot](https://example.com/a![b].png)";
    expect(chunkQQBotMarkdownText(image, 200, baseChunker)).toEqual([image]);
  });

  it("keeps BMP protected image tokens atomic at the chunk boundary", () => {
    const image = "![x](https://example.com/x.png)";
    const output = chunkQQBotMarkdownText(`${"A".repeat(3_597)}${image}`, 3_600, baseChunker);
    expect(output.join("")).toBe(`${"A".repeat(3_597)}${image}`);
    expect(output.every((chunk) => !chunk.includes("�"))).toBe(true);
  });

  it("keeps escaped images atomic at the chunk boundary", () => {
    const image = String.raw`\![x](https://example.com/x.png)`;
    const chunks = chunkQQBotMarkdownText(`${"A".repeat(3_599)}${image}`, 3_600, baseChunker);
    expect(chunks.join("")).toBe(`${"A".repeat(3_599)}${image}`);
    expect(chunks.some((chunk) => chunk.startsWith("!["))).toBe(false);
  });

  it("falls protected images back when final quote context exceeds the limit", () => {
    const image = `![x](https://example.com/${"a".repeat(3_400)}.png)`;
    const chunks = chunkQQBotMarkdownText(`${"> ".repeat(40)}${image}`, 3_600, baseChunker);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 3_600)).toBe(true);
    expect(chunks.join("")).toContain("![x]");
  });

  it("does not hide later code behind malformed images", () => {
    const output = chunkQQBotMarkdownText("![x](bad\n\n`code`\n)", 200, baseChunker).join("");
    expect(output).toContain("code");
    expect(output).not.toContain("`code`");
  });

  it("does not let nested images complete malformed outer candidates", () => {
    const output = chunkQQBotMarkdownText(
      "![broken `code` ![x](https://e.test/x.png)",
      200,
      baseChunker,
    ).join("");
    expect(output).not.toContain("`code`");
    expect(output).toContain("![x](https://e.test/x.png)");
  });

  it("continues image protection after many malformed candidates", () => {
    const image = "![plot](https://example.com/chart.png)";
    const chunks = chunkQQBotMarkdownText(`${"![".repeat(81)}${image}`, 500, baseChunker);
    expect(chunks.join("")).toContain(image);
  });

  it("does not restore forged protected tokens decoded from character references", () => {
    const image = "![x](https://example.com/x.png)";
    const output = chunkQQBotMarkdownText(`&#xF0000; ${image}`, 200, baseChunker).join("");
    expect(output.startsWith("&#xF0000; ")).toBe(true);
    expect(output.match(/!\[x\]/gu)).toHaveLength(1);
  });

  it("preserves entity-encoded markdown literals", () => {
    const source = "&#42;&#42;literal&#42;&#42;";
    expect(chunkQQBotMarkdownText(source, 200, baseChunker)).toEqual([source]);
  });

  it("restores entities nested inside protected images", () => {
    const image = "![x](https://e.test/a?x=1&amp;y=2)";
    expect(chunkQQBotMarkdownText(image, 200, baseChunker)).toEqual([image]);
  });

  it("keeps oversized entities chunkable", () => {
    const source = `&#${"1".repeat(300)};`;
    const chunks = chunkQQBotMarkdownText(source, 100, baseChunker);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 100)).toBe(true);
  });

  it("falls oversized images back to chunkable plain content", () => {
    const image = `![x](https://example.com/${"a".repeat(4_000)}.png)`;
    const chunks = chunkQQBotMarkdownText(image, 3_600, baseChunker);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 3_600)).toBe(true);
    expect(chunks.join("")).toBe("x");
  });

  it("falls oversized links back to chunkable plain content", () => {
    const href = `https://example.com/${"a".repeat(4_000)}`;
    const escapedHref = href.replaceAll(".", "\\.");
    const chunks = chunkQQBotMarkdownText(`[x](${href})`, 3_600, baseChunker);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 3_600)).toBe(true);
    expect(chunks.join("")).toBe(`x (${escapedHref})`);
  });

  it("removes only the oversized occurrence when link destinations repeat", () => {
    const href = `https://e.co/${"a".repeat(3_575)}`;
    const escapedHref = href.replaceAll(".", "\\.");
    const source = `[x](${href})\n[${"long".repeat(8)}](${href})`;
    const output = chunkQQBotMarkdownText(source, 3_600, baseChunker).join("");
    expect(output).toContain(`[x](<${href}>)`);
    expect(output).toContain(`${"long".repeat(8)} (${escapedHref})`);
  });

  it("supports more authored escapes than the BMP private-use block", () => {
    const source = "\\*".repeat(6_401);
    expect(chunkQQBotMarkdownText(source, 3_600, baseChunker).join("")).toBe(source);
  });

  it("escapes markdown-looking inline code after removing code markers", () => {
    expect(chunkQQBotMarkdownText("`![x](https://example.com/x.png)`", 200, baseChunker)).toEqual([
      String.raw`\!\[x\]\(https://example\.com/x\.png\)`,
    ]);
  });

  it("matches equal-length inline delimiters around shorter backtick runs", () => {
    expect(
      chunkQQBotMarkdownText("``a `![x](https://example.com/x.png)` b``", 200, baseChunker),
    ).toEqual([String.raw`a \`\!\[x\]\(https://example\.com/x\.png\)\` b`]);
  });

  it("preserves escaped literal backticks", () => {
    expect(chunkQQBotMarkdownText(String.raw`\`literal\``, 200, baseChunker)).toEqual([
      String.raw`\`literal\``,
    ]);
  });

  it("re-escapes protected backslashes inside fallback code", () => {
    expect(chunkQQBotMarkdownText("`\\*`", 200, baseChunker)).toEqual([String.raw`\\\*`]);
  });

  it("serializes link destinations with angle brackets", () => {
    expect(chunkQQBotMarkdownText("[x](https://host/a)", 200, baseChunker)).toEqual([
      "[x](<https://host/a>)",
    ]);
  });

  it("keeps every paragraph inside a blockquote", () => {
    expect(chunkQQBotMarkdownText("> one\n>\n> two", 200, baseChunker)).toEqual([
      "> one\n> \n> two",
    ]);
  });

  it("stops blockquote prefixes before following text", () => {
    expect(chunkQQBotMarkdownText("> quoted\n\noutside", 200, baseChunker)).toEqual([
      "> quoted\n\noutside",
    ]);
  });

  it("prefixes every chunk of a long blockquote", () => {
    const chunks = chunkQQBotMarkdownText(`> ${"a".repeat(5_000)}`, 200, baseChunker);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("> "))).toBe(true);
  });

  it("does not duplicate blockquote prefixes at continuation boundaries", () => {
    const chunks = chunkQQBotMarkdownText(`> ${"a".repeat(3_597)}\n> second`, 3_600, baseChunker);
    expect(chunks.some((chunk) => chunk.startsWith("> > "))).toBe(false);
    expect(chunks.join("")).toContain("> second");
  });

  it("keeps fallback code lines inside a blockquote", () => {
    expect(chunkQQBotMarkdownText("> ```\n> one\n> two\n> ```", 200, baseChunker)).toEqual([
      "> one\n> two",
    ]);
  });

  it("does not linkify plain filenames", () => {
    expect(chunkQQBotMarkdownText("See README.md", 200, baseChunker)).toEqual(["See README.md"]);
  });

  it("keeps nested list indentation out of code fallback", () => {
    expect(chunkQQBotMarkdownText("- parent\n    - child", 200, baseChunker)).toEqual([
      "• parent\n  • child",
    ]);
  });

  it("prefixes continuation chunks with the active table header", () => {
    const text = [
      "| Id | Value |",
      "|---:|---|",
      "| 1 | alpha |",
      "| 2 | beta |",
      "| 3 | gamma |",
    ].join("\n");

    expect(chunkQQBotMarkdownText(text, 45, baseChunker)).toEqual([
      ["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"),
      ["| Id | Value |", "|---:|---|", "| 2 | beta |"].join("\n"),
      ["| Id | Value |", "|---:|---|", "| 3 | gamma |"].join("\n"),
    ]);
  });

  it("keeps table state across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"), 120),
    ).toEqual([["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n")]);
    expect(chunker.chunkText(["| 2 | beta |", "| 3 | gamma |"].join("\n"), 120)).toEqual([
      ["| Id | Value |", "|---:|---|", "| 2 | beta |", "| 3 | gamma |"].join("\n"),
    ]);
  });

  it("keeps a possible table header until a later separator confirms the table", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText("| Id | Value |", 120)).toEqual([]);
    expect(
      chunker.chunkText(["|---:|---|", "| 1 | alpha |", "| 2 | beta |"].join("\n"), 120),
    ).toEqual([["| Id | Value |", "|---:|---|", "| 1 | alpha |", "| 2 | beta |"].join("\n")]);
  });

  it("confirms a table when the separator uses one or two dashes, not only three", () => {
    // GFM delimiter cells need only one or more dashes; a sub-3-dash separator previously failed
    // recognition, so the header and all rows but the last were silently dropped on send.
    for (const separator of ["|--|--|", "|-|-|", "|:--|--:|"]) {
      const text = ["| Id | Value |", separator, "| 1 | alpha |", "| 2 | beta |"].join("\n");
      expect(chunkQQBotMarkdownText(text, 200, baseChunker)).toEqual([text]);
    }
  });

  it("flushes a possible table header as text when the next block is not a separator", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText("| maybe | header |", 120)).toEqual([]);
    expect(chunker.chunkText("plain continuation", 120)).toEqual([
      ["| maybe | header |", "plain continuation"].join("\n"),
    ]);
  });

  it("does not prefix after a table is closed by a blank line", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    chunker.chunkText(["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n") + "\n\n", 120);

    expect(chunker.chunkText("| not | a continuation |", 120)).toEqual([]);
    expect(chunker.flushPendingText(120)).toEqual(["| not | a continuation |"]);
  });

  it("renders an oversized table row as fields instead of splitting the row", () => {
    const text = [
      "| Id | Error | Retry |",
      "|---|---|---|",
      `| 003 | ${"当前无错误信息，处理流程正常运行".repeat(8)} | 当前重试次数为零 |`,
      "| 004 | ok | zero |",
    ].join("\n");

    const chunks = chunkQQBotMarkdownText(text, 80, baseChunker);

    expect(chunks[0]).toContain("Id: 003");
    expect(chunks[0]).toContain("Error:");
    expect(chunks.some((chunk) => chunk.startsWith("| 当前无错误信息"))).toBe(false);
    expect(chunks.at(-1)).toBe(
      ["| Id | Error | Retry |", "|---|---|---|", "| 004 | ok | zero |"].join("\n"),
    );
  });

  it("keeps escaped pipes inside oversized table cells", () => {
    const value = "long value ".repeat(12);
    const text = ["| Label | Value |", "|---|---|", `| a \\| b | ${value} |`].join("\n");

    const chunks = chunkQQBotMarkdownText(text, 80, baseChunker);

    expect(chunks.join("\n")).toContain("Label: a | b");
    expect(chunks.join("\n")).toContain("Value: long value");
  });

  it("buffers a table row fragment across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(
        ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
        160,
      ),
    ).toEqual([["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n")]);

    expect(chunker.chunkText("| 5 | generatemonthly_sales", 160)).toEqual([]);
    expect(chunker.chunkText("_by_region | ok |", 160)).toEqual([
      [
        "| Id | Function | Status |",
        "|---:|---|---|",
        "| 5 | generatemonthly_sales_by_region | ok |",
      ].join("\n"),
    ]);
  });

  it("buffers a pipe-terminated row until it reaches the table column count", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(
        ["| Id | Time | Owner | Note |", "|---:|---|---|---|", "| 16 | 40ms | He | ok |"].join(
          "\n",
        ),
        200,
      ),
    ).toEqual([
      ["| Id | Time | Owner | Note |", "|---:|---|---|---|", "| 16 | 40ms | He | ok |"].join("\n"),
    ]);

    expect(chunker.chunkText("| 17 | 100ms |", 200)).toEqual([]);
    expect(chunker.chunkText("Lin | daily cap |", 200)).toEqual([
      [
        "| Id | Time | Owner | Note |",
        "|---:|---|---|---|",
        "| 17 | 100ms | Lin | daily cap |",
      ].join("\n"),
    ]);
  });

  it("flushes an unfinished table row fragment as plain fields", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    chunker.chunkText(
      ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
      160,
    );
    expect(chunker.chunkText("| 10 | analyzeerror_patterns | 无需重试", 160)).toEqual([]);

    expect(chunker.flushPendingText(160)).toEqual([
      ["Id: 10", "Function: analyzeerror_patterns", "Status: 无需重试"].join("\n"),
    ]);
  });

  it("does not emit malformed pipe fragments without table context", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText("| 5 | reportbuilder.ts | generatemonthly_sales", 160)).toEqual([]);
    expect(chunker.flushPendingText(160)).toEqual(["5 reportbuilder.ts generatemonthly_sales"]);
  });

  it("falls fenced code blocks back to plain text across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText(["```ts", "const a = 1;"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText(["const b = 2;", "```"].join("\n"), 200)).toEqual([
      ["const a = 1;", "const b = 2;"].join("\n"),
    ]);
  });

  it("keeps streamed template-literal backticks as escaped plain text", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText(["```ts", "const value = `hello`;"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText("```", 200)).toEqual([String.raw`const value = \`hello\`;`]);
  });

  it("keeps markdown-looking streamed fence bodies in code fallback", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);
    expect(chunker.chunkText(["```", "**literal**"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText("```", 200)).toEqual([String.raw`\*\*literal\*\*`]);
  });

  it("handles longer fences containing shorter fence examples", () => {
    const markdown = ["````md", "```", "inside", "```", "````   "].join("\n");
    expect(chunkQQBotMarkdownText(markdown, 200, baseChunker)).toEqual([
      [String.raw`\`\`\``, "inside", String.raw`\`\`\``].join("\n"),
    ]);
  });

  it("escapes markdown-looking indented code after fallback", () => {
    const markdown = ["    **literal**", "    ![x](https://example.com/x.png)"].join("\n");
    expect(chunkQQBotMarkdownText(markdown, 200, baseChunker)).toEqual([
      [String.raw`\*\*literal\*\*`, String.raw`\!\[x\]\(https://example\.com/x\.png\)`].join("\n"),
    ]);
  });

  it("joins a fenced code line split across block deliveries", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(
      chunker.chunkText(["```python", "    pool_timeout: float = 30."].join("\n"), 200),
    ).toEqual([]);
    expect(
      chunker.chunkText(["0", "    def get_dsn(self) -> str:", "```"].join("\n"), 200),
    ).toEqual([
      [
        String.raw`    pool\_timeout: float = 30\.0`,
        String.raw`    def get\_dsn\(self\) \-\> str:`,
      ].join("\n"),
    ]);
  });

  it("keeps long fallback code chunks under the QQ markdown byte safety limit", () => {
    const lines = Array.from(
      { length: 90 },
      (_, index) =>
        `        value_${String(index).padStart(3, "0")} = "这是一行用于测试 QQ markdown 不要接近平台截断线的 Python 代码"`,
    );
    const text = ["```python", ...lines].join("\n");
    const chunks = chunkQQBotMarkdownText(text, 5000, baseChunker);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(3600);
      expect(chunk).not.toContain("```");
    }
  });

  it("does not split generated markdown escape pairs across byte chunks", () => {
    const chunks = chunkQQBotMarkdownText(
      ["```", "*".repeat(5_000), "```"].join("\n"),
      3_600,
      baseChunker,
    );
    expect(chunks.join("")).toBe("\\*".repeat(5_000));
    expect(chunks.every((chunk) => !/(^|[^\\])(?:\\\\)*\\$/u.test(chunk))).toBe(true);
  });

  it("keeps generated markdown escape pairs atomic at odd byte limits", () => {
    const chunks = chunkQQBotMarkdownText(["```", "***", "```"].join("\n"), 3, baseChunker);
    expect(chunks.join("")).toBe("\\*".repeat(3));
    expect(chunks.every((chunk) => !chunk.endsWith("\\"))).toBe(true);
  });

  it("allows ASCII fenced chunks past the old 1800 character fallback", () => {
    const lines = Array.from(
      { length: 90 },
      (_, index) =>
        `        value_${String(index).padStart(3, "0")} = "ascii markdown budget should use bytes not a short character cap"`,
    );
    const chunks = chunkQQBotMarkdownText(["```python", ...lines].join("\n"), 5000, baseChunker);

    expect(chunks.some((chunk) => chunk.length > 1800)).toBe(true);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(3600);
      expect(chunk).not.toContain("```");
    }
  });

  it("falls fenced formula blocks back to plain text across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText(["```math", "E = mc^2"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText(["a^2 + b^2 = c^2", "```"].join("\n"), 200)).toEqual([
      ["E = mc^2", String.raw`a^2 \+ b^2 = c^2`].join("\n"),
    ]);
  });

  it("splits fenced code chunks between lines for every viable limit", () => {
    const firstLine = `const value001 = "用于测试代码行保持完整";`;
    const secondLine = `const value002 = "用于测试代码行保持完整";`;
    const singleLineFenceLength = Buffer.byteLength(["```ts", firstLine, "```"].join("\n"));
    const wholeFenceLength = Buffer.byteLength(["```ts", firstLine, secondLine, "```"].join("\n"));

    for (let limit = singleLineFenceLength; limit < wholeFenceLength; limit++) {
      const chunker = createQQBotMarkdownChunker(baseChunker);
      const chunks = [
        ...chunker.chunkText(["```ts", firstLine, secondLine].join("\n"), limit),
        ...chunker.flushPendingText(limit),
      ];

      expect(chunks).toEqual([firstLine, secondLine]);
    }
  });

  it("handles prose before and after a table split at row boundaries", () => {
    const text = [
      "前置说明第一段，长度足够触发普通文本先发送。",
      "前置说明第二段继续解释。",
      "| Id | Value |",
      "|---:|---|",
      "| 1 | alpha |",
      "| 2 | beta |",
      "后置说明第一段，表格结束后继续普通文字。",
      "后置说明第二段。",
    ].join("\n");

    expect(chunkQQBotMarkdownText(text, 180, baseChunker)).toEqual([
      "前置说明第一段，长度足够触发普通文本先发送。\n前置说明第二段继续解释。",
      ["| Id | Value |", "|---:|---|", "| 1 | alpha |", "| 2 | beta |"].join("\n"),
      "后置说明第一段，表格结束后继续普通文字。\n后置说明第二段。",
    ]);
  });
});

describe("table-cell splitting", () => {
  it("preserves a literal backslash before an oversized cell delimiter", () => {
    const text = [
      "| First | Second |",
      "|---|---|",
      `| a \\\\ | ${"long value ".repeat(12)} |`,
    ].join("\n");

    const chunks = chunkQQBotMarkdownText(text, 80, baseChunker);

    expect(chunks.join("\n")).toContain("First: a \\");
    expect(chunks.join("\n")).toContain("Second: long value");
  });

  it("unescapes pipes when flushing a partial row in an active table", () => {
    const chunker = createQQBotMarkdownChunker(baseChunker);
    expect(
      chunker.chunkText(
        ["| First | Second |", "|---|---|", "| ready | complete |"].join("\n"),
        200,
      ),
    ).toEqual([["| First | Second |", "|---|---|", "| ready | complete |"].join("\n")]);

    expect(chunker.chunkText("| a \\| b | c", 200)).toEqual([]);
    expect(chunker.flushPendingText(200)).toEqual([["First: a | b", "Second: c"].join("\n")]);
  });
});
