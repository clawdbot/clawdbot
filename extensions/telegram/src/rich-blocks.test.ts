// Telegram rich-blocks unit tests for Bot API 10.2 InputRichBlock emission.
import { describe, expect, it } from "vitest";
import {
  countInputRichBlockChars,
  inputRichBlocksToPlainText,
  type InputRichBlock,
  type RichText,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";
import { buildTelegramRichMarkdown, splitTelegramRichMessageTextChunks } from "./rich-message.js";

function tableMarkdown(columns: number): string {
  return [
    `| ${Array.from({ length: columns }, (_, index) => `H${index + 1}`).join(" | ")} |`,
    `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
    `| ${Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | ")} |`,
  ].join("\n");
}

function collectUrls(text: RichText, out: string[] = []): string[] {
  if (typeof text === "string") {
    return out;
  }
  if (Array.isArray(text)) {
    for (const part of text) {
      collectUrls(part, out);
    }
    return out;
  }
  if (text.type === "url") {
    out.push(text.url);
  }
  if ("text" in text) {
    collectUrls(text.text, out);
  }
  return out;
}

function hasStyle(text: RichText, style: string): boolean {
  if (typeof text === "string") {
    return false;
  }
  if (Array.isArray(text)) {
    return text.some((part) => hasStyle(part, style));
  }
  return text.type === style || ("text" in text && hasStyle(text.text, style));
}

describe("markdownToTelegramRichBlocks", () => {
  it("nests inline styles and links", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      "**bold _italic_** and [docs](https://example.com) ~~strike~~ ||spoiler|| `code`",
    );
    expect(blocks[0]?.type).toBe("paragraph");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(hasStyle(text, "bold")).toBe(true);
    expect(hasStyle(text, "italic")).toBe(true);
    expect(hasStyle(text, "strikethrough")).toBe(true);
    expect(hasStyle(text, "spoiler")).toBe(true);
    expect(hasStyle(text, "code")).toBe(true);
    expect(collectUrls(text)).toEqual(["https://example.com"]);
  });

  it("handles overlapping bold and autolink", () => {
    const { blocks } = markdownToTelegramRichBlocks("**start https://example.com** end");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(hasStyle(text, "bold")).toBe(true);
    expect(collectUrls(text)).toEqual(["https://example.com"]);
  });

  it("emits pre blocks with fence language", () => {
    const { blocks } = markdownToTelegramRichBlocks("```bash\necho hi\n```");
    expect(blocks).toEqual([{ type: "pre", text: "echo hi", language: "bash" }]);
  });

  it("emits heading blocks with sizes", () => {
    const { blocks } = markdownToTelegramRichBlocks("# Title\n\n### Detail");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "heading"]);
    expect(blocks[0]).toMatchObject({ type: "heading", size: 1 });
    expect(blocks[1]).toMatchObject({ type: "heading", size: 3 });
  });

  it("emits blockquotes with nested paragraphs", () => {
    const { blocks } = markdownToTelegramRichBlocks("> first\n\n> second");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.type === "blockquote")).toBe(true);
  });

  it("splits paragraphs on blank lines and keeps single newlines", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks("a\nb\n\nc");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    if (blocks[0]?.type === "paragraph") {
      expect(inputRichBlocksToPlainText([blocks[0]])).toContain("a");
      expect(inputRichBlocksToPlainText([blocks[0]])).toContain("b");
    }
    expect(plainText.replace(/\n+/g, "\n")).toContain("a");
  });

  it("renders tables with header row, aligns, borders, and stripes", () => {
    const { blocks, degradationReasons } = markdownToTelegramRichBlocks(
      "| Feature | Status | Count |\n| :--- | :---: | ---: |\n| Rich | Fixed | 2 |",
      { tableMode: "block" },
    );
    expect(degradationReasons).toEqual([]);
    const table = blocks.find((block) => block.type === "table");
    expect(table?.type).toBe("table");
    if (table?.type !== "table") {
      return;
    }
    expect(table.is_bordered).toBe(true);
    expect(table.is_striped).toBe(true);
    expect(table.cells[0]?.every((cell) => cell.is_header === true)).toBe(true);
    expect(table.cells[0]?.map((cell) => cell.align)).toEqual(["left", "center", "right"]);
    expect(table.cells[1]?.map((cell) => cell.align)).toEqual(["left", "center", "right"]);
  });

  it("degrades wide tables to ASCII pre blocks", () => {
    const { blocks, degradationReasons } = markdownToTelegramRichBlocks(tableMarkdown(21), {
      tableMode: "block",
    });
    expect(degradationReasons).toEqual(["table-ascii"]);
    expect(blocks.some((block) => block.type === "pre")).toBe(true);
    expect(blocks.some((block) => block.type === "table")).toBe(false);
  });

  it("uses code tables when tableMode is code", () => {
    const { blocks } = markdownToTelegramRichBlocks(tableMarkdown(2), { tableMode: "code" });
    expect(blocks.some((block) => block.type === "pre")).toBe(true);
    expect(blocks.some((block) => block.type === "table")).toBe(false);
  });

  it("does not auto-linkify bare URLs when entity detection is skipped", () => {
    const { blocks } = markdownToTelegramRichBlocks("https://example.com", {
      skipEntityDetection: true,
    });
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectUrls(text)).toEqual([]);
  });

  it("keeps explicit markdown links when entity detection is skipped", () => {
    const { blocks } = markdownToTelegramRichBlocks("[docs](https://example.com)", {
      skipEntityDetection: true,
    });
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectUrls(text)).toEqual(["https://example.com"]);
  });

  it("keeps unsupported local links as visible text and wraps file refs as code", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      "[scripts/yougile.py](/home/user/scripts/yougile.py#L41) and [config](./openclaw.json)",
    );
    const plain = inputRichBlocksToPlainText(blocks);
    expect(plain).toContain("scripts/yougile.py");
    expect(plain).toContain("config");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectUrls(text)).toEqual([]);
  });

  it("wraps auto-linked file refs as code so Telegram does not re-linkify them", () => {
    const { blocks } = markdownToTelegramRichBlocks("see README.md for details");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectUrls(text)).toEqual([]);
    expect(hasStyle(text, "code")).toBe(true);
  });

  it("preserves authored file-style links while wrapping bare file refs as code", () => {
    const { blocks } = markdownToTelegramRichBlocks("README.md [README.md](https://README.md)");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectUrls(text)).toEqual(["https://README.md"]);
    expect(hasStyle(text, "code")).toBe(true);
  });

  it("derives plainText from the block projection", () => {
    const { plainText } = markdownToTelegramRichBlocks("**hello** world");
    expect(plainText).toContain("hello");
    expect(plainText).not.toContain("**");
  });

  it("keeps table content in plainText for the plain fallback", () => {
    const { plainText } = markdownToTelegramRichBlocks(
      "before\n\n| colA | colB |\n| - | - |\n| cell1 | cell2 |\n\nafter",
      { tableMode: "block" },
    );
    expect(plainText).toContain("cell1");
    expect(plainText).toContain("colB");
  });

  it("emits a code fence inside a blockquote exactly once, nested in the quote", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      "> intro\n> ```ts\n> const x = 1;\n> ```\n> outro",
    );
    expect(blocks).toHaveLength(1);
    const quote = blocks[0];
    expect(quote?.type).toBe("blockquote");
    if (quote?.type !== "blockquote") {
      return;
    }
    expect(quote.blocks.map((block) => block.type)).toEqual(["paragraph", "pre", "paragraph"]);
    const serialized = JSON.stringify(blocks);
    expect(serialized.split("const x = 1;").length - 1).toBe(1);
    expect(serialized.split("outro").length - 1).toBe(1);
  });

  it("emits a heading inside a blockquote exactly once", () => {
    const { blocks } = markdownToTelegramRichBlocks("> ## quoted heading\n> body");
    expect(blocks).toHaveLength(1);
    const quote = blocks[0];
    if (quote?.type !== "blockquote") {
      expect(quote?.type).toBe("blockquote");
      return;
    }
    expect(quote.blocks.some((block) => block.type === "heading")).toBe(true);
    expect(JSON.stringify(blocks).split("quoted heading").length - 1).toBe(1);
  });
});

describe("splitTelegramRichBlocks", () => {
  it("splits at the 500-block limit", () => {
    const blocks: InputRichBlock[] = Array.from({ length: 501 }, (_, index) => ({
      type: "paragraph",
      text: `item ${index}`,
    }));
    const chunks = splitTelegramRichBlocks(blocks, { blockLimit: 500 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(1);
  });

  it("splits at the text char limit", () => {
    const blocks: InputRichBlock[] = [
      { type: "paragraph", text: "a".repeat(20_000) },
      { type: "paragraph", text: "b".repeat(20_000) },
    ];
    const chunks = splitTelegramRichBlocks(blocks, { textLimit: 32_768 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const chars = chunk.reduce((total, block) => total + countInputRichBlockChars(block), 0);
      expect(chars).toBeLessThanOrEqual(32_768);
    }
  });

  it("does not split surrogate pairs at oversized-block boundaries", () => {
    const text = `${"a".repeat(63)}😀tail`;
    const chunks = splitTelegramRichBlocks([{ type: "pre", text }], { textLimit: 64 });
    for (const piece of chunks.flat()) {
      if (piece.type === "pre") {
        expect(piece.text).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
      }
    }
  });

  it("splits oversized styled paragraphs instead of sending over-limit chunks", () => {
    const { blocks } = markdownToTelegramRichBlocks(`**bold** ${"x".repeat(200)}`);
    const chunks = splitTelegramRichBlocks(blocks, { textLimit: 64 });
    for (const chunk of chunks) {
      const chars = chunk.reduce((total, block) => total + countInputRichBlockChars(block), 0);
      expect(chars).toBeLessThanOrEqual(64);
    }
    const first = chunks[0]?.[0];
    expect(first && first.type === "paragraph" && hasStyle(first.text, "bold")).toBe(true);
  });

  it("keeps link targets when an oversized styled paragraph splits", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      `${"x".repeat(60)} [docs](https://example.com/${"y".repeat(40)}) tail`,
    );
    const chunks = splitTelegramRichBlocks(blocks, { textLimit: 64 });
    const urls = chunks
      .flat()
      .flatMap((block) => (block.type === "paragraph" ? collectUrls(block.text) : []));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith("https://example.com/"))).toBe(true);
  });

  it("splits oversized blockquotes and tables at inner boundaries", () => {
    const quote: InputRichBlock = {
      type: "blockquote",
      blocks: [
        { type: "paragraph", text: "q".repeat(50) },
        { type: "paragraph", text: "r".repeat(50) },
      ],
    };
    const table: InputRichBlock = {
      type: "table",
      cells: [
        [{ text: "h".repeat(40), is_header: true }],
        [{ text: "c".repeat(40) }],
        [{ text: "d".repeat(40) }],
      ],
    };
    const chunks = splitTelegramRichBlocks([quote, table], { textLimit: 64 });
    for (const chunk of chunks) {
      const chars = chunk.reduce((total, block) => total + countInputRichBlockChars(block), 0);
      expect(chars).toBeLessThanOrEqual(64);
    }
  });
});

describe("rich message plan wiring", () => {
  it("emits blocks InputRichMessage and email skip_entity_detection", () => {
    const message = buildTelegramRichMarkdown("Contact owner@example.com for help");
    if (!("blocks" in message)) {
      expect.fail("expected a blocks rich message");
    }
    expect(message.blocks.length).toBeGreaterThan(0);
    expect(message.skip_entity_detection).toBe(true);
    expect("html" in message).toBe(false);
  });

  it("passes skip_entity_detection through chunked rich messages", () => {
    const chunks = splitTelegramRichMessageTextChunks({
      text: `${"hello\n\n".repeat(10)}owner@example.com`,
      textLimit: 32_768,
    });
    expect(chunks.some((chunk) => chunk.richMessage.skip_entity_detection === true)).toBe(true);
  });

  it("applies the document-level skip flag to every chunk", () => {
    // An email anywhere disables linkification for the whole render, so chunks
    // without the email would otherwise expose unprotected file refs (README.md)
    // to Telegram's server-side entity detection.
    const chunks = splitTelegramRichMessageTextChunks({
      text: `see README.md for details\n\n${"filler ".repeat(20)}\n\nping owner@example.com`,
      textLimit: 80,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.richMessage.skip_entity_detection === true)).toBe(true);
  });

  it("sends readable source text when markdown projects to zero blocks", () => {
    const chunks = splitTelegramRichMessageTextChunks({
      text: "[ref]: https://example.com",
      textLimit: 32_768,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.plainText).toContain("example.com");
  });
});
