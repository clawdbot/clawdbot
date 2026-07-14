// QQ Bot Markdown chunking tests cover message-boundary table repair.
import { describe, expect, it } from "vitest";
import { chunkQQBotMarkdownText, createQQBotMarkdownChunker } from "./markdown-table-chunking.js";

const baseChunker = (text: string, limit: number): string[] =>
  text.length <= limit ? [text] : [text.slice(0, limit), text.slice(limit)];

describe("chunkQQBotMarkdownText", () => {
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

  it("keeps fenced code blocks self-contained across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText(["```ts", "const a = 1;"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText(["const b = 2;", "```"].join("\n"), 200)).toEqual([
      ["```ts", "const a = 1;", "const b = 2;", "```"].join("\n"),
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
      ["```python", "    pool_timeout: float = 30.0", "    def get_dsn(self) -> str:", "```"].join(
        "\n",
      ),
    ]);
  });

  it("keeps long fenced chunks under the QQ markdown byte safety limit", () => {
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
      expect(chunk.startsWith("```python\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }
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
      expect(chunk.startsWith("```python\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }
  });

  it("keeps fenced formula blocks self-contained across streaming block flushes", () => {
    const chunker = createQQBotMarkdownChunker((text) => [text]);

    expect(chunker.chunkText(["```math", "E = mc^2"].join("\n"), 200)).toEqual([]);
    expect(chunker.chunkText(["a^2 + b^2 = c^2", "```"].join("\n"), 200)).toEqual([
      ["```math", "E = mc^2", "a^2 + b^2 = c^2", "```"].join("\n"),
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

      expect(chunks).toEqual([
        ["```ts", firstLine, "```"].join("\n"),
        ["```ts", secondLine, "```"].join("\n"),
      ]);
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
