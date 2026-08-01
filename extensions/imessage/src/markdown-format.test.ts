// Imessage tests cover markdown format plugin behavior.
import { describe, expect, it } from "vitest";
import { extractMarkdownFormatRuns } from "./markdown-format.js";

const MIGRATION_GOLDENS = [
  {
    name: "CommonMark alternate bold replaces the legacy underline dialect",
    input: "__x__",
    before: { text: "x", ranges: [{ start: 0, length: 1, styles: ["underline"] }] },
    after: { text: "x", ranges: [{ start: 0, length: 1, styles: ["bold"] }] },
  },
  {
    name: "authored HTML u is the underline source",
    input: "<u>x</u>",
    before: { text: "<u>x</u>", ranges: [] },
    after: { text: "x", ranges: [{ start: 0, length: 1, styles: ["underline"] }] },
  },
  {
    name: "authored HTML ins is the underline source",
    input: "<ins>x</ins>",
    before: { text: "<ins>x</ins>", ranges: [] },
    after: { text: "x", ranges: [{ start: 0, length: 1, styles: ["underline"] }] },
  },
  {
    name: "inline code protects markdown-looking content and keeps its backticks",
    input: "`*x*`",
    before: { text: "`x`", ranges: [{ start: 1, length: 1, styles: ["italic"] }] },
    after: { text: "`*x*`", ranges: [] },
  },
  {
    name: "intraword underscore stays literal",
    input: "snake_case",
    before: { text: "snake_case", ranges: [] },
    after: { text: "snake_case", ranges: [] },
  },
  {
    name: "Python dunder identifier stays literal",
    input: "def __init__(self):",
    before: { text: "def __init__(self):", ranges: [] },
    after: { text: "def __init__(self):", ranges: [] },
  },
] as const;

describe("extractMarkdownFormatRuns", () => {
  it.each(MIGRATION_GOLDENS)("$name: $before -> $after", ({ input, after }) => {
    expect(extractMarkdownFormatRuns(input)).toEqual(after);
  });

  it("returns plain text unchanged", () => {
    expect(extractMarkdownFormatRuns("plain text reply")).toEqual({
      text: "plain text reply",
      ranges: [],
    });
  });

  it("renders mixed, nested, and repeated native styles in UTF-16 coordinates", () => {
    expect(extractMarkdownFormatRuns("😀 **bold _and italic_** ~~gone~~")).toEqual({
      text: "😀 bold and italic gone",
      ranges: [
        { start: 3, length: 15, styles: ["bold"] },
        { start: 8, length: 10, styles: ["italic"] },
        { start: 19, length: 4, styles: ["strikethrough"] },
      ],
    });
  });

  it("keeps literal markers that CommonMark does not treat as emphasis", () => {
    expect(extractMarkdownFormatRuns("price * quantity and **  **")).toEqual({
      text: "price * quantity and **  **",
      ranges: [],
    });
  });

  it("preserves CommonMark flanking around protected inline code", () => {
    expect(extractMarkdownFormatRuns("`code`_italic_ __Important__ (read this)")).toEqual({
      text: "`code`italic Important (read this)",
      ranges: [
        { start: 6, length: 6, styles: ["italic"] },
        { start: 13, length: 9, styles: ["bold"] },
      ],
    });
  });

  it("restores inline code containing bare carriage returns without leaking masks", () => {
    expect(extractMarkdownFormatRuns("`*x*\rmore`")).toEqual({
      text: "`*x* more`",
      ranges: [],
    });
  });

  it("preserves multi-backtick inline code delimiters and contents", () => {
    expect(extractMarkdownFormatRuns("Use ``a`*b*`` here")).toEqual({
      text: "Use ``a`*b*`` here",
      ranges: [],
    });
  });

  it("separates code content that touches a backtick delimiter", () => {
    expect(extractMarkdownFormatRuns("`` ` ``")).toEqual({
      text: "`` ` ``",
      ranges: [],
    });
  });

  it("does not cross-protect backticks inside indented code blocks", () => {
    expect(extractMarkdownFormatRuns("    `abc`")).toEqual({
      text: "`abc`\n",
      ranges: [],
    });
  });

  it("does not escape dunders inside fenced code blocks", () => {
    expect(extractMarkdownFormatRuns("```python\nobj.__class__\n```")).toEqual({
      text: "obj.__class__\n",
      ranges: [],
    });
  });

  it("keeps Python dunder method declarations literal", () => {
    expect(extractMarkdownFormatRuns("def __str__(self):")).toEqual({
      text: "def __str__(self):",
      ranges: [],
    });
  });

  it("keeps standalone lowercase dunder calls literal", () => {
    expect(extractMarkdownFormatRuns("Call __init__() and __str__(obj)")).toEqual({
      text: "Call __init__() and __str__(obj)",
      ranges: [],
    });
  });

  it("keeps qualified and indexed dunder identifiers literal", () => {
    expect(extractMarkdownFormatRuns("obj.__class__ print(__name__) __dict__['key']")).toEqual({
      text: "obj.__class__ print(__name__) __dict__['key']",
      ranges: [],
    });
  });

  it("does not confuse ordinary parenthesized CommonMark bold with an identifier", () => {
    expect(extractMarkdownFormatRuns("(__warning__)")).toEqual({
      text: "(warning)",
      ranges: [{ start: 1, length: 7, styles: ["bold"] }],
    });
  });

  it("does not confuse an earlier matching bold span with a protected dunder", () => {
    expect(extractMarkdownFormatRuns("**init**() then __init__()")).toEqual({
      text: "init() then __init__()",
      ranges: [{ start: 0, length: 4, styles: ["bold"] }],
    });
  });

  it("searches past unrelated declarations for the matching dunder range", () => {
    expect(extractMarkdownFormatRuns("def init():\ndef __init__(self):")).toEqual({
      text: "def init():\ndef __init__(self):",
      ranges: [],
    });
  });
});
