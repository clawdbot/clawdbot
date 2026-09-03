import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("CJK-friendly Markdown", () => {
  it.each([
    { markdown: "**「先端の記述子」**のが重要", strong: "「先端の記述子」" },
    { markdown: "これは**（注記）**です", strong: "（注記）" },
    { markdown: "の**「強調」**だ", strong: "「強調」" },
    { markdown: "前**加粗：**后", strong: "加粗：" },
    { markdown: "이것은 **강조:**입니다", strong: "강조:" },
    { markdown: "𰻞𰻞**（ビャンビャン）**麺", strong: "（ビャンビャン）" },
  ])("renders punctuation-adjacent emphasis in $markdown", ({ markdown, strong }) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(markdown));
    expect(fragment.querySelector("strong")?.textContent).toBe(strong);
    expect(fragment.textContent).not.toContain("**");
  });

  it("does not enable Latin intraword underscore emphasis", () => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml("foo_bar_baz"));
    expect(fragment.textContent).toBe("foo_bar_baz\n");
    expect(fragment.querySelector("em")).toBeNull();
  });

  it("leaves literal CJK emphasis inside code spans", () => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml("`前**加粗：**后`"));
    expect(fragment.querySelector("code")?.textContent).toBe("前**加粗：**后");
    expect(fragment.querySelector("strong")).toBeNull();
  });
});

describe("safe Markdown HTML", () => {
  it.each(["<br>", "<BR/>", "<br />", "<Br   >"])("renders %s as a line break", (tag) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(`一${tag}二`));
    expect(fragment.querySelectorAll("br")).toHaveLength(1);
    expect(fragment.textContent).toBe("一二\n");
  });

  it("renders a line break inside a table cell", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(["| Language |", "| --- |", "| 一<br>二 |"].join("\n")),
    );
    const cell = fragment.querySelector("tbody td");
    expect(cell?.querySelectorAll("br")).toHaveLength(1);
    expect(cell?.textContent).toBe("一二");
  });

  it("renders a line break between blocks", () => {
    expect(toSanitizedMarkdownHtml("before\n\n<br>\n\nafter")).toBe(
      "<p>before</p>\n<br>\n<p>after</p>\n",
    );
  });

  it.each([
    "<div>**bold**</div>",
    "<script>alert(1)</script>",
    "Check <b>this</b> out",
    '<br onclick="alert(1)">',
    '<br onmouseover="alert(1)" />',
    '<br style="background:url(javascript:alert(1))">',
    '<br data-owned="false">',
    "</br>",
  ])("escapes untrusted markup %s", (markup) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml(markup));
    expect(fragment.querySelector("br")).toBeNull();
    expect(fragment.textContent).toContain(markup);
    expect(fragment.querySelector("script")).toBeNull();
  });
});
