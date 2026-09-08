// Telegram rich-blocks unit tests for Bot API 10.3 InputRichBlock emission.
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";
import {
  countInputRichBlockChars,
  countInputRichBlockMedia,
  countInputRichBlocks,
  inputRichBlocksToPlainText,
  type InputRichBlock,
  type RichText,
} from "./rich-block-model.js";
import { splitTelegramRichBlocks } from "./rich-block-split.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";
import { buildTelegramRichMarkdown } from "./rich-message.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";

function tableMarkdown(columns: number): string {
  return [
    `| ${Array.from({ length: columns }, (_, index) => `H${index + 1}`).join(" | ")} |`,
    `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
    `| ${Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | ")} |`,
  ].join("\n");
}

function collectLinkTargets(text: RichText, out: string[] = []): string[] {
  if (typeof text === "string") {
    return out;
  }
  if (Array.isArray(text)) {
    for (const part of text) {
      collectLinkTargets(part, out);
    }
    return out;
  }
  if (text.type === "url") {
    out.push(text.url);
  } else if (text.type === "anchor_link") {
    out.push(`#${text.anchor_name}`);
  }
  if ("text" in text) {
    collectLinkTargets(text.text, out);
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
  it.each([
    {
      name: "bullet items",
      markdown: "- alpha\n- beta",
      before: "• alpha\n• beta",
      after: {
        type: "list" as const,
        items: [
          { blocks: [{ type: "paragraph" as const, text: "alpha" }] },
          { blocks: [{ type: "paragraph" as const, text: "beta" }] },
        ],
      },
    },
    {
      name: "ordered start values",
      markdown: "4. fourth\n5. fifth",
      before: "4. fourth\n5. fifth",
      after: {
        type: "list" as const,
        items: [
          { blocks: [{ type: "paragraph" as const, text: "fourth" }], value: 4 },
          { blocks: [{ type: "paragraph" as const, text: "fifth" }], value: 5 },
        ],
      },
    },
    {
      name: "task checkboxes",
      markdown: "- [ ] todo\n- [x] done",
      before: "• [ ] todo\n• [x] done",
      after: {
        type: "list" as const,
        items: [
          {
            blocks: [{ type: "paragraph" as const, text: "todo" }],
            has_checkbox: true as const,
          },
          {
            blocks: [{ type: "paragraph" as const, text: "done" }],
            has_checkbox: true as const,
            is_checked: true as const,
          },
        ],
      },
    },
    {
      name: "mixed nesting",
      markdown: "- parent\n  1. child\n  2. sibling\n- next",
      before: "• parent\n  1. child\n  2. sibling\n• next",
      after: {
        type: "list" as const,
        items: [
          {
            blocks: [
              { type: "paragraph" as const, text: "parent" },
              {
                type: "list" as const,
                items: [
                  { blocks: [{ type: "paragraph" as const, text: "child" }], value: 1 },
                  { blocks: [{ type: "paragraph" as const, text: "sibling" }], value: 2 },
                ],
              },
            ],
          },
          { blocks: [{ type: "paragraph" as const, text: "next" }] },
        ],
      },
    },
  ])("maps $name from flattened text to native blocks", ({ markdown, before, after }) => {
    const rendered = markdownToTelegramRichBlocks(markdown);
    expect(rendered.blocks).toEqual([after]);
    expect(rendered.plainText).toBe(before);
  });

  it("keeps the classic sendMessage list path byte-identical", () => {
    expect(markdownToTelegramHtml("- [ ] todo\n- [x] done\n\n4. fourth\n5. fifth")).toBe(
      "• [ ] todo\n• [x] done\n\n4. fourth\n5. fifth",
    );
  });

  it("keeps list boundaries separate from following paragraphs", () => {
    const rendered = markdownToTelegramRichBlocks("- one\n- two\n\nafter");
    expect(rendered.blocks.map((block) => block.type)).toEqual(["list", "paragraph"]);
    expect(rendered.blocks[1]).toEqual({ type: "paragraph", text: "after" });
  });

  it("uses parser-owned boundaries before a following heading", () => {
    const rendered = markdownToTelegramRichBlocks("- one\n# Heading");
    expect(rendered.blocks.map((block) => block.type)).toEqual(["list", "heading"]);
  });

  it("keeps loose continuation paragraphs inside their native list item", () => {
    const rendered = markdownToTelegramRichBlocks("- first\n\n  continuation\n- next");
    expect(rendered.blocks).toHaveLength(1);
    const list = rendered.blocks[0];
    if (list?.type !== "list") {
      expect(list?.type).toBe("list");
      return;
    }
    expect(list.items[0]?.blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
    expect(rendered.plainText).toBe("• first\ncontinuation\n• next");
  });

  it("returns parent continuation content after a nested list", () => {
    const rendered = markdownToTelegramRichBlocks("- parent\n  - child\n\n  continuation");
    const outer = rendered.blocks[0];
    if (outer?.type !== "list") {
      expect(outer?.type).toBe("list");
      return;
    }
    expect(outer.items[0]?.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "list",
      "paragraph",
    ]);
    const nested = outer.items[0]?.blocks[1];
    expect(nested?.type).toBe("list");
    expect(inputRichBlocksToPlainText(nested?.type === "list" ? [nested] : [])).not.toContain(
      "continuation",
    );
  });

  it("preserves a blockquote around a nested list", () => {
    const rendered = markdownToTelegramRichBlocks("- outer\n  > - inner");
    const outer = rendered.blocks[0];
    if (outer?.type !== "list") {
      expect(outer?.type).toBe("list");
      return;
    }
    const quote = outer.items[0]?.blocks.find((block) => block.type === "blockquote");
    expect(quote?.type).toBe("blockquote");
    if (quote?.type === "blockquote") {
      expect(quote.blocks[0]?.type).toBe("list");
    }
  });

  it("keeps distinct same-kind child lists separated by parent content", () => {
    const rendered = markdownToTelegramRichBlocks(
      "- outer\n  - first\n\n  parent text\n\n  - second",
    );
    const outer = rendered.blocks[0];
    if (outer?.type !== "list") {
      expect(outer?.type).toBe("list");
      return;
    }
    expect(outer.items[0]?.blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "list",
      "paragraph",
      "list",
    ]);
  });

  it("nests Markdown lists inside blockquotes", () => {
    const rendered = markdownToTelegramRichBlocks("> - parent\n>   - child");
    expect(rendered.blocks).toHaveLength(1);
    const quote = rendered.blocks[0];
    expect(quote?.type).toBe("blockquote");
    if (quote?.type !== "blockquote") {
      return;
    }
    expect(quote.blocks[0]?.type).toBe("list");
    expect(rendered.plainText).toBe("• parent\n  • child");
  });

  it("keeps rich inline formatting inside native list items", () => {
    const rendered = markdownToTelegramRichBlocks("- **bold** and [docs](https://example.com)");
    const list = rendered.blocks[0];
    if (list?.type !== "list") {
      expect(list?.type).toBe("list");
      return;
    }
    const paragraph = list.items[0]?.blocks[0];
    if (paragraph?.type !== "paragraph") {
      expect(paragraph?.type).toBe("paragraph");
      return;
    }
    expect(hasStyle(paragraph.text, "bold")).toBe(true);
    expect(collectLinkTargets(paragraph.text)).toEqual(["https://example.com"]);
  });

  it("degrades native lists beyond 16 nesting levels", () => {
    const markdown = Array.from(
      { length: 17 },
      (_, index) => `${"  ".repeat(index)}- level ${index + 1}`,
    ).join("\n");
    const rendered = markdownToTelegramRichBlocks(markdown);
    expect(rendered.degradationReasons).toEqual(["list-limit"]);
    expect(rendered.blocks.every((block) => block.type !== "list")).toBe(true);
    expect(rendered.plainText).toContain("level 17");
  });

  it("includes surrounding blockquotes in the 16-level nesting budget", () => {
    const markdown = Array.from(
      { length: 16 },
      (_, index) => `> ${"  ".repeat(index)}- level ${index + 1}`,
    ).join("\n");
    const rendered = markdownToTelegramRichBlocks(markdown);
    expect(rendered.degradationReasons).toEqual(["list-limit"]);
    expect(JSON.stringify(rendered.blocks)).not.toContain('"type":"list"');
  });

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
    expect(collectLinkTargets(text)).toEqual(["https://example.com"]);
  });

  it("handles overlapping bold and autolink", () => {
    const { blocks } = markdownToTelegramRichBlocks("**start https://example.com** end");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(hasStyle(text, "bold")).toBe(true);
    expect(collectLinkTargets(text)).toEqual([]);
  });

  it.each([
    "&lt;b&gt;**literal**&lt;/b&gt;",
    "&#60;b&#62;**literal**&#x3c;/b&#x3e;",
    "\\<b\\>**literal**\\</b\\>",
    "<&#98;>**literal**</&#98;>",
    "<b&gt;**literal**</b&gt;",
  ])("keeps decoded literal tag syntax visible: %s", (markdown) => {
    const result = markdownToTelegramRichBlocks(markdown);
    expect(result.blocks).toEqual([
      { type: "paragraph", text: ["<b>", { type: "bold", text: "literal" }, "</b>"] },
    ]);
    expect(result.plainText).toBe("<b>literal</b>");
  });

  it("does not synthesize HTML tags across Markdown formatting boundaries", () => {
    const result = markdownToTelegramRichBlocks("<**b**>literal</**b**>");
    expect(result.plainText).toBe("<b>literal</b>");
    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        text: ["<", { type: "bold", text: "b" }, ">literal</", { type: "bold", text: "b" }, ">"],
      },
    ]);
  });

  it("keeps image alternatives literal and Markdown links in tag-shaped text", () => {
    const result = markdownToTelegramRichBlocks(
      "&lt;b&gt;**literal**&lt;/b&gt; ![<i>alt</i>](https://example.com/image.png) <b[r](https://example.com/qa)>tail",
    );
    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        text: [
          "<b>",
          { type: "bold", text: "literal" },
          "</b> <i>alt</i> <b",
          { type: "url", url: "https://example.com/qa", text: "r" },
          ">tail",
        ],
      },
    ]);
    expect(result.plainText).toBe("<b>literal</b> <i>alt</i> <br>tail");
  });

  it("keeps authored HTML and encoded attribute data beside literal tags", () => {
    const result = markdownToTelegramRichBlocks(
      '<a href="https://example.com/?a=1&amp;b=2">**literal**</a> &lt;i&gt;text&lt;/i&gt;',
    );
    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        text: [
          {
            type: "url",
            url: "https://example.com/?a=1&b=2",
            text: { type: "bold", text: "literal" },
          },
          " <i>text</i>",
        ],
      },
    ]);
    expect(result.plainText).toBe("literal <i>text</i>");
  });

  it("does not hide authored tags inside decoded literal comment delimiters", () => {
    expect(markdownToTelegramRichBlocks("&lt;!-- <b>literal</b> --&gt;").blocks).toEqual([
      { type: "paragraph", text: ["<!-- ", { type: "bold", text: "literal" }, " -->"] },
    ]);
  });

  it.each([
    {
      markdown: "<!-- **<b>literal</b>** &amp; -->",
      text: "<!-- **<b>literal</b>** &amp; -->",
    },
    {
      markdown: "<!-- Example\nuser[Thu] -->",
      text: "<!-- Example\nuser[Thu] -->",
    },
    {
      markdown: "<**!**-- <b>literal</b> -->",
      text: ["<", { type: "bold", text: "!" }, "-- ", { type: "bold", text: "literal" }, " -->"],
    },
    {
      markdown: "<!&#65; <b>literal</b>>",
      text: ["<!A ", { type: "bold", text: "literal" }, ">"],
    },
    {
      markdown: "<!**A** <b>literal</b>>",
      text: ["<!", { type: "bold", text: "A" }, " ", { type: "bold", text: "literal" }, ">"],
    },
    {
      markdown: "<!A &amp; <b>literal</b>>",
      text: "<!A &amp; <b>literal</b>>",
    },
  ])("preserves opaque construct syntax provenance: $markdown", ({ markdown, text }) => {
    expect(markdownToTelegramRichBlocks(markdown).blocks).toEqual([{ type: "paragraph", text }]);
  });

  it.each([
    "- &lt;b&gt;**literal**&lt;/b&gt;",
    "> &lt;b&gt;**literal**&lt;/b&gt;",
    "<details><summary>More</summary><p>&lt;b&gt;**literal**&lt;/b&gt;</p></details>",
  ])("keeps literal provenance inside nested blocks: %s", (markdown) => {
    const result = markdownToTelegramRichBlocks(markdown);
    expect(result.plainText).toContain("<b>literal</b>");
    const block = result.blocks[0];
    const body =
      block?.type === "list"
        ? block.items[0]?.blocks
        : block?.type === "blockquote" || block?.type === "details"
          ? block.blocks
          : [];
    expect(body).toEqual([
      { type: "paragraph", text: ["<b>", { type: "bold", text: "literal" }, "</b>"] },
    ]);
  });

  it("keeps literal provenance in native table cells", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      "| Value |\n| --- |\n| &lt;b&gt;**literal**&lt;/b&gt; |",
    );
    expect(blocks[0]).toMatchObject({
      type: "table",
      cells: [[{ text: "Value" }], [{ text: ["<b>", { type: "bold", text: "literal" }, "</b>"] }]],
    });
  });

  it.each(
    [
      {
        source: "<tg-math>x</tg-math>",
        atom: { type: "mathematical_expression", expression: "x" },
      },
      {
        source: '<tg-emoji emoji-id="5368324170671202286">😀</tg-emoji>',
        atom: {
          type: "custom_emoji",
          custom_emoji_id: "5368324170671202286",
          alternative_text: "😀",
        },
      },
    ].flatMap(({ source, atom }) => [
      { markdown: `||${source}||`, expected: { type: "spoiler", text: atom } },
      {
        markdown: `[${source}](https://example.com)`,
        expected: { type: "url", text: atom, url: "https://example.com" },
      },
    ]),
  )("preserves Markdown wrappers around $markdown", ({ markdown, expected }) => {
    expect(markdownToTelegramRichBlocks(markdown).blocks).toEqual([
      { type: "paragraph", text: expected },
    ]);
  });

  it.each([
    {
      open: '<a href="https://example.com">',
      close: "</a>",
      wrapper: { type: "url", url: "https://example.com" },
    },
    { open: "<b>", close: "</b>", wrapper: { type: "bold" } },
  ])(
    "excludes transcript annotations from HTML $wrapper.type wrappers",
    ({ open, close, wrapper }) => {
      const { blocks, plainText } = markdownToTelegramRichBlocks(
        `${open}\nuser[Thu] trailing${close}`,
      );
      expect(blocks).toEqual([
        {
          type: "paragraph",
          text: expect.arrayContaining([
            { type: "code", text: "user[Thu]" },
            { ...wrapper, text: " trailing" },
          ]),
        },
      ]);
      expect(plainText).toBe("\nuser[Thu] trailing");
    },
  );

  it.each(["https://example.com", "#section"])(
    "preserves authored %s links with code-only labels",
    (href) => {
      for (const [prefix, suffix] of [
        ["", ""],
        ["", "bar"],
        ["a", "z"],
      ]) {
        const markdown = `${prefix ? `\`${prefix}\`` : ""}[\`foo\`](${href})${suffix ? `\`${suffix}\`` : ""}`;
        const { blocks, plainText } = markdownToTelegramRichBlocks(markdown);
        const text = blocks[0]?.type === "paragraph" ? blocks[0].text : "";
        expect(collectLinkTargets(text), markdown).toEqual([href]);
        expect(hasStyle(text, "code"), markdown).toBe(true);
        expect(plainText).toBe(`${prefix}foo${suffix}`);
      }
    },
  );

  it("preserves independently authored bold inside merged adjacent code spans", () => {
    const { blocks, plainText } = markdownToTelegramRichBlocks("`a`**`b`**`c`");
    const text = blocks[0]?.type === "paragraph" ? blocks[0].text : "";
    expect(hasStyle(text, "code")).toBe(true);
    expect(hasStyle(text, "bold")).toBe(true);
    expect(plainText).toBe("abc");
  });

  it.each([
    {
      markdown: "**A ||B** C|| D",
      text: [
        { type: "bold", text: ["A ", { type: "spoiler", text: "B" }] },
        { type: "spoiler", text: " C" },
        " D",
      ],
    },
    {
      markdown: "||A **B|| C** D",
      text: [
        { type: "spoiler", text: ["A ", { type: "bold", text: "B" }] },
        { type: "bold", text: " C" },
        " D",
      ],
    },
    {
      markdown: "[A ||B](https://example.com) C|| D",
      text: [
        {
          type: "url",
          url: "https://example.com",
          text: ["A ", { type: "spoiler", text: "B" }],
        },
        { type: "spoiler", text: " C" },
        " D",
      ],
    },
  ])("preserves crossing inline ranges in $markdown", ({ markdown, text }) => {
    const result = markdownToTelegramRichBlocks(markdown);
    expect(result.blocks).toEqual([{ type: "paragraph", text }]);
    expect(result.plainText).toBe("A B C D");
  });

  it.each([
    {
      markdown: "**user[Thu] trailing**",
      trailing: { type: "bold", text: " trailing" },
    },
    {
      markdown: "[user[Thu] trailing](https://example.com)",
      trailing: { type: "url", url: "https://example.com", text: " trailing" },
    },
  ])(
    "preserves formatting outside a transcript annotation in $markdown",
    ({ markdown, trailing }) => {
      const result = markdownToTelegramRichBlocks(markdown);
      expect(result.blocks).toEqual([
        { type: "paragraph", text: [{ type: "code", text: "user[Thu]" }, trailing] },
      ]);
      expect(result.plainText).toBe("user[Thu] trailing");
    },
  );

  it("leaves bare URL query separators to Telegram entity detection", () => {
    const url = "https://example.com/wp-admin/post.php?post=100&action=edit";
    const { blocks } = markdownToTelegramRichBlocks(url);

    expect(blocks).toEqual([{ type: "paragraph", text: url }]);
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

  it("aligns Unicode cells when wide tables degrade to ASCII", () => {
    const header = `| ${Array.from({ length: 21 }, (_value, index) => `H${index + 1}`).join(" | ")} |`;
    const separator = `| ${Array.from({ length: 21 }, () => "---").join(" | ")} |`;
    const values = [
      "小明",
      "✅",
      "⌚",
      "⚽",
      "👨‍👩‍👧",
      "🇨🇳",
      "1⃣",
      "1️⃣",
      "❤",
      "❤️",
      "©",
      "©️",
      "cafe\u0301",
      ...Array.from({ length: 8 }, (_value, index) => String(index + 14)),
    ];
    const row = `| ${values.join(" | ")} |`;
    const { blocks } = markdownToTelegramRichBlocks([header, separator, row].join("\n"), {
      tableMode: "block",
    });
    const pre = blocks.find((block) => block.type === "pre");
    expect(pre?.type).toBe("pre");
    if (pre?.type !== "pre") {
      return;
    }
    expect(new Set(pre.text.split("\n").map((line) => stringWidth(line))).size).toBe(1);
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
    expect(collectLinkTargets(text)).toEqual([]);
  });

  it("keeps explicit markdown links when entity detection is skipped", () => {
    const { blocks } = markdownToTelegramRichBlocks("[docs](https://example.com)", {
      skipEntityDetection: true,
    });
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectLinkTargets(text)).toEqual(["https://example.com"]);
  });

  it("keeps unsupported local links as visible text and wraps file refs as code", () => {
    const { blocks } = markdownToTelegramRichBlocks(
      "[scripts/yougile.py](/home/user/scripts/yougile.py#L41) and [config](./openclaw.json)",
    );
    const plain = inputRichBlocksToPlainText(blocks);
    expect(plain).toContain("scripts/yougile.py");
    expect(plain).toContain("config");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectLinkTargets(text)).toEqual([]);
  });

  it("wraps auto-linked file refs as code so Telegram does not re-linkify them", () => {
    const { blocks } = markdownToTelegramRichBlocks("see README.md for details");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectLinkTargets(text)).toEqual([]);
    expect(hasStyle(text, "code")).toBe(true);
  });

  it("preserves authored file-style links while wrapping bare file refs as code", () => {
    const { blocks } = markdownToTelegramRichBlocks("README.md [README.md](https://README.md)");
    const text = blocks[0] && blocks[0].type === "paragraph" ? blocks[0].text : "";
    expect(collectLinkTargets(text)).toEqual(["https://README.md"]);
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
      .flatMap((block) => (block.type === "paragraph" ? collectLinkTargets(block.text) : []));
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
        [{ text: "h".repeat(40), is_header: true, align: "left", valign: "middle" }],
        [{ text: "c".repeat(40), align: "left", valign: "middle" }],
        [{ text: "d".repeat(40), align: "left", valign: "middle" }],
      ],
    };
    const chunks = splitTelegramRichBlocks([quote, table], { textLimit: 64 });
    for (const chunk of chunks) {
      const chars = chunk.reduce((total, block) => total + countInputRichBlockChars(block), 0);
      expect(chars).toBeLessThanOrEqual(64);
    }
  });

  it.each(["blockquote", "details"] as const)(
    "enforces recursive block limits for %s children",
    (type) => {
      const children: InputRichBlock[] = Array.from({ length: 6 }, (_, index) => ({
        type: "paragraph",
        text: `entry ${index}`,
      }));
      const block: InputRichBlock =
        type === "blockquote"
          ? { type, blocks: children, credit: "Author" }
          : { type, blocks: children, summary: "Summary" };

      const chunks = splitTelegramRichBlocks([block], { blockLimit: 5 });

      expect(chunks).toHaveLength(2);
      expect(chunks.every((chunk) => countInputRichBlocks(chunk) <= 5)).toBe(true);
      expect(
        chunks
          .flat()
          .flatMap((part) =>
            part.type === "blockquote" || part.type === "details" ? part.blocks : [],
          ),
      ).toEqual(children);
      if (type === "blockquote") {
        expect(
          chunks
            .flat()
            .flatMap((part) => (part.type === "blockquote" && part.credit ? [part.credit] : [])),
        ).toEqual(["Author"]);
      }
    },
  );

  it("splits lists by whole items and isolates an indivisible oversized item", () => {
    const items = [
      { value: 4, blocks: [{ type: "paragraph" as const, text: "first" }] },
      {
        value: 5,
        has_checkbox: true as const,
        blocks: Array.from({ length: 5 }, (_, index) => ({
          type: "paragraph" as const,
          text: `nested ${index}`,
        })),
      },
      { value: 6, blocks: [{ type: "paragraph" as const, text: "last" }] },
    ];

    const chunks = splitTelegramRichBlocks([{ type: "list", items }], { blockLimit: 5 });
    const lists = chunks.flat().filter((block) => block.type === "list");

    expect(chunks).toHaveLength(3);
    expect(lists.flatMap((list) => list.items)).toEqual(items);
    expect(countInputRichBlocks(chunks[0] ?? [])).toBeLessThanOrEqual(5);
    expect(countInputRichBlocks(chunks[1] ?? [])).toBeGreaterThan(5);
    expect(countInputRichBlocks(chunks[2] ?? [])).toBeLessThanOrEqual(5);
  });

  it("splits table rows and album media without duplicating captions", () => {
    const table: InputRichBlock = {
      type: "table",
      caption: "Table caption",
      cells: Array.from({ length: 6 }, (_, index) => [
        [{ text: `row ${index}`, align: "left" as const, valign: "middle" as const }],
      ]).flat(),
    };
    const collage: InputRichBlock = {
      type: "collage",
      caption: { text: "Album caption" },
      blocks: Array.from({ length: 51 }, (_, index) => ({
        type: "photo" as const,
        photo: { type: "photo" as const, media: `https://example.com/${index}.jpg` },
      })),
    };

    const tableChunks = splitTelegramRichBlocks([table], { blockLimit: 5 });
    const mediaChunks = splitTelegramRichBlocks([collage]);
    const tables = tableChunks.flat().filter((block) => block.type === "table");
    const albums = mediaChunks.flat().filter((block) => block.type === "collage");

    expect(tableChunks.every((chunk) => countInputRichBlocks(chunk) <= 5)).toBe(true);
    expect(tables.flatMap((part) => part.cells)).toEqual(table.cells);
    expect(tables.flatMap((part) => (part.caption ? [part.caption] : []))).toEqual([
      "Table caption",
    ]);
    expect(
      mediaChunks.every(
        (chunk) => chunk.reduce((total, block) => total + countInputRichBlockMedia(block), 0) <= 50,
      ),
    ).toBe(true);
    expect(albums.flatMap((album) => album.blocks)).toEqual(collage.blocks);
    expect(albums.flatMap((album) => (album.caption ? [album.caption.text] : []))).toEqual([
      "Album caption",
    ]);
  });
});

describe("rich message plan wiring", () => {
  it("preserves ordinary ordered lists across recursive block chunks", () => {
    const text = Array.from({ length: 250 }, (_, index) => `${index + 1}. item ${index + 1}`).join(
      "\n",
    );

    const chunks = planTelegramTextDeliveryPages({ text, maxChars: 32_768, richMessages: true });
    const lists = chunks
      .flatMap((chunk) => chunk.richMessage?.blocks ?? [])
      .filter((block) => block.type === "list");

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every((chunk) => countInputRichBlocks(chunk.richMessage?.blocks ?? []) <= 500),
    ).toBe(true);
    expect(lists.flatMap((list) => list.items).map((item) => item.value)).toEqual(
      Array.from({ length: 250 }, (_, index) => index + 1),
    );
    expect(chunks.flatMap((chunk) => chunk.degradationReasons ?? [])).toEqual([]);
  });

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
    const chunks = planTelegramTextDeliveryPages({
      text: `${"hello\n\n".repeat(10)}owner@example.com`,
      maxChars: 32_768,
      richMessages: true,
    });
    expect(chunks.some((chunk) => chunk.richMessage?.skip_entity_detection === true)).toBe(true);
  });

  it("applies the document-level skip flag to every chunk", () => {
    // An email anywhere disables linkification for the whole render, so chunks
    // without the email would otherwise expose unprotected file refs (README.md)
    // to Telegram's server-side entity detection.
    const chunks = planTelegramTextDeliveryPages({
      text: `see README.md for details\n\n${"filler ".repeat(20)}\n\nping owner@example.com`,
      maxChars: 80,
      richMessages: true,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.richMessage?.skip_entity_detection === true)).toBe(true);
  });

  it("sends readable source text when markdown projects to zero blocks", () => {
    const chunks = planTelegramTextDeliveryPages({
      text: "[ref]: https://example.com",
      maxChars: 32_768,
      richMessages: true,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.plainText).toContain("example.com");
  });
});
