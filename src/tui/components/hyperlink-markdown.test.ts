import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { markdownTheme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

describe("HyperlinkMarkdown", () => {
  it("moves dunder identifiers intact across fenced code wrap boundaries", () => {
    const markdown = new HyperlinkMarkdown(
      ["```python", 'if __name__ == "__main__":', "```"].join("\n"),
      0,
      0,
      markdownTheme,
    );

    const rendered = markdown.render(12);
    const normalized = rendered.map((line) => normalizeTestText(line));

    expect(rendered.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(normalized.some((line) => line.includes("__name__ =="))).toBe(true);
    expect(normalized.some((line) => line.includes('"__main__":'))).toBe(true);
  });

  it("preserves underscores in fenced and inline code", () => {
    const markdown = new HyperlinkMarkdown(
      ["```python", "is_palindrome", "```", "", "Call `__init__`."].join("\n"),
      0,
      0,
      markdownTheme,
    );

    const normalized = markdown.render(16).map((line) => normalizeTestText(line));

    expect(normalized.some((line) => line.includes("is_palindrome"))).toBe(true);
    expect(normalized.some((line) => line.includes("__init__"))).toBe(true);
  });

  it("links the complete parenthetical URL rendered by pi-tui", () => {
    const url = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
    const markdown = new HyperlinkMarkdown(`[Wikipedia](${url})`, 0, 0, markdownTheme);

    const rendered = markdown.render(120).join("\n");

    expect(rendered).toContain(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
  });
});
