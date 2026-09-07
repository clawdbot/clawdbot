import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";

const DUNDER_OPTIONS = {
  autolink: false,
  linkify: false,
  preserveDunderIdentifiers: true,
} as const;

describe("markdownToIR preserveDunderIdentifiers", () => {
  it("leaves CommonMark emphasis unchanged by default", () => {
    expect(markdownToIR("obj.__class__", { autolink: false, linkify: false })).toEqual({
      text: "obj.class",
      styles: [{ start: 4, end: 9, style: "bold" }],
      links: [],
    });
  });

  it("keeps ordinary parenthesized bold unchanged when enabled", () => {
    expect(markdownToIR("(__warning__)", DUNDER_OPTIONS)).toEqual({
      text: "(warning)",
      styles: [{ start: 1, end: 8, style: "bold" }],
      links: [],
    });
  });

  it.each([
    ["member access", "obj.__class__"],
    ["call", "__init__()"],
    ["function argument", "print(__name__)"],
    ["index", '__dict__["key"]'],
  ])("preserves %s identifiers", (_name, source) => {
    expect(markdownToIR(source, DUNDER_OPTIONS)).toEqual({
      text: source,
      styles: [],
      links: [],
    });
  });

  it.each([
    {
      name: "full",
      source: "[Class][obj.__class__]\n\n[obj.__class__]: https://example.org/python",
      text: "Class",
      end: 5,
    },
    {
      name: "collapsed",
      source: "[obj.__class__][]\n\n[obj.__class__]: https://example.org/python",
      text: "obj.__class__",
      end: 13,
    },
    {
      name: "shortcut",
      source: "[obj.__class__]\n\n[obj.__class__]: https://example.org/python",
      text: "obj.__class__",
      end: 13,
    },
    {
      name: "case-normalized",
      source: "[Class][OBJ.__CLASS__]\n\n[obj.__class__]: https://example.org/python",
      text: "Class",
      end: 5,
    },
    {
      name: "whitespace-normalized",
      source: "[Class][obj. __class__]\n\n[obj.\t__class__]: https://example.org/python",
      text: "Class",
      end: 5,
    },
  ])("preserves $name reference links", ({ source, text, end }) => {
    expect(markdownToIR(source, DUNDER_OPTIONS)).toEqual({
      text,
      styles: [],
      links: [{ start: 0, end, href: "https://example.org/python" }],
    });
  });

  it("preserves repeated reference destinations", () => {
    const href = "https://docs.python.org/3/library/stdtypes.html#instance.__class__";
    expect(
      markdownToIR(`[Class][docs] and [Type][docs]\n\n[docs]: ${href}`, DUNDER_OPTIONS),
    ).toEqual({
      text: "Class and Type",
      styles: [],
      links: [
        { start: 0, end: 5, href },
        { start: 10, end: 14, href },
      ],
    });
  });

  it.each([
    {
      name: "inline",
      source: "`obj.__class__`",
      text: "obj.__class__",
      styles: [{ start: 0, end: 13, style: "code" }],
    },
    {
      name: "fenced",
      source: "```python\nobj.__class__\n```",
      text: "obj.__class__\n",
      styles: [{ start: 0, end: 14, style: "code_block", language: "python" }],
    },
    {
      name: "indented",
      source: "    obj.__class__",
      text: "obj.__class__\n",
      styles: [{ start: 0, end: 14, style: "code_block" }],
    },
  ])("leaves $name code handling unchanged", ({ source, text, styles }) => {
    expect(markdownToIR(source, DUNDER_OPTIONS)).toEqual({
      text,
      styles,
      links: [],
    });
  });
});
