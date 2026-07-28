import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): DocumentFragment {
  return document.createRange().createContextualFragment(html);
}

describe("model-authored details blocks", () => {
  it("renders block-level details with nested markdown", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "<details open>",
        "",
        "<summary>Optional depth</summary>",
        "",
        "**Bold body**",
        "",
        "- one",
        "- two",
        "",
        "> quoted body",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "</details>",
      ].join("\n"),
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.hasAttribute("open")).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("Optional depth");
    expect(details?.querySelector("strong")?.textContent).toBe("Bold body");
    expect([...(details?.querySelectorAll("li") ?? [])].map((item) => item.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(details?.querySelector("blockquote")?.textContent?.trim()).toBe("quoted body");
    expect(details?.querySelector("code.language-ts")?.textContent).toContain("const value = 1;");
  });

  it("renders a compact details block while escaping HTML in its body", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>More</summary>**bold** <script>nope</script></details>",
    );
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details summary")?.textContent).toBe("More");
    expect(fragment.querySelector("details strong")?.textContent).toBe("bold");
    expect(fragment.querySelector("script")).toBeNull();
    expect(fragment.querySelector("details")?.textContent).toContain("<script>nope</script>");
  });

  it("keeps large runs of disclosure tags literal inside fenced code", () => {
    const count = 2_000;
    const literals = Array.from({ length: count }, () => "</details>").join("\n");
    const html = toSanitizedMarkdownHtml(
      `<details><summary>Examples</summary>\n\n\`\`\`html\n${literals}\n\`\`\`\n\n</details>`,
    );
    const code = htmlFragment(html).querySelector("details code");

    expect(code?.textContent?.match(/<\/details>/g)).toHaveLength(count);
  });

  it("caps deeply nested details at 32 tags on one line", () => {
    let markdown = "deep body";
    for (let index = 0; index < 48; index += 1) {
      markdown = `<details><summary>Level ${index}</summary>${markdown}</details>`;
    }

    const html = toSanitizedMarkdownHtml(markdown);
    const fragment = htmlFragment(html);

    expect(fragment.querySelectorAll("details")).toHaveLength(32);
    expect(fragment.textContent).toContain("<details>");
  });

  it("caps deeply nested details across lines", () => {
    const lines: string[] = [];
    for (let index = 0; index < 48; index += 1) {
      lines.push("<details>", `<summary>Level ${index}</summary>`, "");
    }
    lines.push("deep body");
    for (let index = 0; index < 48; index += 1) {
      lines.push("", "</details>");
    }

    const html = toSanitizedMarkdownHtml(lines.join("\n"));
    const fragment = htmlFragment(html);

    expect(fragment.querySelectorAll("details")).toHaveLength(32);
    expect(fragment.textContent).toContain("<details>");
  });

  it("applies the depth cap to every opener on a matched line", () => {
    const markdown = `${Array.from({ length: 24 }, () => "<details><details>").join("\n\n")}\n\ndeep body`;
    const html = toSanitizedMarkdownHtml(markdown);
    const fragment = htmlFragment(html);

    expect(fragment.querySelectorAll("details")).toHaveLength(32);
    expect(fragment.textContent).toContain("<details>");
  });

  it("escapes unsupported openers while continuing to scan later valid tags", () => {
    const html = toSanitizedMarkdownHtml(
      '<details><summary>Outer</summary><details class="x">inner</details>after</details>',
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelectorAll("details");

    expect(details).toHaveLength(1);
    expect(details[0]?.textContent).toContain('<details class="x">');
    expect(details[0]?.textContent).not.toContain("after");
    expect(fragment.textContent).toContain("after</details>");
    expect(html).not.toContain("&lt;details&gt;&lt;summary&gt;Outer");
  });

  it("keeps an unterminated details block in the repaired streaming tail", () => {
    const html = toStreamingMarkdownHtml(
      "Intro\n\n<details open>\n<summary>More</summary>\n\n**partial body",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(fragment.querySelector("p")?.textContent).toBe("Intro");
    expect(details?.hasAttribute("open")).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("More");
    expect(details?.querySelector("strong")?.textContent).toBe("partial body");
    expect(html).not.toContain("&lt;details");
    expect(html).not.toContain("&lt;/details");
    expect(details?.textContent).not.toContain("</details>");
  });

  it("repairs an unterminated summary while streaming", () => {
    const html = toStreamingMarkdownHtml("<details>\n<summary>Still arriving");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details summary")?.textContent).toBe("Still arriving");
    expect(html).not.toContain("&lt;summary");
  });

  it("keeps completed code fences inside an open details streaming tail", () => {
    const html = toStreamingMarkdownHtml(
      "<details>\n<summary>Logs</summary>\n\n~~~ts\nconst value = 1;\n~~~\n\nstill streaming",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("code.language-ts")?.textContent).toContain("const value = 1;");
    expect(details?.textContent).toContain("still streaming");
    expect([...fragment.children]).toHaveLength(1);
  });

  it("repairs prose after a closed fence and details block without a blank line", () => {
    const html = toStreamingMarkdownHtml(
      "<details>\n<summary>Logs</summary>\n\n```ts\nconst value = 1;\n```\n</details>\ncontinuing **now",
    );
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details code.language-ts")?.textContent).toContain(
      "const value = 1;",
    );
    expect(fragment.querySelector("p:last-child strong")?.textContent).toBe("now");
  });

  it("repairs an unterminated summary after a closed fence and details block", () => {
    const html = toStreamingMarkdownHtml(
      "<details>\n<summary>Logs</summary>\n\n```ts\nconst value = 1;\n```\n</details>\n<details>\n<summary>Still arriving",
    );
    const details = htmlFragment(html).querySelectorAll("details");

    expect(details).toHaveLength(2);
    expect(details[1]?.querySelector("summary")?.textContent).toBe("Still arriving");
    expect(html).not.toContain("&lt;summary");
  });

  it("stabilizes a completed details block before the live markdown tail", () => {
    const html = toStreamingMarkdownHtml(
      "<details><summary>Done</summary>fixed</details>\n\ncontinuing **now",
    );
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details summary")?.textContent).toBe("Done");
    expect(fragment.querySelector("details p")?.textContent).toBe("fixed");
    expect(fragment.querySelector("p:last-child strong")?.textContent).toBe("now");
  });

  it("keeps a closed disclosure and its continuation in the same list item", () => {
    const html = toStreamingMarkdownHtml(
      "- <details>\n  <summary>Logs</summary>\n\n  body\n  </details>\n  continuing **now",
    );
    const fragment = htmlFragment(html);
    const listItem = fragment.querySelector("li");

    expect(listItem?.querySelector("details")?.textContent).toContain("body");
    expect(listItem?.querySelector("strong")?.textContent).toBe("now");
    expect(fragment.querySelector(":scope > p")).toBeNull();
  });
});

describe("multi-token details shapes", () => {
  it("parses body blocks normally after an opener and summary share a line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>More</summary>\nbody **one**\n\nbody two\n</details>",
    );
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("More");
    expect(details?.querySelector("strong")?.textContent).toBe("one");
    expect(details?.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders a summary authored after a blank line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details>\n\n<summary>Authored label</summary>\n\nbody\n</details>",
    );
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("Authored label");
    expect(details?.textContent).toContain("body");
  });

  it("renders details when body text follows the summary without a blank line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details>\n<summary>More</summary>\nfirst line\n\nsecond paragraph\n</details>",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("More");
    expect(details?.textContent).toContain("first line");
    expect(details?.textContent).toContain("second paragraph");
    expect(html).not.toContain("&lt;details");
  });

  it("renders markdown following a closed details block from the same token", () => {
    const html = toSanitizedMarkdownHtml("<details><summary>A</summary>a</details>\ncontinuing");
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details summary")?.textContent).toBe("A");
    expect(fragment.querySelector("details")?.textContent).toContain("a");
    expect(fragment.lastElementChild?.textContent).toBe("continuing");
    expect(html).not.toContain("&lt;details");
  });

  it("renders consecutive details blocks without a blank line", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>A</summary>a</details>\n<details><summary>B</summary>b</details>",
    );
    const details = htmlFragment(html).querySelectorAll("details");

    expect([...details].map((entry) => entry.querySelector("summary")?.textContent)).toEqual([
      "A",
      "B",
    ]);
    expect([...details].map((entry) => entry.textContent?.trim())).toEqual(["Aa", "Bb"]);
  });

  it("renders more than 32 sibling details blocks and their trailing markdown", () => {
    const siblings = Array.from(
      { length: 40 },
      (_, index) => `<details><summary>Sibling ${index}</summary>body ${index}</details>`,
    ).join("\n");
    const html = toSanitizedMarkdownHtml(`${siblings}\ntrailing **done**`);
    const fragment = htmlFragment(html);
    const details = fragment.querySelectorAll("details");

    expect(details).toHaveLength(40);
    expect(details[39]?.querySelector("summary")?.textContent).toBe("Sibling 39");
    expect(fragment.lastElementChild?.querySelector("strong")?.textContent).toBe("done");
    expect(html).not.toContain("&lt;details");
  });

  it("renders markdown following a standalone details close token", () => {
    const html = toSanitizedMarkdownHtml(
      "<details>\n<summary>A</summary>\n\nbody\n\n</details>\ncontinuing",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("body");
    expect(details?.textContent).not.toContain("continuing");
    expect(fragment.lastElementChild?.textContent).toBe("continuing");
    expect(html).not.toContain("&lt;/details");
  });

  it("renders details when body text starts without a summary", () => {
    const html = toSanitizedMarkdownHtml("<details>\nfirst line\n\nsecond paragraph\n</details>");
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("summary")).toBeNull();
    expect(details?.textContent).toContain("first line");
    expect(details?.textContent).toContain("second paragraph");
    expect(html).not.toContain("&lt;details");
  });
});

describe("details line-start contract", () => {
  it("keeps inline-code, prose, and task-item occurrences escaped", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "`<details><summary>code</summary>body</details>`",
        "",
        "prose <details><summary>inline</summary>body</details>",
        "",
        "- [ ] <details><summary>task</summary>body</details>",
      ].join("\n"),
    );
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("details")).toBeNull();
    expect(fragment.querySelector("code")?.textContent).toContain("<details>");
    expect(fragment.querySelector("li")?.textContent).toContain("<details>");
    expect(fragment.textContent).toContain("prose <details>");
  });

  it("keeps an open streaming details block intact across inline code", () => {
    const code = "`literal </details> marker`";
    const html = toStreamingMarkdownHtml(
      `<details>\n<summary>Example</summary>\n${code}\n\nstill inside`,
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("literal </details> marker");
    expect(details?.textContent).toContain("still inside");
    expect([...fragment.children]).toHaveLength(1);
  });

  it("keeps disclosure-shaped inline code on a structural line literal", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>A</summary>`literal </details>` still inside</details>",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.querySelector("code")?.textContent).toBe("literal </details>");
    expect(details?.textContent).toContain("still inside");
    expect(fragment.querySelectorAll("details")).toHaveLength(1);
  });

  it("keeps escaped disclosure tags on a structural line literal", () => {
    const html = toSanitizedMarkdownHtml(
      "<details><summary>A</summary>\\</details> still inside</details>",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("</details> still inside");
    expect(fragment.querySelectorAll("details")).toHaveLength(1);
  });

  it("does not repair disclosure-shaped indented code while streaming", () => {
    const html = toStreamingMarkdownHtml("before\n\n    <details>\n    <summary>literal");
    const code = htmlFragment(html).querySelector("code");

    expect(code?.textContent).toBe("<details>\n<summary>literal\n");
    expect(code?.textContent).not.toContain("</summary>");
  });

  it("keeps streaming details intact across an inline prose close tag", () => {
    const html = toStreamingMarkdownHtml(
      "<details>\n<summary>A</summary>\nliteral </details> text\n\nstill inside",
    );
    const fragment = htmlFragment(html);
    const details = fragment.querySelector("details");

    expect(details?.textContent).toContain("literal </details> text");
    expect(details?.textContent).toContain("still inside");
    expect([...fragment.children]).toHaveLength(1);
  });

  it.each([
    ["list item", "- <details>\n  <summary>A</summary>\n\n  still inside"],
    ["blockquote", "> <details>\n> <summary>A</summary>\n>\n> still inside"],
  ])("keeps streaming details intact inside a %s container", (_name, markdown) => {
    const html = toStreamingMarkdownHtml(markdown);
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("A");
    expect(details?.textContent).toContain("still inside");
    expect(html).not.toContain("&lt;details");
  });

  it("keeps streaming details intact on a wide list continuation indent", () => {
    const html = toStreamingMarkdownHtml(
      "1.  item\n    <details>\n    <summary>A</summary>\n\n    still inside",
    );
    const details = htmlFragment(html).querySelector("details");

    expect(details?.querySelector("summary")?.textContent).toBe("A");
    expect(details?.textContent).toContain("still inside");
    expect(html).not.toContain("&lt;details");
  });
});
