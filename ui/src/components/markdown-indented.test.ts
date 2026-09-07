// Control UI tests cover indented Markdown behavior.
import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("indented Markdown source", () => {
  it.each(["    *literal*", "\t*literal*", "\n\n    *literal*"])(
    "renders initial code: %j",
    (source) => {
      expect(
        htmlFragment(toSanitizedMarkdownHtml(source)).querySelector("pre code")?.textContent,
      ).toBe("*literal*\n");
    },
  );

  it.each(["    a\n\n    b", "Intro\n\n    a\n\n    b"])(
    "keeps a streamed indented block together: %j",
    (source) => {
      const fragment = htmlFragment(toStreamingMarkdownParts(source).join(""));
      expect(fragment.querySelectorAll("pre code")).toHaveLength(1);
      expect(fragment.querySelector("pre code")?.textContent).toBe("a\n\nb\n");
    },
  );

  it("never repairs literal punctuation inside streaming indented code", () => {
    const source = "    *literal";
    for (let end = 5; end <= source.length; end++) {
      const fragment = htmlFragment(
        toStreamingMarkdownParts(source.slice(0, end), {}, "indented-prefix").join(""),
      );
      expect(fragment.querySelector("pre code")?.textContent).toBe(`${source.slice(4, end)}\n`);
    }
  });
});
