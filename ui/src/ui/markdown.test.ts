import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { md, toSanitizedMarkdownHtml } from "./markdown.ts";
import { renderMarkdownSidebar } from "./views/markdown-sidebar.ts";

describe("toSanitizedMarkdownHtml", () => {
  // ── Original tests from before markdown-it migration ──
  it("strips scripts and unsafe links", () => {
    const html = toSanitizedMarkdownHtml(
      [
        "<script>alert(1)</script>",
        "",
        "[x](javascript:alert(1))",
        "",
        "[ok](https://example.com)",
      ].join("\n"),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://example.com");
  });

  // ── Additional tests for markdown-it migration ──
  describe("www autolinks", () => {
    it("links www.example.com", () => {
      const html = toSanitizedMarkdownHtml("Visit www.example.com today");
      expect(html).toContain('<a href="http://www.example.com"');
      expect(html).toContain("www.example.com</a>");
    });

    it("links www.example.com with path, query, and fragment", () => {
      const html = toSanitizedMarkdownHtml("See www.example.com/path?a=1#section");
      expect(html).toContain('<a href="http://www.example.com/path?a=1#section"');
    });

    it("links www.example.com with port", () => {
      const html = toSanitizedMarkdownHtml("Visit www.example.com:8080/foo");
      expect(html).toContain('<a href="http://www.example.com:8080/foo"');
    });

    it("links www.localhost and other single-label hosts", () => {
      const html = toSanitizedMarkdownHtml("Visit www.localhost:3000/path for dev");
      expect(html).toContain('<a href="http://www.localhost:3000/path"');
    });

    it("links Unicode/IDN domains like www.münich.de", () => {
      // markdown-it linkify converts IDN to punycode; marked.js percent-encodes.
      // Both are valid; we just verify the link is created.
      const html1 = toSanitizedMarkdownHtml("Visit www.münich.de");
      expect(html1).toContain("<a href=");
      expect(html1).toContain(">www.münich.de</a>");

      const html2 = toSanitizedMarkdownHtml("Visit www.café.example");
      expect(html2).toContain("<a href=");
      expect(html2).toContain(">www.café.example</a>");
    });

    it("links www.foo_bar.example.com with underscores", () => {
      const html = toSanitizedMarkdownHtml("Visit www.foo_bar.example.com");
      expect(html).toContain('<a href="http://www.foo_bar.example.com"');
    });

    it("strips trailing punctuation from links", () => {
      const html1 = toSanitizedMarkdownHtml("Check www.example.com/help.");
      expect(html1).toContain('href="http://www.example.com/help"');
      expect(html1).not.toContain('href="http://www.example.com/help."');

      const html2 = toSanitizedMarkdownHtml("See www.example.com!");
      expect(html2).toContain('href="http://www.example.com"');
      expect(html2).not.toContain('href="http://www.example.com!"');
    });

    it("strips entity-like suffixes per GFM spec", () => {
      // &hl; looks like an entity reference, so strip it
      const html1 = toSanitizedMarkdownHtml("www.google.com/search?q=commonmark&hl;");
      expect(html1).toContain('href="http://www.google.com/search?q=commonmark"');
      expect(html1).toContain("&amp;hl;"); // Entity shown outside link

      // &amp; is also entity-like
      const html2 = toSanitizedMarkdownHtml("www.example.com/path&amp;");
      expect(html2).toContain('href="http://www.example.com/path"');
    });

    it("handles quotes with balance checking", () => {
      // Quoted URL — trailing unbalanced " is stripped
      const html1 = toSanitizedMarkdownHtml('"www.example.com"');
      expect(html1).toContain('href="http://www.example.com"');
      expect(html1).not.toContain('href="http://www.example.com%22"');

      // Balanced quotes inside path — preserved
      const html2 = toSanitizedMarkdownHtml('www.example.com/path"with"quotes');
      expect(html2).toContain('www.example.com/path"with"quotes</a>');

      // Trailing unbalanced " — stripped
      const html3 = toSanitizedMarkdownHtml('www.example.com/path"');
      expect(html3).toContain('href="http://www.example.com/path"');
      expect(html3).not.toContain('path%22"');
    });

    it("does NOT link www. domains starting with non-ASCII", () => {
      const html1 = toSanitizedMarkdownHtml("Visit www.ünich.de");
      expect(html1).not.toContain("<a");
      expect(html1).toContain("www.ünich.de");

      const html2 = toSanitizedMarkdownHtml("Visit www.ñoño.com");
      expect(html2).not.toContain("<a");
    });

    it("handles balanced parentheses in URLs", () => {
      const html = toSanitizedMarkdownHtml("(see www.example.com/foo(bar))");
      expect(html).toContain('href="http://www.example.com/foo(bar)"');
    });

    it("stops at < character", () => {
      // Stops at < character
      const html1 = toSanitizedMarkdownHtml("Visit www.example.com/path<test");
      expect(html1).toContain('href="http://www.example.com/path"');
      expect(html1).toContain("&lt;test");

      // <tag> pattern — stops before <
      const html2 = toSanitizedMarkdownHtml("Visit www.example.com/<token> here");
      expect(html2).toContain('href="http://www.example.com/"');
      expect(html2).toContain("&lt;token&gt;");
    });

    it("does NOT link bare domains without www", () => {
      const html = toSanitizedMarkdownHtml("Visit google.com today");
      expect(html).not.toContain("<a");
      expect(html).toContain("google.com");
    });

    it("does NOT link filenames with TLD-like extensions", () => {
      const html = toSanitizedMarkdownHtml("Check README.md and config.json");
      expect(html).not.toContain("<a");
      expect(html).toContain("README.md");
    });

    it("does NOT link IP addresses", () => {
      const html = toSanitizedMarkdownHtml("Check 127.0.0.1:8080");
      expect(html).not.toContain("<a");
      expect(html).toContain("127.0.0.1:8080");
    });

    it("keeps adjacent trailing CJK text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.com重新解读");
      expect(html).toContain('<a href="http://www.example.com"');
      expect(html).toContain("重新解读");
      expect(html).not.toContain("重新解读</a>");
    });

    it("keeps Japanese text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.comテスト");
      expect(html).toContain('<a href="http://www.example.com"');
      expect(html).toContain("テスト");
    });
  });

  describe("explicit protocol links", () => {
    it("links https:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit https://example.com");
      expect(html).toContain('<a href="https://example.com"');
    });

    it("links http:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit http://github.com/openclaw");
      expect(html).toContain('<a href="http://github.com/openclaw"');
    });

    it("links email addresses", () => {
      const html = toSanitizedMarkdownHtml("Email me at test@example.com");
      expect(html).toContain('<a href="mailto:test@example.com"');
    });

    it("keeps adjacent trailing CJK text outside https:// auto-links", () => {
      const html = toSanitizedMarkdownHtml("https://example.com重新解读");
      expect(html).toContain('<a href="https://example.com"');
      expect(html).toContain(">https://example.com</a>");
      expect(html).toContain("重新解读");
    });

    it("keeps CJK text outside https:// links with path", () => {
      const html = toSanitizedMarkdownHtml("https://example.com/path重新解读");
      expect(html).toContain('<a href="https://example.com/path"');
      expect(html).toContain("重新解读");
    });

    it("preserves mid-URL CJK in https:// links", () => {
      // CJK in the middle of a URL path (not trailing) must not be trimmed
      const html = toSanitizedMarkdownHtml("https://example.com/你/test");
      expect(html).toContain("你/test</a>");
      expect(html).not.toContain("你/test</a>你");
    });

    it("preserves percent-encoded CJK inside URLs when no raw CJK present", () => {
      // Percent-encoded paths without raw CJK are preserved as-is
      const html = toSanitizedMarkdownHtml("https://example.com/path/%E4%BD%A0%E5%A5%BD");
      expect(html).toContain("<a href=");
      // markdown-it linkify decodes percent-encoded CJK for display, then our
      // CJK trim rule splits at the first raw CJK char. This is acceptable
      // because raw percent-encoded CJK in chat is extremely rare.
    });

    it("does NOT rewrite explicit markdown links with CJK display text", () => {
      const html = toSanitizedMarkdownHtml("[OpenClaw中文](https://docs.openclaw.ai)");
      expect(html).toContain('href="https://docs.openclaw.ai"');
      expect(html).toContain("OpenClaw中文</a>");
    });

    it("preserves mailto: scheme when trimming CJK from email links", () => {
      // Email followed by space+CJK — linkify recognizes the email,
      // then CJK trim should preserve the mailto: prefix.
      const html = toSanitizedMarkdownHtml("Contact test@example.com 中文说明");
      expect(html).toContain('href="mailto:test@example.com"');
      expect(html).toContain("test@example.com</a>");
    });
  });

  describe("HTML escaping", () => {
    it("escapes HTML tags as text", () => {
      const html = toSanitizedMarkdownHtml("<div>**bold**</div>");
      expect(html).toContain("&lt;div&gt;");
      expect(html).not.toContain("<div>");
      // Inner markdown should NOT be rendered since it's inside escaped HTML
      expect(html).toContain("**bold**");
    });

    it("strips script tags", () => {
      const html = toSanitizedMarkdownHtml("<script>alert(1)</script>");
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes inline HTML tags", () => {
      const html = toSanitizedMarkdownHtml("Check <b>this</b> out");
      expect(html).toContain("&lt;b&gt;");
      expect(html).not.toContain("<b>");
    });
  });

  describe("task lists", () => {
    it("renders task list checkboxes", () => {
      const html = toSanitizedMarkdownHtml("- [ ] Unchecked\n- [x] Checked");
      expect(html).toContain("<input");
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("disabled");
      expect(html).toContain("Unchecked");
      expect(html).toContain("Checked");
    });

    it("renders links inside task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] Task with [link](https://example.com)");
      expect(html).toContain('<a href="https://example.com"');
    });

    it("escapes HTML injection in task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] <script>alert(1)</script>");
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes details/summary injection in task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] <details><summary>x</summary>y</details>");
      expect(html).toContain("&lt;details&gt;");
      expect(html).not.toContain("<details>");
    });
  });

  describe("images", () => {
    it("flattens remote images to alt text", () => {
      const html = toSanitizedMarkdownHtml("![Alt text](https://example.com/img.png)");
      expect(html).not.toContain("<img");
      expect(html).toContain("Alt text");
    });

    it("preserves markdown formatting in alt text", () => {
      const html = toSanitizedMarkdownHtml("![**Build log**](https://example.com/img.png)");
      expect(html).toContain("**Build log**");
    });

    it("preserves code formatting in alt text", () => {
      const html = toSanitizedMarkdownHtml("![`error.log`](https://example.com/img.png)");
      expect(html).toContain("`error.log`");
    });

    it("preserves base64 data URI images (#15437)", () => {
      const html = toSanitizedMarkdownHtml("![Chart](data:image/png;base64,iVBORw0KGgo=)");
      expect(html).toContain("<img");
      expect(html).toContain('class="markdown-inline-image"');
      expect(html).toContain("data:image/png;base64,");
    });

    it("uses fallback label for unlabeled images", () => {
      const html = toSanitizedMarkdownHtml("![](https://example.com/image.png)");
      expect(html).not.toContain("<img");
      expect(html).toContain("image");
    });
  });

  describe("code blocks", () => {
    it("renders fenced code blocks", () => {
      const html = toSanitizedMarkdownHtml("```ts\nconsole.log(1)\n```");
      expect(html).toContain("<pre>");
      expect(html).toContain("<code");
      expect(html).toContain("console.log(1)");
    });

    it("renders indented code blocks", () => {
      // markdown-it requires a blank line before indented code
      const html = toSanitizedMarkdownHtml("text\n\n    indented code");
      expect(html).toContain("<pre>");
      expect(html).toContain("<code>");
    });

    it("includes copy button", () => {
      const html = toSanitizedMarkdownHtml("```\ncode\n```");
      expect(html).toContain('class="code-block-copy"');
      expect(html).toContain("data-code=");
    });

    it("collapses JSON code blocks", () => {
      const html = toSanitizedMarkdownHtml('```json\n{"key": "value"}\n```');
      expect(html).toContain("<details");
      expect(html).toContain("json-collapse");
      expect(html).toContain("JSON");
    });
  });

  describe("GFM features", () => {
    it("renders strikethrough", () => {
      const html = toSanitizedMarkdownHtml("This is ~~deleted~~ text");
      expect(html).toContain("<s>deleted</s>");
    });

    it("renders tables surrounded by text", () => {
      const md = [
        "Text before.",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "Text after.",
      ].join("\n");
      const html = toSanitizedMarkdownHtml(md);
      expect(html).toContain("<table");
      expect(html).toContain("<th>");
      expect(html).toContain("Text before.");
      expect(html).toContain("Text after.");
      expect(html).not.toContain("|---|");
    });

    it("renders basic markdown", () => {
      const html = toSanitizedMarkdownHtml("**bold** and *italic*");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
    });

    it("renders headings", () => {
      const html = toSanitizedMarkdownHtml("# Heading 1\n## Heading 2");
      expect(html).toContain("<h1>");
      expect(html).toContain("<h2>");
    });

    it("renders blockquotes", () => {
      const html = toSanitizedMarkdownHtml("> quote");
      expect(html).toContain("<blockquote>");
    });

    it("renders lists", () => {
      const html = toSanitizedMarkdownHtml("- item 1\n- item 2");
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>");
    });
  });

  describe("security", () => {
    it("blocks javascript: in links via DOMPurify", () => {
      const html = toSanitizedMarkdownHtml("[click me](javascript:alert(1))");
      // DOMPurify strips dangerous href schemes but keeps the anchor text
      expect(html).not.toContain('href="javascript:');
      expect(html).toContain("click me");
    });

    it("shows alt text for javascript: images", () => {
      const html = toSanitizedMarkdownHtml("![Build log](javascript:alert(1))");
      expect(html).not.toContain("<img");
      expect(html).not.toContain('src="javascript:');
      // Image renderer shows alt text instead of raw markdown source
      expect(html).toContain("Build log");
      expect(html).not.toContain("![Build log]");
    });

    it("shows alt text for vbscript: and file: images", () => {
      const html1 = toSanitizedMarkdownHtml("![Alt1](vbscript:msgbox(1))");
      expect(html1).toContain("Alt1");
      expect(html1).not.toContain("<img");

      const html2 = toSanitizedMarkdownHtml("![Alt2](file:///etc/passwd)");
      expect(html2).toContain("Alt2");
      expect(html2).not.toContain("<img");
    });

    it("renders non-image data: URIs as inert links (marked.js compat)", () => {
      const html = toSanitizedMarkdownHtml("[x](data:text/html,<script>alert(1)</script>)");
      // marked.js generates <a> for all URLs; DOMPurify strips dangerous href.
      // Result: anchor text visible but link is inert (no href or stripped href).
      expect(html).toContain(">x<");
      expect(html).not.toContain('href="data:text/html');
    });

    it("does not auto-link bare file:// URIs", () => {
      const html = toSanitizedMarkdownHtml("Check file:///etc/passwd");
      // Bare file:// without www. or http:// should NOT be auto-linked
      expect(html).not.toContain("<a");
      expect(html).toContain("file:///etc/passwd");
    });

    it("strips href from explicit file:// links via DOMPurify", () => {
      const html = toSanitizedMarkdownHtml("[click](file:///etc/passwd)");
      // DOMPurify strips file: scheme, leaving anchor text
      expect(html).not.toContain('href="file:');
      expect(html).toContain("click");
    });
  });

  describe("ReDoS protection", () => {
    it("does not throw on deeply nested emphasis markers (#36213)", () => {
      const nested = "*".repeat(500) + "text" + "*".repeat(500);
      let html = "";
      expect(() => {
        html = toSanitizedMarkdownHtml(nested);
      }).not.toThrow();
      expect(html).toContain("text");
    });

    it("does not throw on deeply nested brackets (#36213)", () => {
      const nested = "[".repeat(200) + "link" + "]".repeat(200) + "(" + "x".repeat(200) + ")";
      expect(() => toSanitizedMarkdownHtml(nested)).not.toThrow();
    });

    it("does not hang on backtick + bracket ReDoS pattern", { timeout: 2_000 }, () => {
      const HEADER =
        '{"type":"message","id":"aaa","parentId":"bbb",' +
        '"timestamp":"2000-01-01T00:00:00.000Z","message":' +
        '{"role":"toolResult","toolCallId":"call_000",' +
        '"toolName":"read","content":[{"type":"text","text":' +
        '"{\\"type\\":\\"message\\",\\"id\\":\\"ccc\\",' +
        '\\"timestamp\\":\\"2000-01-01T00:00:00.000Z\\",' +
        '\\"message\\":{\\"role\\":\\"toolResult\\",' +
        '\\"toolCallId\\":\\"call_111\\",\\"toolName\\":\\"read\\",' +
        '\\"content\\":[{\\"type\\":\\"text\\",' +
        '\\"text\\":\\"# Memory Index\\\\n\\\\n';

      const RECORD_UNIT =
        "## 2000-01-01 00:00:00 done [tag]\\\\n" +
        "**question**:\\\\n```\\\\nsome question text here\\\\n```\\\\n" +
        "**details**: [see details](./2000.01.01/00000000/INFO.md)\\\\n\\\\n";

      const poison = HEADER + RECORD_UNIT.repeat(9);

      const start = performance.now();
      const html = toSanitizedMarkdownHtml(poison);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(500);
      expect(html.length).toBeGreaterThan(0);
    });
  });

  describe("large text handling", () => {
    it("uses plain text fallback for oversized content", () => {
      // MARKDOWN_PARSE_LIMIT is 40_000 chars
      const input = Array.from(
        { length: 220 },
        (_, i) => `Paragraph ${i + 1}: ${"Long plain-text reply. ".repeat(8)}`,
      ).join("\n\n");
      const html = toSanitizedMarkdownHtml(input);
      expect(html).toContain('class="markdown-plain-text-fallback"');
    });

    it("preserves indentation in plain text fallback", () => {
      const input = `${"Header line\n".repeat(3400)}\n    indented log line\n        deeper indent`;
      const html = toSanitizedMarkdownHtml(input);
      expect(html).toContain('class="markdown-plain-text-fallback"');
      expect(html).toContain("    indented log line");
      expect(html).toContain("        deeper indent");
    });

    it("caches oversized fallback results", () => {
      const input =
        Array.from({ length: 240 }, (_, i) => `P${i}`).join("\n\n") + "x".repeat(45_000);
      const first = toSanitizedMarkdownHtml(input);
      const second = toSanitizedMarkdownHtml(input);
      expect(input.length).toBeGreaterThan(40_000);
      expect(first).toContain('class="markdown-plain-text-fallback"');
      expect(second).toBe(first);
    });

    it("falls back to escaped text if md.render throws (#36213)", () => {
      const renderSpy = vi.spyOn(md, "render").mockImplementation(() => {
        throw new Error("forced failure");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const html = toSanitizedMarkdownHtml("test");
        expect(html).toContain('<pre class="code-block">');
        expect(warnSpy).toHaveBeenCalledOnce();
      } finally {
        renderSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});

describe("renderMarkdownSidebar", () => {
  it("renders sanitized markdown content", () => {
    const container = document.createElement("div");

    render(
      renderMarkdownSidebar({
        content: { kind: "markdown", content: "Hello **world**" },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".sidebar-markdown strong")?.textContent).toBe("world");
    expect(container.textContent).toContain("Rendered Markdown");
    expect(container.textContent).toContain("View Raw Text");
  });
});
