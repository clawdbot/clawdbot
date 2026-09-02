// Web Readability tests cover web content extractor plugin behavior.
import { describe, expect, it } from "vitest";
import { createReadabilityWebContentExtractor } from "./web-content-extractor.js";

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Example Article</title>
  </head>
  <body>
    <nav>
      <ul>
        <li><a href="/home">Home</a></li>
        <li><a href="/about">About</a></li>
      </ul>
    </nav>
    <main>
      <article>
        <h1>Example Article</h1>
        <p>Main content starts here with enough words to satisfy readability.</p>
        <p>Second paragraph for a bit more signal.</p>
        <p><a href="../next">Continue reading</a></p>
      </article>
    </main>
    <footer>Footer text</footer>
  </body>
</html>`;

type ReadabilityResult = Awaited<
  ReturnType<ReturnType<typeof createReadabilityWebContentExtractor>["extract"]>
>;

function requireReadabilityResult(result: ReadabilityResult): NonNullable<ReadabilityResult> {
  if (!result) {
    throw new Error("expected readability extraction result");
  }
  return result;
}

describe("web readability extractor", () => {
  it("extracts readable text", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const result = await extractor.extract({
      html: SAMPLE_HTML,
      url: "https://example.com/article",
      extractMode: "text",
    });
    const extracted = requireReadabilityResult(result);
    expect(extracted.text).toContain("Main content starts here");
    expect(extracted.title).toBe("Example Article");
  });

  it("extracts readable markdown", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const result = await extractor.extract({
      html: SAMPLE_HTML,
      url: "https://example.com/article",
      extractMode: "markdown",
    });
    const extracted = requireReadabilityResult(result);
    expect(extracted.text).toContain("Main content starts here");
    expect(extracted.text).toContain("[Continue reading](https://example.com/next)");
    expect(extracted.title).toBe("Example Article");
  });

  it("does not count void tags toward the nesting limit", async () => {
    const extractor = createReadabilityWebContentExtractor();
    const html = SAMPLE_HTML.replace("<article>", `<article>${"<BR>".repeat(3100)}`);
    const result = await extractor.extract({
      html,
      url: "https://example.com/article",
      extractMode: "markdown",
    });
    expect(requireReadabilityResult(result).text).toContain("Main content starts here");
  });
});
