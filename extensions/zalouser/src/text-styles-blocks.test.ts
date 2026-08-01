import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle } from "./zca-constants.js";

describe("parseZalouserTextStyles blocks", () => {
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
    expect(parseZalouserTextStyles("#   title")).toEqual({
      text: "  title",
      styles: [
        { start: 0, len: 7, st: TextStyle.Bold },
        { start: 0, len: 7, st: TextStyle.Big },
      ],
    });
    expect(parseZalouserTextStyles(">   quoted")).toEqual({
      text: "  quoted",
      styles: [{ start: 0, len: 8, st: TextStyle.Indent, indentSize: 1 }],
    });
  });

  it("preserves optional closing ATX hashes as heading text", () => {
    expect(parseZalouserTextStyles("# title #")).toEqual({
      text: "title #",
      styles: [
        { start: 0, len: 7, st: TextStyle.Bold },
        { start: 0, len: 7, st: TextStyle.Big },
      ],
    });
    expect(parseZalouserTextStyles("# ![](/img)")).toEqual({
      text: "![](/img)",
      styles: [
        { start: 0, len: 9, st: TextStyle.Bold },
        { start: 0, len: 9, st: TextStyle.Big },
      ],
    });
    expect(parseZalouserTextStyles("![](/img)\n---")).toEqual({
      text: "![](/img)\n---",
      styles: [],
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
    expect(parseZalouserTextStyles("paragraph\n  2. item")).toEqual({
      text: "paragraph\n  2. item",
      styles: [],
    });
  });

  it.each([
    {
      name: "four-column bullet child becomes a nested native list",
      input: "- parent\n    - child",
      before: {
        text: `parent\n${"\u00A0".repeat(4)}- child`,
        styles: [{ start: 0, len: 6, st: TextStyle.UnorderedList }],
      },
      after: {
        text: "parent\nchild",
        styles: [
          { start: 0, len: 6, st: TextStyle.UnorderedList },
          { start: 7, len: 5, st: TextStyle.Indent, indentSize: 1 },
          { start: 7, len: 5, st: TextStyle.UnorderedList },
        ],
      },
    },
    {
      name: "ordered child gains parser-owned nesting",
      input: "1. parent\n   1. child",
      before: {
        text: "parent\nchild",
        styles: [
          { start: 0, len: 6, st: TextStyle.OrderedList },
          { start: 7, len: 5, st: TextStyle.OrderedList },
        ],
      },
      after: {
        text: "parent\nchild",
        styles: [
          { start: 0, len: 6, st: TextStyle.OrderedList },
          { start: 7, len: 5, st: TextStyle.Indent, indentSize: 1 },
          { start: 7, len: 5, st: TextStyle.OrderedList },
        ],
      },
    },
    {
      name: "wide ordered parent owns its bullet child",
      input: "10. parent\n    - child",
      before: {
        text: `parent\n${"\u00A0".repeat(4)}- child`,
        styles: [{ start: 0, len: 6, st: TextStyle.OrderedList }],
      },
      after: {
        text: "parent\nchild",
        styles: [
          { start: 0, len: 6, st: TextStyle.OrderedList },
          { start: 7, len: 5, st: TextStyle.Indent, indentSize: 1 },
          { start: 7, len: 5, st: TextStyle.UnorderedList },
        ],
      },
    },
    {
      name: "lazy continuation remains owned by one native item",
      input: "- parent\n  continuation",
      before: {
        text: "parent\n  continuation",
        styles: [{ start: 0, len: 6, st: TextStyle.UnorderedList }],
      },
      after: {
        text: "parent\ncontinuation",
        styles: [{ start: 0, len: 19, st: TextStyle.UnorderedList }],
      },
    },
    {
      name: "loose continuation remains inside its native item",
      input: "- first\n\n  continuation\n- next",
      before: {
        text: "first\n\n  continuation\nnext",
        styles: [
          { start: 0, len: 5, st: TextStyle.UnorderedList },
          { start: 22, len: 4, st: TextStyle.UnorderedList },
        ],
      },
      after: {
        text: "first\n\ncontinuation\nnext",
        styles: [
          { start: 0, len: 19, st: TextStyle.UnorderedList },
          { start: 20, len: 4, st: TextStyle.UnorderedList },
        ],
      },
    },
    {
      name: "nested task child keeps checkbox fallback without a native bullet",
      input: "- parent\n  - [ ] child",
      before: {
        text: "parent\n- [ ] child",
        styles: [{ start: 0, len: 6, st: TextStyle.UnorderedList }],
      },
      after: {
        text: "parent\n[ ] child",
        styles: [
          { start: 0, len: 6, st: TextStyle.UnorderedList },
          { start: 7, len: 9, st: TextStyle.Indent, indentSize: 1 },
        ],
      },
    },
  ])("documents CommonMark list before and after: $name", ({ input, before, after }) => {
    expect(before).not.toEqual(after);
    expect(parseZalouserTextStyles(input)).toEqual(after);
  });

  it("keeps a top-level four-space list-looking line as indented code", () => {
    const unchanged = { text: `${"\u00A0".repeat(4)}- item`, styles: [] };
    expect(parseZalouserTextStyles("    - item")).toEqual(unchanged);
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
    expect(parseZalouserTextStyles(">  > nested")).toEqual({
      text: "nested",
      styles: [{ start: 0, len: 6, st: TextStyle.Indent, indentSize: 2 }],
    });
  });

  it("keeps blockquote padding structural before headings", () => {
    expect(parseZalouserTextStyles(">   # Title")).toEqual({
      text: "Title",
      styles: [
        { start: 0, len: 5, st: TextStyle.Bold },
        { start: 0, len: 5, st: TextStyle.Big },
        { start: 0, len: 5, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
  });

  it("keeps container-only nested blockquotes empty", () => {
    expect(parseZalouserTextStyles("> >")).toEqual({ text: "", styles: [] });
    expect(parseZalouserTextStyles("- >")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("> -")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("> first\n>").text).toBe("first\n");
    expect(parseZalouserTextStyles("> first\n>\n").text).toBe("first\n\n");
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

  it.each([
    ["empty fence", "```", "```"],
    ["over-indented would-be closer", "```\n    ```", `\`\`\`\n${"\u00A0".repeat(4)}\`\`\``],
    ["indented fence", "  ```\n  code", "  ```\ncode"],
  ])("keeps %s literal when CommonMark leaves the fence open", (_name, input, text) => {
    expect(parseZalouserTextStyles(input)).toEqual({ text, styles: [] });
  });

  it("keeps closed-fence whitespace-only payload lines byte-for-byte", () => {
    expect(parseZalouserTextStyles("```\n   \n```")).toEqual({
      text: "\u00A0\u00A0\u00A0",
      styles: [],
    });
    expect(parseZalouserTextStyles("```\ncode\n\n```")).toEqual({
      text: "code\n",
      styles: [],
    });
    expect(parseZalouserTextStyles("```\ncode\n\n```\n**next**")).toEqual({
      text: "code\n\nnext",
      styles: [{ start: 6, len: 4, st: TextStyle.Bold }],
    });
    expect(parseZalouserTextStyles("- ```\n  ```")).toEqual({ text: "", styles: [] });
    expect(parseZalouserTextStyles("> ```\n> ```")).toEqual({ text: "", styles: [] });
    expect(parseZalouserTextStyles("- ```\n    \n  ```").text).not.toContain("```");
  });

  it("keeps unclosed fenced text inside its parser-owned containers", () => {
    expect(parseZalouserTextStyles("- ```\n  code")).toEqual({
      text: "```\ncode",
      styles: [{ start: 0, len: 8, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("> ```\n> code")).toEqual({
      text: "```\ncode",
      styles: [
        { start: 0, len: 3, st: TextStyle.Indent, indentSize: 1 },
        { start: 4, len: 4, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
    expect(parseZalouserTextStyles("```\n> literal")).toEqual({
      text: "```\n> literal",
      styles: [],
    });
    expect(parseZalouserTextStyles("-\t```\n    code")).toEqual({
      text: "```\ncode",
      styles: [{ start: 0, len: 8, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("- ```\n  - literal").text).toBe("```\n- literal");
    expect(parseZalouserTextStyles("   - ```\n     code").text).toBe("```\ncode");
    expect(parseZalouserTextStyles(">   ```\n>   code").text).toBe("  ```\ncode");
    expect(parseZalouserTextStyles(">\t```\n>\tcode").text).toBe("  ```\ncode");
    expect(parseZalouserTextStyles("- ```")).toEqual({
      text: "```",
      styles: [{ start: 0, len: 3, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("```\n")).toEqual({ text: "```\n", styles: [] });
    expect(parseZalouserTextStyles("> ```")).toEqual({
      text: "```",
      styles: [{ start: 0, len: 3, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("- parent\n  - ```")).toEqual({
      text: "parent\n```",
      styles: [
        { start: 0, len: 6, st: TextStyle.UnorderedList },
        { start: 7, len: 3, st: TextStyle.Indent, indentSize: 1 },
        { start: 7, len: 3, st: TextStyle.UnorderedList },
      ],
    });
    expect(parseZalouserTextStyles("> ```\n>    ")).toEqual({
      text: `\`\`\`\n${"\u00A0".repeat(3)}`,
      styles: [
        { start: 0, len: 3, st: TextStyle.Indent, indentSize: 1 },
        { start: 4, len: 3, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
    expect(parseZalouserTextStyles("> ```\n> a\n> b")).toEqual({
      text: "```\na\nb",
      styles: [
        { start: 0, len: 3, st: TextStyle.Indent, indentSize: 1 },
        { start: 4, len: 1, st: TextStyle.Indent, indentSize: 1 },
        { start: 6, len: 1, st: TextStyle.Indent, indentSize: 1 },
      ],
    });
    const nestedNbsp = parseZalouserTextStyles("- parent\n  - ```\n    \u00A0");
    expect(
      nestedNbsp.styles
        .filter((style) => style.st === TextStyle.Indent)
        .map((style) => style.indentSize),
    ).toEqual([1, 1]);
  });
});
