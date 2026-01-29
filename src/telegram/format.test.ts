import { describe, expect, it } from "vitest";

import { markdownToTelegramChunks, markdownToTelegramHtml } from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("renders basic inline formatting", () => {
    const res = markdownToTelegramHtml("hi _there_ **boss** `code`");
    expect(res).toBe("hi <i>there</i> <b>boss</b> <code>code</code>");
  });

  it("renders links as Telegram-safe HTML", () => {
    const res = markdownToTelegramHtml("see [docs](https://example.com)");
    expect(res).toBe('see <a href="https://example.com">docs</a>');
  });

  it("escapes raw HTML", () => {
    const res = markdownToTelegramHtml("<b>nope</b>");
    expect(res).toBe("&lt;b&gt;nope&lt;/b&gt;");
  });

  it("escapes unsafe characters", () => {
    const res = markdownToTelegramHtml("a & b < c");
    expect(res).toBe("a &amp; b &lt; c");
  });

  it("renders paragraphs with blank lines", () => {
    const res = markdownToTelegramHtml("first\n\nsecond");
    expect(res).toBe("first\n\nsecond");
  });

  it("renders lists without block HTML", () => {
    const res = markdownToTelegramHtml("- one\n- two");
    expect(res).toBe("• one\n• two");
  });

  it("renders ordered lists with numbering", () => {
    const res = markdownToTelegramHtml("2. two\n3. three");
    expect(res).toBe("2. two\n3. three");
  });

  it("flattens headings and blockquotes", () => {
    const res = markdownToTelegramHtml("# Title\n\n> Quote");
    expect(res).toBe("Title\n\nQuote");
  });

  it("renders fenced code blocks", () => {
    const res = markdownToTelegramHtml("```js\nconst x = 1;\n```");
    expect(res).toBe("<pre><code>const x = 1;\n</code></pre>");
  });

  it("returns empty string for thematic break (---)", () => {
    const res = markdownToTelegramHtml("---");
    expect(res.trim()).toBe("");
  });
});

describe("markdownToTelegramChunks", () => {
  it("filters out empty chunks from thematic breaks", () => {
    // A thematic break (---) produces empty HTML; it must be filtered
    // out so Telegram doesn't receive an empty message.  See #3011.
    const chunks = markdownToTelegramChunks("First paragraph\n\n---\n\nSecond paragraph", 4000);
    // Every returned chunk must have non-empty html
    for (const chunk of chunks) {
      expect(chunk.html.trim().length).toBeGreaterThan(0);
    }
    // Both paragraphs should still be present
    const combined = chunks.map((c) => c.html).join("");
    expect(combined).toContain("First paragraph");
    expect(combined).toContain("Second paragraph");
  });

  it("filters out empty chunks from *** and ___", () => {
    const chunksAsterisk = markdownToTelegramChunks("Above\n\n***\n\nBelow", 4000);
    const chunksUnderscore = markdownToTelegramChunks("Above\n\n___\n\nBelow", 4000);
    for (const chunk of [...chunksAsterisk, ...chunksUnderscore]) {
      expect(chunk.html.trim().length).toBeGreaterThan(0);
    }
  });

  it("preserves normal chunks without filtering", () => {
    const chunks = markdownToTelegramChunks("hello **world**", 4000);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].html).toContain("hello");
  });
});
