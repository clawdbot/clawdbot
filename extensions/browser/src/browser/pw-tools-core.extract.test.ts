/* @vitest-environment jsdom */
// Browser tests cover scoped HTML capture before extract conversion.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPageForTargetId = vi.fn();

vi.mock("./pw-session.js", () => ({
  getPageForTargetId,
}));

const { pageContentViaPlaywright } = await import("./pw-tools-core.extract.js");

const page = {
  content: vi.fn(async () => "<html><body>Unscoped page</body></html>"),
  evaluate: vi.fn(
    async <TArg, TResult>(fn: (arg: TArg) => TResult | Promise<TResult>, arg: TArg) =>
      await fn(arg),
  ),
};

async function capture(params: { selector?: string; ignoreSelectors?: string[] } = {}) {
  return await pageContentViaPlaywright({
    cdpUrl: "http://127.0.0.1:18800",
    targetId: "t1",
    ...params,
  });
}

describe("browser extract page capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPageForTargetId.mockResolvedValue(page as never);
    page.content.mockResolvedValue("<html><body>Unscoped page</body></html>");
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

  it("captures only matching subtrees", async () => {
    const result = await capture({ selector: "main" });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.html).toContain("First");
      expect(result.html).not.toContain("Global navigation");
    }
  });

  it("serializes overlapping selector matches only once", async () => {
    const result = await capture({ selector: "main, main article" });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.html.match(/<article/g)).toHaveLength(2);
      expect(result.html.match(/<h1>First<\/h1>/g)).toHaveLength(1);
      expect(result.html.match(/<h1>Second<\/h1>/g)).toHaveLength(1);
    }
  });

  it("returns an actionable error when the selector matches nothing", async () => {
    await expect(capture({ selector: ".missing" })).resolves.toEqual({
      ok: false,
      error: "selector_not_found",
    });
  });

  it("returns an invalid-selector error", async () => {
    await expect(capture({ selector: "[" })).resolves.toEqual({
      ok: false,
      error: "invalid_selector",
    });
  });

  it("removes ignored nodes from a whole-page capture", async () => {
    const result = await capture({ ignoreSelectors: ["nav", "aside"] });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.html).toContain("First");
      expect(result.html).not.toContain("Global navigation");
      expect(result.html).not.toContain("Ad");
    }
  });

  it("combines multiple matched subtrees with ignored descendants removed", async () => {
    const result = await capture({
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

  it("returns an actionable error when ignore selectors remove every matched root", async () => {
    await expect(capture({ selector: "main", ignoreSelectors: ["body main"] })).resolves.toEqual({
      ok: false,
      error: "selector_not_found",
    });
  });

  it("uses page.content for an unscoped capture", async () => {
    await expect(capture()).resolves.toEqual({
      ok: true,
      html: "<html><body>Unscoped page</body></html>",
    });
    expect(page.content).toHaveBeenCalledOnce();
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
