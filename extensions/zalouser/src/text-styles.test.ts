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

  it("preserves leading blank lines and shifts ranges", () => {
    expect(parseZalouserTextStyles("\n**x**")).toEqual({
      text: "\nx",
      styles: [{ start: 1, len: 1, st: TextStyle.Bold }],
    });
    expect(parseZalouserTextStyles("x\n  \n")).toEqual({ text: "x\n\n", styles: [] });
    expect(parseZalouserTextStyles("x\n  ")).toEqual({ text: "x\n", styles: [] });
    expect(parseZalouserTextStyles(">\n**x**")).toEqual({
      text: "\nx",
      styles: [{ start: 1, len: 1, st: TextStyle.Bold }],
    });
    expect(parseZalouserTextStyles(">   \n**x**")).toEqual({
      text: "\nx",
      styles: [{ start: 1, len: 1, st: TextStyle.Bold }],
    });
  });

  it.each([
    {
      name: "resolves ambiguous triple-marker nesting with CommonMark precedence",
      input: "***foo** bar*",
      expected: {
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
      expected: { text: "привет_мир_снова", styles: [] },
    },
  ])("$name", ({ input, expected }) => {
    expect(parseZalouserTextStyles(input)).toEqual(expected);
  });

  it("keeps inline code and plain math markers literal", () => {
    expect(parseZalouserTextStyles("before `inline *code*` after\n2 * 3 * 4")).toEqual({
      text: "before `inline *code*` after\n2 * 3 * 4",
      styles: [],
    });
    expect(parseZalouserTextStyles("`*x`")).toEqual({ text: "`*x`", styles: [] });
    expect(parseZalouserTextStyles("***bold**")).toEqual({
      text: "*bold",
      styles: [{ start: 1, len: 4, st: TextStyle.Bold }],
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
    expect(parseZalouserTextStyles("__foo_bar__")).toEqual({
      text: "foo_bar",
      styles: [{ start: 0, len: 7, st: TextStyle.Bold }],
    });
    expect(parseZalouserTextStyles("_x_*")).toEqual({
      text: "x*",
      styles: [{ start: 0, len: 1, st: TextStyle.Italic }],
    });
    expect(parseZalouserTextStyles("*a**b*")).toEqual({
      text: "a**b",
      styles: [{ start: 0, len: 4, st: TextStyle.Italic }],
    });
    expect(parseZalouserTextStyles("*a***b")).toEqual({
      text: "a**b",
      styles: [{ start: 0, len: 1, st: TextStyle.Italic }],
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
    expect(parseZalouserTextStyles("*foo\nbar*")).toEqual({
      text: "*foo\nbar*",
      styles: [],
    });
    expect(parseZalouserTextStyles("*a* *foo\nbar* *b*")).toEqual({
      text: "a *foo\nbar* b",
      styles: [
        { start: 0, len: 1, st: TextStyle.Italic },
        { start: 12, len: 1, st: TextStyle.Italic },
      ],
    });
    expect(parseZalouserTextStyles("* item")).toEqual({
      text: "item",
      styles: [{ start: 0, len: 4, st: TextStyle.UnorderedList }],
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
});
