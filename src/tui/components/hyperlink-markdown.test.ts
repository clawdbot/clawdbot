import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { splitAnsiSegments } from "../../../packages/terminal-core/src/ansi-sequences.js";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { markdownTheme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

function osc8Targets(raw: string) {
  return splitAnsiSegments(raw).flatMap((segment) => {
    if (segment.kind !== "ansi" || !segment.value.startsWith("\x1b]8;;")) {
      return [];
    }
    const terminatorLength = segment.value.endsWith("\x1b\\") ? 2 : 1;
    const target = segment.value.slice("\x1b]8;;".length, -terminatorLength);
    return target ? [target] : [];
  });
}

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

    expect(rendered).toContain(`\x1b]8;;${url}`);
    expect(normalizeTestText(rendered)).toContain("Wikipedia");
  });

  it("sanitizes constructor and updated markdown before rendering", () => {
    const attack = "\x1b]52;c;Y2xpcGJvYXJk\x07";
    const markdown = new HyperlinkMarkdown(`before${attack}after`, 0, 0, markdownTheme);

    expect(markdown.render(80).join("\n")).toContain("beforeafter");
    expect(markdown.render(80).join("\n")).not.toContain(attack);

    markdown.setText(`next\u009b31munsafe\u009b0m`);
    const updated = markdown.render(80).join("\n");
    expect(updated).toContain("nextunsafe");
    expect(updated).not.toContain("\u009b");
  });

  it("parses sanitized RTL headings quotes and lists identically on construct and update", () => {
    const source = "\u202e# مرحبا\u202c\n\n\u200f> שלום\n\n\u2066- عنصر\u2069";
    const constructed = new HyperlinkMarkdown(source, 0, 0, markdownTheme);
    const updated = new HyperlinkMarkdown("", 0, 0, markdownTheme);

    updated.setText(source);
    const rendered = constructed.render(80);
    expect(updated.render(80)).toEqual(rendered);

    const normalized = rendered
      .map((line) => normalizeTestText(line).replace(/[\u2067\u2069]/gu, ""))
      .join("\n");
    expect(normalized).toContain("مرحبا");
    expect(normalized).not.toContain("# مرحبا");
    expect(normalized).toContain("│ שלום");
    expect(normalized).toContain("- عنصر");
    expect(rendered.join("\n")).not.toMatch(/[\u200f\u202e\u2066]/u);
  });

  it("renders a neutral fallback when nonempty markdown sanitizes to empty", () => {
    const markdown = new HyperlinkMarkdown("\x1b]0;title\x07", 0, 0, markdownTheme);

    expect(markdown.render(80).map(normalizeTestText).join("\n")).toContain("(no output)");

    markdown.setText("");
    expect(markdown.render(80).map(normalizeTestText).join("\n")).not.toContain("(no output)");
  });

  it("extracts copy-safe URLs from the sanitized display copy", () => {
    const url = "https://example.test/path?mode=copy-safe#proof";
    const markdown = new HyperlinkMarkdown("", 0, 0, markdownTheme);

    markdown.setText(`visit ${url}\x1b]52;c;Y2xpcGJvYXJk\x07`);
    const rendered = markdown.render(120).join("\n");

    expect(rendered).toContain(`\x1b]8;;${url}`);
    expect(normalizeTestText(rendered)).toContain(url);
    expect(rendered).not.toContain("Y2xpcGJvYXJk");
  });

  it("keeps an RTL bare URL target byte-exact", () => {
    const url = "https://example.test/rtl-proof";
    const rendered = new HyperlinkMarkdown(`مرحبا ${url}`, 0, 0, markdownTheme).render(120)[0];

    expect(rendered).toBeDefined();
    const targets = osc8Targets(rendered ?? "");
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((target) => target === url)).toBe(true);
    expect(rendered?.startsWith("\u2067")).toBe(true);
    expect(rendered?.trimEnd().endsWith("\u2069")).toBe(true);
    expect(rendered?.indexOf("\u2067")).toBeLessThan(rendered?.indexOf("\x1b]8;;") ?? -1);
    expect(rendered?.indexOf("\u2069")).toBeGreaterThan(rendered?.lastIndexOf("\x1b]8;;") ?? -1);
    expect(visibleWidth(rendered ?? "")).toBe(120);
  });

  it("keeps horizontal padding outside isolates while OSC8 targets wrap intact", () => {
    const url = "https://example.test/rtl-proof/with/a/long/path";
    const lines = new HyperlinkMarkdown(`مرحبا ${url}`, 2, 0, markdownTheme).render(24);
    const rtlLine = lines.find((line) => line.includes("مرحبا"));
    const targets = osc8Targets(lines.join("\n"));

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
    expect(rtlLine?.startsWith("  \u2067")).toBe(true);
    expect(rtlLine?.trimEnd().endsWith("\u2069")).toBe(true);
    expect(rtlLine?.endsWith("  ")).toBe(true);
    expect(targets.length).toBeGreaterThan(1);
    expect(targets.every((target) => target === url)).toBe(true);
  });
});
