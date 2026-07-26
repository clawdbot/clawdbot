/* @vitest-environment jsdom */
// Browser tests cover scoped HTML capture before extract conversion.
import { beforeEach, describe, expect, it } from "vitest";
import { capturePageHtmlForExtract } from "./pw-tools-core.extract.js";

describe("browser extract page capture", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = `
      <head><title>Page</title></head>
      <body>
        <nav>Global navigation</nav>
        <main>
          <article class="item"><h1>First</h1><aside class="ad">Ad</aside></article>
          <article class="item"><h1>Second</h1><footer>Boilerplate</footer></article>
        </main>
      </body>`;
  });

  it("captures only matching subtrees", () => {
    const result = capturePageHtmlForExtract({ selector: "main", ignoreSelectors: [] });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.html).toContain("First");
      expect(result.html).not.toContain("Global navigation");
    }
  });

  it("serializes overlapping selector matches only once", () => {
    const result = capturePageHtmlForExtract({
      selector: "main, main article",
      ignoreSelectors: [],
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.html.match(/<article/g)).toHaveLength(2);
      expect(result.html.match(/<h1>First<\/h1>/g)).toHaveLength(1);
      expect(result.html.match(/<h1>Second<\/h1>/g)).toHaveLength(1);
    }
  });

  it("returns an actionable error when the selector matches nothing", () => {
    expect(capturePageHtmlForExtract({ selector: ".missing", ignoreSelectors: [] })).toEqual({
      ok: false,
      error: "selector_not_found",
    });
  });

  it("removes ignored nodes from a whole-page capture", () => {
    const result = capturePageHtmlForExtract({ ignoreSelectors: ["nav", "aside"] });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.html).toContain("First");
      expect(result.html).not.toContain("Global navigation");
      expect(result.html).not.toContain("Ad");
    }
  });

  it("combines multiple matched subtrees with ignored descendants removed", () => {
    const result = capturePageHtmlForExtract({
      selector: "article.item",
      ignoreSelectors: ["body .ad", "body footer"],
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.html).toContain("First");
      expect(result.html).toContain("Second");
      expect(result.html).not.toContain("Ad");
      expect(result.html).not.toContain("Boilerplate");
      expect(result.html).not.toContain("Global navigation");
    }
  });

  it("returns an actionable error when ignore selectors remove every matched root", () => {
    expect(capturePageHtmlForExtract({ selector: "main", ignoreSelectors: ["body main"] })).toEqual(
      {
        ok: false,
        error: "selector_not_found",
      },
    );
  });
});
