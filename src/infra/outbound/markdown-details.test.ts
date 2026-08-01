import { describe, expect, it } from "vitest";
import { flattenMarkdownDetails } from "./markdown-details.js";

describe("flattenMarkdownDetails", () => {
  it("flattens details blocks into portable markdown", () => {
    expect(
      flattenMarkdownDetails(
        "<details open><summary>Why this works</summary>**Bold** body\n\n- one\n- two</details>",
      ),
    ).toBe("**Why this works**\n\n**Bold** body\n\n- one\n- two");
  });

  it("uses the default label when summary is missing or empty", () => {
    expect(flattenMarkdownDetails("<details>body</details>")).toBe("**Details**\n\nbody");
    expect(flattenMarkdownDetails("<details><summary> </summary>body</details>")).toBe(
      "**Details**\n\nbody",
    );
  });

  it("flattens nested details recursively", () => {
    expect(
      flattenMarkdownDetails(
        "<details><summary>Outer</summary>before\n\n<details><summary>Inner</summary>deep</details>\n\nafter</details>",
      ),
    ).toBe("**Outer**\n\nbefore\n\n**Inner**\n\ndeep\n\nafter");
  });

  it("preserves indentation in the first body block", () => {
    expect(
      flattenMarkdownDetails("<details><summary>Example</summary>\n    const x = 1;\n</details>"),
    ).toBe("**Example**\n\n    const x = 1;");
  });

  it("preserves block boundaries around flattened details", () => {
    expect(flattenMarkdownDetails("before<details>inside</details>after")).toBe(
      "before\n\n**Details**\n\ninside\n\nafter",
    );
    expect(flattenMarkdownDetails("<details>inside</details>\nafter")).toBe(
      "**Details**\n\ninside\n\nafter",
    );
  });

  it("preserves list and blockquote containers around flattened details", () => {
    expect(flattenMarkdownDetails("- <details><summary>A</summary>body</details>")).toBe(
      "- **A**\n\n  body",
    );
    expect(flattenMarkdownDetails("> <details><summary>A</summary>body</details>")).toBe(
      "> **A**\n>\n> body",
    );
  });

  it("keeps a two-space-indented details block in its list item", () => {
    expect(flattenMarkdownDetails("  - <details><summary>A</summary>body</details>")).toBe(
      "  - **A**\n\n    body",
    );
    expect(flattenMarkdownDetails(">   - <details><summary>A</summary>body</details>")).toBe(
      ">   - **A**\n>\n>     body",
    );
  });

  it("does not duplicate multiline container prefixes", () => {
    expect(
      flattenMarkdownDetails("> <details>\n> <summary>A</summary>\n>\n> body\n> </details>"),
    ).toBe("> **A**\n>\n> body");
    expect(
      flattenMarkdownDetails("10. <details>\n    <summary>A</summary>\n\n    body\n    </details>"),
    ).toBe("10. **A**\n\n    body");
  });

  it("bounds rendering of deeply nested details", () => {
    let markdown = "deep body";
    for (let index = 0; index < 128; index += 1) {
      markdown = `<details><summary>Level ${index}</summary>${markdown}</details>`;
    }

    const flattened = flattenMarkdownDetails(markdown);

    expect(flattened).toContain("deep body");
    expect(flattened).not.toContain("<details>");
  });

  it("flattens unterminated details without leaking structural tags", () => {
    expect(flattenMarkdownDetails("<details><summary>More</summary>partial")).toBe(
      "**More**\n\npartial",
    );
  });

  it("closes an unterminated summary with its containing details", () => {
    expect(flattenMarkdownDetails("<details><summary>More</details>after")).toBe(
      "**More**\n\nafter",
    );
  });

  it("leaves literal details examples inside code unchanged", () => {
    const markdown = [
      "`<details>inline</details>`",
      "",
      "```html",
      "<details>block</details>",
      "```",
      "",
      "    <details>indented</details>",
      "",
      "- item",
      "",
      "      <details>list-indented</details>",
    ].join("\n");
    expect(flattenMarkdownDetails(markdown)).toBe(markdown);
  });

  it("does not flatten custom elements with details-like names", () => {
    const markdown = "<details-widget>body</details-widget>";
    expect(flattenMarkdownDetails(markdown)).toBe(markdown);
  });

  it("leaves backslash-escaped disclosure tags unchanged", () => {
    const markdown = "\\<details>literal\\</details>";
    expect(flattenMarkdownDetails(markdown)).toBe(markdown);
  });
});
