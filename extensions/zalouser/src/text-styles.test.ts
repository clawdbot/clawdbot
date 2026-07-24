import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle } from "./zca-constants.js";

describe("parseZalouserTextStyles", () => {
  it("renders inline markdown emphasis as Zalo style ranges", () => {
    expect(parseZalouserTextStyles("**bold** *italic* ~~strike~~")).toEqual({
      text: "bold italic strike",
      styles: [
        { start: 0, len: 4, st: TextStyle.Bold },
        { start: 5, len: 6, st: TextStyle.Italic },
        { start: 12, len: 6, st: TextStyle.StrikeThrough },
      ],
    });
  });

  it.each([
    {
      name: "resolves ambiguous triple-marker nesting with CommonMark precedence",
      input: "***foo** bar*",
      before: { text: "***foo** bar*", styles: [] },
      after: {
        text: "foo bar",
        styles: [
          { start: 0, len: 7, st: TextStyle.Italic },
          { start: 0, len: 3, st: TextStyle.Bold },
        ],
      },
    },
    {
      name: "uses Unicode-aware underscore flanking inside words",
      input: "привет_мир_снова",
      before: {
        text: "приветмирснова",
        styles: [{ start: 6, len: 3, st: TextStyle.Italic }],
      },
      after: { text: "привет_мир_снова", styles: [] },
    },
  ])("documents before and after: $name", ({ input, after }) => {
    expect(parseZalouserTextStyles(input)).toEqual(after);
  });

  it("keeps inline code and plain math markers literal", () => {
    expect(parseZalouserTextStyles("before `inline *code*` after\n2 * 3 * 4")).toEqual({
      text: "before `inline *code*` after\n2 * 3 * 4",
      styles: [],
    });
  });

  it.each([
    ["authored underline HTML inside code", "`<u>x</u>`", "`<u>x</u>`"],
    ["code after an escaped backtick", "\\` `*x*`", "` `*x*`"],
    ["HTML entities resembling projection sentinels", "&#xE000;", "&#xE000;"],
    ["blank-line paragraph boundaries", "**first\n\nsecond**", "**first\n\nsecond**"],
    ["unsupported escapes", "\\[literal]", "\\[literal]"],
    ["hard-break syntax", "line\\\nnext  ", "line\\\nnext  "],
    ["backslash before trailing whitespace", "line\\  ", "line\\  "],
    ["whitespace-only paragraph boundaries", "**first\n  \nsecond**", "**first\n\nsecond**"],
    ["authored token-shaped text", "<zalouser-token-0>[", "<zalouser-token-0>["],
    ["rendered token-shaped text", "<zalouser\\-token-0>", "<zalouser-token-0>"],
  ])("keeps local literal bytes for %s", (_name, input, text) => {
    expect(parseZalouserTextStyles(input)).toEqual({ text, styles: [] });
  });

  it("keeps emphasis flanking next to protected inline code", () => {
    expect(parseZalouserTextStyles("_foo_`bar`")).toEqual({
      text: "foo`bar`",
      styles: [{ start: 0, len: 3, st: TextStyle.Italic }],
    });
  });

  it("keeps link syntax literal while styling its label", () => {
    expect(parseZalouserTextStyles("[**label**](https://example.com)")).toEqual({
      text: "[label](https://example.com)",
      styles: [{ start: 1, len: 5, st: TextStyle.Bold }],
    });
  });

  it("projects token-dense input without leaking sentinels", () => {
    const result = parseZalouserTextStyles("{red}x{/red}".repeat(4_100));
    expect(result.text).toBe("x".repeat(4_100));
    expect(result.styles).toHaveLength(4_100);
  });

  it("keeps emphasis isolated from local block compilation", () => {
    expect(parseZalouserTextStyles("**before\n# heading\nafter**")).toEqual({
      text: "**before\nheading\nafter**",
      styles: [
        { start: 9, len: 7, st: TextStyle.Bold },
        { start: 9, len: 7, st: TextStyle.Big },
      ],
    });
  });

  it("preserves backslash escapes inside code spans and fenced code blocks", () => {
    expect(parseZalouserTextStyles("before `\\*` after\n```ts\n\\*\\_\\\\\n```")).toEqual({
      text: "before `\\*` after\n\\*\\_\\\\",
      styles: [],
    });
  });

  it("closes fenced code blocks when the input uses CRLF newlines", () => {
    expect(parseZalouserTextStyles("```\r\n*code*\r\n```\r\n**after**")).toEqual({
      text: "*code*\nafter",
      styles: [{ start: 7, len: 5, st: TextStyle.Bold }],
    });
  });

  it("maps headings, block quotes, and lists into line styles", () => {
    expect(parseZalouserTextStyles(["# Title", "> quoted", "  - nested"].join("\n"))).toEqual({
      text: "Title\nquoted\nnested",
      styles: [
        { start: 0, len: 5, st: TextStyle.Bold },
        { start: 0, len: 5, st: TextStyle.Big },
        { start: 6, len: 6, st: TextStyle.Indent, indentSize: 1 },
        { start: 13, len: 6, st: TextStyle.UnorderedList },
      ],
    });
  });

  it("treats 1-3 leading spaces as markdown padding for headings and lists", () => {
    expect(parseZalouserTextStyles("  # Title\n   1. item\n  - bullet")).toEqual({
      text: "Title\nitem\nbullet",
      styles: [
        { start: 0, len: 5, st: TextStyle.Bold },
        { start: 0, len: 5, st: TextStyle.Big },
        { start: 6, len: 4, st: TextStyle.OrderedList },
        { start: 11, len: 6, st: TextStyle.UnorderedList },
      ],
    });
  });

  it("strips fenced code markers and preserves leading indentation with nbsp", () => {
    expect(parseZalouserTextStyles("```ts\n  const x = 1\n\treturn x\n```")).toEqual({
      text: "\u00A0\u00A0const x = 1\n\u00A0\u00A0\u00A0\u00A0return x",
      styles: [],
    });
  });

  it("treats tilde fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("~~~bash\n*cmd*\n~~~")).toEqual({
      text: "*cmd*",
      styles: [],
    });
  });

  it("treats fences indented under list items as literal code blocks", () => {
    expect(parseZalouserTextStyles("  ```\n*cmd*\n  ```")).toEqual({
      text: "*cmd*",
      styles: [],
    });
  });

  it("treats quoted backtick fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("> ```js\n> *cmd*\n> ```")).toEqual({
      text: "*cmd*",
      styles: [],
    });
  });

  it("treats quoted tilde fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("> ~~~\n> *cmd*\n> ~~~")).toEqual({
      text: "*cmd*",
      styles: [],
    });
  });

  it("preserves quote-prefixed lines inside normal fenced code blocks", () => {
    expect(parseZalouserTextStyles("```\n> prompt\n```")).toEqual({
      text: "> prompt",
      styles: [],
    });
  });

  it("does not treat quote-prefixed fence text inside code as a closing fence", () => {
    expect(parseZalouserTextStyles("```\n> ```\n*still code*\n```")).toEqual({
      text: "> ```\n*still code*",
      styles: [],
    });
  });

  it("treats indented blockquotes as quoted lines", () => {
    expect(parseZalouserTextStyles("  > quoted")).toEqual({
      text: "quoted",
      styles: [{ start: 0, len: 6, st: TextStyle.Indent, indentSize: 1 }],
    });
  });

  it("treats spaced nested blockquotes as deeper quoted lines", () => {
    expect(parseZalouserTextStyles("> > quoted")).toEqual({
      text: "quoted",
      styles: [{ start: 0, len: 6, st: TextStyle.Indent, indentSize: 2 }],
    });
  });

  it("treats indented quoted fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("  > ```\n  > *cmd*\n  > ```")).toEqual({
      text: "*cmd*",
      styles: [],
    });
  });

  it("treats spaced nested quoted fences as literal code blocks", () => {
    expect(parseZalouserTextStyles("> > ```\n> > code\n> > ```")).toEqual({
      text: "code",
      styles: [],
    });
  });

  it("preserves inner quote markers inside quoted fenced code blocks", () => {
    expect(parseZalouserTextStyles("> ```\n>> prompt\n> ```")).toEqual({
      text: "> prompt",
      styles: [],
    });
  });

  it("keeps quote indentation on heading lines", () => {
    expect(parseZalouserTextStyles("> # Title")).toEqual({
      text: "Title",
      styles: [
        { start: 0, len: 5, st: TextStyle.Bold },
        { start: 0, len: 5, st: TextStyle.Big },
        { start: 0, len: 5, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
  });

  it("keeps unmatched fences literal", () => {
    expect(parseZalouserTextStyles("```python")).toEqual({
      text: "```python",
      styles: [],
    });
  });

  it("keeps unclosed fenced blocks literal until eof", () => {
    expect(parseZalouserTextStyles("```python\n\\*not italic*\n_next_")).toEqual({
      text: "```python\n\\*not italic*\n_next_",
      styles: [],
    });
  });

  it("supports nested markdown and tag styles regardless of order", () => {
    expect(
      parseZalouserTextStyles(
        '**{red}x{/red}** {red}**y**{/red} {underline}z{/underline} {red}*"q"*{/red}',
      ),
    ).toEqual({
      text: 'x y z "q"',
      styles: [
        { start: 0, len: 1, st: TextStyle.Bold },
        { start: 0, len: 1, st: TextStyle.Red },
        { start: 2, len: 1, st: TextStyle.Red },
        { start: 2, len: 1, st: TextStyle.Bold },
        { start: 4, len: 1, st: TextStyle.Underline },
        { start: 6, len: 3, st: TextStyle.Red },
        { start: 6, len: 3, st: TextStyle.Italic },
      ],
    });
  });

  it("treats small text tags as normal text", () => {
    expect(parseZalouserTextStyles("{small}tiny{/small}")).toEqual({
      text: "tiny",
      styles: [],
    });
  });

  it("keeps escaped markers literal", () => {
    expect(parseZalouserTextStyles("\\*literal\\* \\{underline}tag{/underline} \\`tick")).toEqual({
      text: "*literal* {underline}tag{/underline} `tick",
      styles: [],
    });
  });

  it("keeps indented code blocks literal", () => {
    expect(parseZalouserTextStyles("    *cmd*")).toEqual({
      text: "\u00A0\u00A0\u00A0\u00A0*cmd*",
      styles: [],
    });
  });
});
