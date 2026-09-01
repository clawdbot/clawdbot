import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle } from "./zca-constants.js";

describe("parseZalouserTextStyles containers", () => {
  it("keeps marker-only list padding structural", () => {
    expect(parseZalouserTextStyles("- \n  child")).toEqual({
      text: "child",
      styles: [{ start: 0, len: 5, st: TextStyle.UnorderedList }],
    });
  });

  it("keeps parent list ownership after a nested child", () => {
    expect(parseZalouserTextStyles("- parent\n  - child\n\n  continuation")).toEqual({
      text: "parent\nchild\ncontinuation",
      styles: [
        { start: 0, len: 6, st: TextStyle.UnorderedList },
        { start: 7, len: 5, st: TextStyle.Indent, indentSize: 1 },
        { start: 7, len: 5, st: TextStyle.UnorderedList },
        { start: 13, len: 12, st: TextStyle.UnorderedList },
      ],
    });
  });

  it("keeps same-line nested task fallback semantics", () => {
    expect(parseZalouserTextStyles("- - [ ] child")).toEqual({
      text: "[ ] child",
      styles: [{ start: 0, len: 9, st: TextStyle.Indent, indentSize: 1 }],
    });
  });

  it("keeps non-task checkbox links literal on task lines", () => {
    expect(parseZalouserTextStyles("- [ ] see [x](https://example.com)")).toEqual({
      text: "[ ] see [x](https://example.com)",
      styles: [],
    });
  });

  it("keeps task fallback when the checkbox starts on a continuation line", () => {
    expect(parseZalouserTextStyles("-\n  [ ] child")).toEqual({
      text: "[ ] child",
      styles: [],
    });
  });

  it("combines list and blockquote indentation per owned line", () => {
    expect(parseZalouserTextStyles("- parent\n  > quoted")).toEqual({
      text: "parent\nquoted",
      styles: [
        { start: 0, len: 13, st: TextStyle.UnorderedList },
        { start: 7, len: 6, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
  });

  it("preserves container-only quote blank lines", () => {
    expect(parseZalouserTextStyles("> first\n>\n> # second")).toEqual({
      text: "first\n\nsecond",
      styles: [
        { start: 0, len: 5, st: TextStyle.Indent, indentSize: 1 },
        { start: 7, len: 6, st: TextStyle.Bold },
        { start: 7, len: 6, st: TextStyle.Big },
        { start: 7, len: 6, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
  });

  it("preserves blank lines between loose sibling items", () => {
    expect(parseZalouserTextStyles("- first\n\n- second")).toEqual({
      text: "first\n\nsecond",
      styles: [
        { start: 0, len: 5, st: TextStyle.UnorderedList },
        { start: 7, len: 6, st: TextStyle.UnorderedList },
      ],
    });
  });

  it("consumes combined quote and list prefixes for unclosed fences", () => {
    expect(parseZalouserTextStyles("> - ```\n>   code")).toEqual({
      text: "```\ncode",
      styles: [
        { start: 0, len: 3, st: TextStyle.Indent, indentSize: 1 },
        { start: 0, len: 8, st: TextStyle.UnorderedList },
        { start: 4, len: 4, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
    expect(parseZalouserTextStyles("- > ```\n  > code")).toEqual({
      text: "```\ncode",
      styles: [
        { start: 0, len: 3, st: TextStyle.Indent, indentSize: 1 },
        { start: 0, len: 8, st: TextStyle.UnorderedList },
        { start: 4, len: 4, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
  });

  it("closes fences through alternating list and quote containers", () => {
    expect(parseZalouserTextStyles("> - > 10. ```\n>   >     code\n>   >     ```").text).toBe(
      "code",
    );
    expect(parseZalouserTextStyles("> - > 10. ```\n>   >     code").text).toBe("```\ncode");
  });

  it("closes a fenced block after tabbed blockquote prefixes", () => {
    expect(parseZalouserTextStyles(">\t```\n>\tcode\n>\t```").text).toBe("code");
  });

  it.each([
    ["deep ATX heading", "- ##### literal", "##### literal", TextStyle.UnorderedList],
    ["thematic break", "- ***", "***", TextStyle.UnorderedList],
  ])("keeps unsupported %s markers literal inside a list", (_name, input, text, style) => {
    expect(parseZalouserTextStyles(input)).toEqual({
      text,
      styles: [{ start: 0, len: text.length, st: style }],
    });
  });

  it("keeps unsupported top-level blocks outside the preceding list", () => {
    expect(parseZalouserTextStyles("- item\n##### heading")).toEqual({
      text: "item\n##### heading",
      styles: [{ start: 0, len: 4, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("- - -\nnext").text).toBe("- - -\nnext");
    expect(parseZalouserTextStyles("- item\n***")).toEqual({
      text: "item\n***",
      styles: [{ start: 0, len: 4, st: TextStyle.UnorderedList }],
    });
  });

  it("keeps reconstructed heading markers inside their containers", () => {
    expect(parseZalouserTextStyles("> ##### literal")).toEqual({
      text: "##### literal",
      styles: [{ start: 0, len: 13, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("- title\n  ---")).toEqual({
      text: "title\n---",
      styles: [{ start: 0, len: 9, st: TextStyle.UnorderedList }],
    });
  });

  it("keeps empty unsupported headings literal", () => {
    expect(parseZalouserTextStyles("#####")).toEqual({ text: "#####", styles: [] });
    expect(parseZalouserTextStyles("- #####")).toEqual({
      text: "#####",
      styles: [{ start: 0, len: 5, st: TextStyle.UnorderedList }],
    });
  });

  it.each(["#", "##", "###", "####"])("keeps marker-only heading %s representable", (input) => {
    expect(parseZalouserTextStyles(input)).toEqual({ text: input, styles: [] });
  });

  it("preserves padding on marker-only literal headings", () => {
    expect(parseZalouserTextStyles("  #")).toEqual({ text: "  #", styles: [] });
    expect(parseZalouserTextStyles("  #####")).toEqual({ text: "  #####", styles: [] });
    expect(parseZalouserTextStyles("# ###")).toEqual({
      text: "###",
      styles: [
        { start: 0, len: 3, st: TextStyle.Bold },
        { start: 0, len: 3, st: TextStyle.Big },
      ],
    });
    expect(parseZalouserTextStyles("##### #####")).toEqual({
      text: "##### #####",
      styles: [],
    });
    expect(parseZalouserTextStyles("##### ![](/img)")).toEqual({
      text: "##### ![](/img)",
      styles: [],
    });
    expect(parseZalouserTextStyles("  ***\u00A0")).toEqual({ text: "  ***", styles: [] });
  });

  it("keeps a marker-only heading representable inside a list", () => {
    expect(parseZalouserTextStyles("- #")).toEqual({
      text: "#",
      styles: [{ start: 0, len: 1, st: TextStyle.UnorderedList }],
    });
  });

  it.each(["-", "1."])("keeps marker-only item %s representable", (input) => {
    expect(parseZalouserTextStyles(input)).toEqual({ text: input, styles: [] });
  });

  it("keeps parser-owned indentation on marker-only nested items", () => {
    expect(parseZalouserTextStyles("- -")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("> - -")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("- > -")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 2 }],
    });
    expect(
      parseZalouserTextStyles("-\n  -\n    -\n      -\n        -\n          -\n            -"),
    ).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 5 }],
    });
  });

  it("consumes implicit marker-only padding before nested literal headings", () => {
    expect(parseZalouserTextStyles("-\n  ##### literal").text).toBe("##### literal");
  });

  it("retains virtual tab columns beyond list indentation", () => {
    expect(parseZalouserTextStyles("- parent\n\t##### literal").text).toBe(
      "parent\n  ##### literal",
    );
    expect(parseZalouserTextStyles("10. >\t##### literal").text).toBe("  ##### literal");
    expect(parseZalouserTextStyles(">\t- ##### literal").text).toBe("##### literal");
    expect(parseZalouserTextStyles(">\t>\t##### literal").text).toBe("  ##### literal");
    expect(parseZalouserTextStyles("- parent\n\t> ##### literal").text).toBe(
      "parent\n##### literal",
    );
    expect(parseZalouserTextStyles("> 1.\tparent\n>       ##### literal").text).toBe(
      "parent\n##### literal",
    );
    expect(parseZalouserTextStyles("-\t  code\n\n    ##### literal").text).toContain(
      "  ##### literal",
    );
  });

  it("keeps Unicode separators inside native list content", () => {
    expect(parseZalouserTextStyles("- \u00A0item")).toEqual({
      text: "\u00A0item",
      styles: [{ start: 0, len: 5, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("- \u00A0")).toEqual({
      text: "\u00A0",
      styles: [{ start: 0, len: 1, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("-\n  \u00A0")).toEqual({
      text: "\u00A0",
      styles: [{ start: 0, len: 1, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("- parent\n  - \u00A0")).toEqual({
      text: "parent\n\u00A0",
      styles: [
        { start: 0, len: 6, st: TextStyle.UnorderedList },
        { start: 7, len: 1, st: TextStyle.Indent, indentSize: 1 },
        { start: 7, len: 1, st: TextStyle.UnorderedList },
      ],
    });
    expect(parseZalouserTextStyles("> \u00A0")).toEqual({
      text: "\u00A0",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
  });

  it("keeps inline styles outside reconstructed heading markers", () => {
    expect(parseZalouserTextStyles("- ##### *x*")).toEqual({
      text: "##### x",
      styles: [
        { start: 0, len: 7, st: TextStyle.UnorderedList },
        { start: 6, len: 1, st: TextStyle.Italic },
      ],
    });
  });

  it("keeps raw-source marker offsets separate from protected rendering offsets", () => {
    expect(parseZalouserTextStyles("before `x`\n-")).toEqual({
      text: "before `x`\n-",
      styles: [],
    });
  });

  it("does not insert spacing before a same-line nested item", () => {
    expect(parseZalouserTextStyles("prefix\n- - child")).toEqual({
      text: "prefix\nchild",
      styles: [
        { start: 7, len: 5, st: TextStyle.Indent, indentSize: 1 },
        { start: 7, len: 5, st: TextStyle.UnorderedList },
      ],
    });
  });

  it("keeps leading padding on literal unsupported block markers", () => {
    expect(parseZalouserTextStyles("  ##### literal")).toEqual({
      text: "  ##### literal",
      styles: [],
    });
    expect(parseZalouserTextStyles("  ***")).toEqual({ text: "  ***", styles: [] });
  });

  it("keeps setext markers literal inside a blockquote", () => {
    expect(parseZalouserTextStyles("> title\n> ---")).toEqual({
      text: "title\n---",
      styles: [
        { start: 0, len: 5, st: TextStyle.Indent, indentSize: 1 },
        { start: 6, len: 3, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
  });

  it("keeps quote indentation on indented code blocks", () => {
    expect(parseZalouserTextStyles(">     code")).toEqual({
      text: `${"\u00A0".repeat(4)}code`,
      styles: [{ start: 0, len: 8, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles(">     a\n>     b")).toEqual({
      text: `${"\u00A0".repeat(4)}a\n${"\u00A0".repeat(4)}b`,
      styles: [
        { start: 0, len: 5, st: TextStyle.Indent, indentSize: 1 },
        { start: 6, len: 5, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
  });

  it("keeps whitespace-only lines inside indented code blocks", () => {
    expect(parseZalouserTextStyles("    a\n      \n    b")).toEqual({
      text: `${"\u00A0".repeat(4)}a\n${"\u00A0".repeat(6)}\n${"\u00A0".repeat(4)}b`,
      styles: [],
    });
    const nestedCode = parseZalouserTextStyles("- parent\n  - child\n\n        code");
    expect(
      nestedCode.styles
        .filter((style) => style.st === TextStyle.Indent)
        .every((style) => style.indentSize === 1),
    ).toBe(true);
    const nestedNbspCode = parseZalouserTextStyles("- parent\n  - child\n\n        \u00A0");
    expect(
      nestedNbspCode.styles
        .filter((style) => style.st === TextStyle.Indent)
        .every((style) => style.indentSize === 1),
    ).toBe(true);
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
