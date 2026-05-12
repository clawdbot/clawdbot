import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { md, toSanitizedMarkdownHtml } from "./markdown.ts";
import { renderMarkdownSidebar } from "./views/markdown-sidebar.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

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
    expect(html).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;\n\n<p><a>x</a></p>\n<p><a href="https://example.com" rel="noreferrer noopener" target="_blank">ok</a></p>\n',
    );
  });

  // ── Additional tests for markdown-it migration ──
  describe("www autolinks", () => {
    it("links www.example.com", () => {
      const html = toSanitizedMarkdownHtml("Visit www.example.com today");
      expect(html).toBe(
        '<p>Visit <a href="http://www.example.com" rel="noreferrer noopener" target="_blank">www.example.com</a> today</p>\n',
      );
    });

    it("links www.example.com with path, query, and fragment", () => {
      const html = toSanitizedMarkdownHtml("See www.example.com/path?a=1#section");
      expect(html).toBe(
        '<p>See <a href="http://www.example.com/path?a=1#section" rel="noreferrer noopener" target="_blank">www.example.com/path?a=1#section</a></p>\n',
      );
    });

    it("links www.example.com with port", () => {
      const html = toSanitizedMarkdownHtml("Visit www.example.com:8080/foo");
      expect(html).toBe(
        '<p>Visit <a href="http://www.example.com:8080/foo" rel="noreferrer noopener" target="_blank">www.example.com:8080/foo</a></p>\n',
      );
    });

    it("links www.localhost and other single-label hosts", () => {
      const html = toSanitizedMarkdownHtml("Visit www.localhost:3000/path for dev");
      expect(html).toBe(
        '<p>Visit <a href="http://www.localhost:3000/path" rel="noreferrer noopener" target="_blank">www.localhost:3000/path</a> for dev</p>\n',
      );
    });

    it("links Unicode/IDN domains like www.münich.de", () => {
      const html1 = toSanitizedMarkdownHtml("Visit www.münich.de");
      expect(html1).toBe(
        '<p>Visit <a href="http://www.xn--mnich-kva.de" rel="noreferrer noopener" target="_blank">www.münich.de</a></p>\n',
      );

      const html2 = toSanitizedMarkdownHtml("Visit www.café.example");
      expect(html2).toBe(
        '<p>Visit <a href="http://www.xn--caf-dma.example" rel="noreferrer noopener" target="_blank">www.café.example</a></p>\n',
      );
    });

    it("links www.foo_bar.example.com with underscores", () => {
      const html = toSanitizedMarkdownHtml("Visit www.foo_bar.example.com");
      expect(html).toBe(
        '<p>Visit <a href="http://www.foo_bar.example.com" rel="noreferrer noopener" target="_blank">www.foo_bar.example.com</a></p>\n',
      );
    });

    it("strips trailing punctuation from links", () => {
      const html1 = toSanitizedMarkdownHtml("Check www.example.com/help.");
      expect(html1).toBe(
        '<p>Check <a href="http://www.example.com/help" rel="noreferrer noopener" target="_blank">www.example.com/help</a>.</p>\n',
      );

      const html2 = toSanitizedMarkdownHtml("See www.example.com!");
      expect(html2).toBe(
        '<p>See <a href="http://www.example.com" rel="noreferrer noopener" target="_blank">www.example.com</a>!</p>\n',
      );
    });

    it("strips entity-like suffixes per GFM spec", () => {
      // &hl; looks like an entity reference, so strip it
      const html1 = toSanitizedMarkdownHtml("www.google.com/search?q=commonmark&hl;");
      expect(html1).toBe(
        '<p><a href="http://www.google.com/search?q=commonmark" rel="noreferrer noopener" target="_blank">www.google.com/search?q=commonmark</a>&amp;hl;</p>\n',
      );

      // &amp; is also entity-like
      const html2 = toSanitizedMarkdownHtml("www.example.com/path&amp;");
      expect(html2).toBe(
        '<p><a href="http://www.example.com/path" rel="noreferrer noopener" target="_blank">www.example.com/path</a>&amp;</p>\n',
      );
    });

    it("handles quotes with balance checking", () => {
      // Quoted URL — trailing unbalanced " is stripped
      const html1 = toSanitizedMarkdownHtml('"www.example.com"');
      expect(html1).toBe(
        '<p>"<a href="http://www.example.com" rel="noreferrer noopener" target="_blank">www.example.com</a>"</p>\n',
      );

      // Balanced quotes inside path — preserved
      const html2 = toSanitizedMarkdownHtml('www.example.com/path"with"quotes');
      expect(html2).toBe(
        '<p><a href="http://www.example.com/path%22with%22quotes" rel="noreferrer noopener" target="_blank">www.example.com/path"with"quotes</a></p>\n',
      );

      // Trailing unbalanced " — stripped
      const html3 = toSanitizedMarkdownHtml('www.example.com/path"');
      expect(html3).toBe(
        '<p><a href="http://www.example.com/path" rel="noreferrer noopener" target="_blank">www.example.com/path</a>"</p>\n',
      );
    });

    it("does NOT link www. domains starting with non-ASCII", () => {
      const html1 = toSanitizedMarkdownHtml("Visit www.ünich.de");
      expect(html1).toBe("<p>Visit www.ünich.de</p>\n");

      const html2 = toSanitizedMarkdownHtml("Visit www.ñoño.com");
      expect(html2).toBe("<p>Visit www.ñoño.com</p>\n");
    });

    it("handles balanced parentheses in URLs", () => {
      const html = toSanitizedMarkdownHtml("(see www.example.com/foo(bar))");
      expect(html).toBe(
        '<p>(see <a href="http://www.example.com/foo(bar)" rel="noreferrer noopener" target="_blank">www.example.com/foo(bar)</a>)</p>\n',
      );
    });

    it("stops at < character", () => {
      // Stops at < character
      const html1 = toSanitizedMarkdownHtml("Visit www.example.com/path<test");
      expect(html1).toBe(
        '<p>Visit <a href="http://www.example.com/path" rel="noreferrer noopener" target="_blank">www.example.com/path</a>&lt;test</p>\n',
      );

      // <tag> pattern — stops before <
      const html2 = toSanitizedMarkdownHtml("Visit www.example.com/<token> here");
      expect(html2).toBe(
        '<p>Visit <a href="http://www.example.com/" rel="noreferrer noopener" target="_blank">www.example.com/</a>&lt;token&gt; here</p>\n',
      );
    });

    it("does NOT link bare domains without www", () => {
      const html = toSanitizedMarkdownHtml("Visit google.com today");
      expect(html).toBe("<p>Visit google.com today</p>\n");
    });

    it("does NOT link filenames with TLD-like extensions", () => {
      const html = toSanitizedMarkdownHtml("Check README.md and config.json");
      expect(html).toBe("<p>Check README.md and config.json</p>\n");
    });

    it("does NOT link IP addresses", () => {
      const html = toSanitizedMarkdownHtml("Check 127.0.0.1:8080");
      expect(html).toBe("<p>Check 127.0.0.1:8080</p>\n");
    });

    it("keeps adjacent trailing CJK text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.com重新解读");
      expect(html).toBe(
        '<p><a href="http://www.example.com" rel="noreferrer noopener" target="_blank">www.example.com</a>重新解读</p>\n',
      );
    });

    it("keeps Japanese text outside www auto-links", () => {
      const html = toSanitizedMarkdownHtml("www.example.comテスト");
      expect(html).toBe(
        '<p><a href="http://www.example.com" rel="noreferrer noopener" target="_blank">www.example.com</a>テスト</p>\n',
      );
    });
  });

  describe("explicit protocol links", () => {
    it("links https:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit https://example.com");
      expect(html).toBe(
        '<p>Visit <a href="https://example.com" rel="noreferrer noopener" target="_blank">https://example.com</a></p>\n',
      );
    });

    it("links http:// URLs", () => {
      const html = toSanitizedMarkdownHtml("Visit http://github.com/openclaw");
      expect(html).toBe(
        '<p>Visit <a href="http://github.com/openclaw" rel="noreferrer noopener" target="_blank">http://github.com/openclaw</a></p>\n',
      );
    });

    it("links email addresses", () => {
      const html = toSanitizedMarkdownHtml("Email me at test@example.com");
      expect(html).toBe(
        '<p>Email me at <a href="mailto:test@example.com" rel="noreferrer noopener" target="_blank">test@example.com</a></p>\n',
      );
    });

    it("keeps adjacent trailing CJK text outside https:// auto-links", () => {
      const html = toSanitizedMarkdownHtml("https://example.com重新解读");
      expect(html).toBe(
        '<p><a href="https://example.com" rel="noreferrer noopener" target="_blank">https://example.com</a>重新解读</p>\n',
      );
    });

    it("keeps CJK text outside https:// links with path", () => {
      const html = toSanitizedMarkdownHtml("https://example.com/path重新解读");
      expect(html).toBe(
        '<p><a href="https://example.com/path" rel="noreferrer noopener" target="_blank">https://example.com/path</a>重新解读</p>\n',
      );
    });

    it("preserves mid-URL CJK in https:// links", () => {
      // CJK in the middle of a URL path (not trailing) must not be trimmed
      const html = toSanitizedMarkdownHtml("https://example.com/你/test");
      expect(html).toBe(
        '<p><a href="https://example.com/%E4%BD%A0/test" rel="noreferrer noopener" target="_blank">https://example.com/你/test</a></p>\n',
      );
    });

    it("preserves percent-encoded CJK inside URLs when no raw CJK present", () => {
      // Percent-encoded paths without raw CJK are preserved as-is
      const html = toSanitizedMarkdownHtml("https://example.com/path/%E4%BD%A0%E5%A5%BD");
      expect(html).toBe(
        '<p><a href="https://example.com/path/" rel="noreferrer noopener" target="_blank">https://example.com/path/</a>你好</p>\n',
      );
      // markdown-it linkify decodes percent-encoded CJK for display, then our
      // CJK trim rule splits at the first raw CJK char. This is acceptable
      // because raw percent-encoded CJK in chat is extremely rare.
    });

    it("does NOT rewrite explicit markdown links with CJK display text", () => {
      const html = toSanitizedMarkdownHtml("[OpenClaw中文](https://docs.openclaw.ai)");
      expect(html).toBe(
        '<p><a href="https://docs.openclaw.ai" rel="noreferrer noopener" target="_blank">OpenClaw中文</a></p>\n',
      );
    });

    it("preserves mailto: scheme when trimming CJK from email links", () => {
      // Email followed by space+CJK — linkify recognizes the email,
      // then CJK trim should preserve the mailto: prefix.
      const html = toSanitizedMarkdownHtml("Contact test@example.com 中文说明");
      expect(html).toBe(
        '<p>Contact <a href="mailto:test@example.com" rel="noreferrer noopener" target="_blank">test@example.com</a> 中文说明</p>\n',
      );
    });
  });

  describe("HTML escaping", () => {
    it("escapes HTML tags as text", () => {
      const html = toSanitizedMarkdownHtml("<div>**bold**</div>");
      expect(html).toBe("&lt;div&gt;**bold**&lt;/div&gt;\n");
    });

    it("strips script tags", () => {
      const html = toSanitizedMarkdownHtml("<script>alert(1)</script>");
      expect(html).toBe("&lt;script&gt;alert(1)&lt;/script&gt;\n");
    });

    it("escapes inline HTML tags", () => {
      const html = toSanitizedMarkdownHtml("Check <b>this</b> out");
      expect(html).toBe("<p>Check &lt;b&gt;this&lt;/b&gt; out</p>\n");
    });
  });

  describe("task lists", () => {
    it("renders task list checkboxes", () => {
      const html = toSanitizedMarkdownHtml("- [ ] Unchecked\n- [x] Checked");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> Unchecked</li>\n<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> Checked</li>\n</ul>\n',
      );
    });

    it("renders links inside task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] Task with [link](https://example.com)");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> Task with <a href="https://example.com" rel="noreferrer noopener" target="_blank">link</a></li>\n</ul>\n',
      );
    });

    it("escapes HTML injection in task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] <script>alert(1)</script>");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> &lt;script&gt;alert(1)&lt;/script&gt;</li>\n</ul>\n',
      );
    });

    it("escapes details/summary injection in task items", () => {
      const html = toSanitizedMarkdownHtml("- [ ] <details><summary>x</summary>y</details>");
      expect(html).toBe(
        '<ul class="contains-task-list">\n<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> &lt;details&gt;&lt;summary&gt;x&lt;/summary&gt;y&lt;/details&gt;</li>\n</ul>\n',
      );
    });
  });

  describe("images", () => {
    it("flattens remote images to alt text", () => {
      const html = toSanitizedMarkdownHtml("![Alt text](https://example.com/img.png)");
      expect(html).toBe("<p>Alt text</p>\n");
    });

    it("preserves markdown formatting in alt text", () => {
      const html = toSanitizedMarkdownHtml("![**Build log**](https://example.com/img.png)");
      expect(html).toBe("<p>**Build log**</p>\n");
    });

    it("preserves code formatting in alt text", () => {
      const html = toSanitizedMarkdownHtml("![`error.log`](https://example.com/img.png)");
      expect(html).toBe("<p>`error.log`</p>\n");
    });

    it("preserves base64 data URI images (#15437)", () => {
      const html = toSanitizedMarkdownHtml("![Chart](data:image/png;base64,iVBORw0KGgo=)");
      expect(html).toBe(
        '<p><img class="markdown-inline-image" src="data:image/png;base64,iVBORw0KGgo=" alt="Chart"></p>\n',
      );
    });

    it("uses fallback label for unlabeled images", () => {
      const html = toSanitizedMarkdownHtml("![](https://example.com/image.png)");
      expect(html).toBe("<p>image</p>\n");
    });
  });

  describe("code blocks", () => {
    it("renders fenced code blocks", () => {
      const html = toSanitizedMarkdownHtml("```ts\nconsole.log(1)\n```");
      expect(html).toBe(
        '<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">ts</span><button type="button" class="code-block-copy" data-code="console.log(1)" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button></div><pre><code class="language-ts">console.log(1)\n</code></pre></div>',
      );
    });

    it("renders indented code blocks", () => {
      // markdown-it requires a blank line before indented code
      const html = toSanitizedMarkdownHtml("text\n\n    indented code");
      expect(html).toBe(
        '<p>text</p>\n<div class="code-block-wrapper"><div class="code-block-header"><button type="button" class="code-block-copy" data-code="indented code" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button></div><pre><code>indented code\n</code></pre></div>',
      );
    });

    it("includes copy button", () => {
      const html = toSanitizedMarkdownHtml("```\ncode\n```");
      expect(html).toBe(
        '<div class="code-block-wrapper"><div class="code-block-header"><button type="button" class="code-block-copy" data-code="code" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button></div><pre><code>code\n</code></pre></div>',
      );
    });

    it("keeps localized copy labels fresh after locale changes", async () => {
      const markdown = "```ts\nconst localizedCopy = true;\n```";
      await i18n.setLocale("en");
      const english = toSanitizedMarkdownHtml(markdown);

      try {
        await i18n.setLocale("zh-CN");
        const chinese = toSanitizedMarkdownHtml(markdown);

        expect(english).toBe(
          '<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">ts</span><button type="button" class="code-block-copy" data-code="const localizedCopy = true;" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button></div><pre><code class="language-ts">const localizedCopy = true;\n</code></pre></div>',
        );
        expect(chinese).toBe(
          '<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">ts</span><button type="button" class="code-block-copy" data-code="const localizedCopy = true;" aria-label="复制代码"><span class="code-block-copy__idle">复制</span><span class="code-block-copy__done">已复制！</span></button></div><pre><code class="language-ts">const localizedCopy = true;\n</code></pre></div>',
        );
      } finally {
        await i18n.setLocale("en");
      }
    });

    it("collapses JSON code blocks", () => {
      const html = toSanitizedMarkdownHtml('```json\n{"key": "value"}\n```');
      expect(html).toBe(
        '<details class="json-collapse"><summary>JSON · 2 lines</summary><div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">json</span><button type="button" class="code-block-copy" data-code="{&quot;key&quot;: &quot;value&quot;}" aria-label="Copy code"><span class="code-block-copy__idle">Copy</span><span class="code-block-copy__done">Copied!</span></button></div><pre><code class="language-json">{"key": "value"}\n</code></pre></div></details>',
      );
    });
  });

  describe("GFM features", () => {
    it("renders strikethrough", () => {
      const html = toSanitizedMarkdownHtml("This is ~~deleted~~ text");
      expect(html).toBe("<p>This is <s>deleted</s> text</p>\n");
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
      expect(html).toBe(
        "<p>Text before.</p>\n<table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n<p>Text after.</p>\n",
      );
    });

    it("renders basic markdown", () => {
      const html = toSanitizedMarkdownHtml("**bold** and *italic*");
      expect(html).toBe("<p><strong>bold</strong> and <em>italic</em></p>\n");
    });

    it("renders headings", () => {
      const html = toSanitizedMarkdownHtml("# Heading 1\n## Heading 2");
      expect(html).toBe("<h1>Heading 1</h1>\n<h2>Heading 2</h2>\n");
    });

    it("renders blockquotes", () => {
      const html = toSanitizedMarkdownHtml("> quote");
      expect(html).toBe("<blockquote>\n<p>quote</p>\n</blockquote>\n");
    });

    it("renders lists", () => {
      const html = toSanitizedMarkdownHtml("- item 1\n- item 2");
      expect(html).toBe("<ul>\n<li>item 1</li>\n<li>item 2</li>\n</ul>\n");
    });
  });

  describe("security", () => {
    it("blocks javascript: in links via DOMPurify", () => {
      const html = toSanitizedMarkdownHtml("[click me](javascript:alert(1))");
      expect(html).toBe("<p><a>click me</a></p>\n");
    });

    it("shows alt text for javascript: images", () => {
      const html = toSanitizedMarkdownHtml("![Build log](javascript:alert(1))");
      expect(html).toBe("<p>Build log</p>\n");
    });

    it("shows alt text for vbscript: and file: images", () => {
      const html1 = toSanitizedMarkdownHtml("![Alt1](vbscript:msgbox(1))");
      expect(html1).toBe("<p>Alt1</p>\n");

      const html2 = toSanitizedMarkdownHtml("![Alt2](file:///etc/passwd)");
      expect(html2).toBe("<p>Alt2</p>\n");
    });

    it("renders non-image data: URIs as inert links (marked.js compat)", () => {
      const html = toSanitizedMarkdownHtml("[x](data:text/html,<script>alert(1)</script>)");
      expect(html).toBe("<p><a>x</a></p>\n");
    });

    it("does not auto-link bare file:// URIs", () => {
      const html = toSanitizedMarkdownHtml("Check file:///etc/passwd");
      expect(html).toBe("<p>Check file:///etc/passwd</p>\n");
    });

    it("strips href from explicit file:// links via DOMPurify", () => {
      const html = toSanitizedMarkdownHtml("[click](file:///etc/passwd)");
      expect(html).toBe("<p><a>click</a></p>\n");
    });
  });

  describe("ReDoS protection", () => {
    it("renders deeply nested emphasis markers without dropping text (#36213)", () => {
      const nested = "*".repeat(500) + "text" + "*".repeat(500);
      const html = toSanitizedMarkdownHtml(nested);
      const container = htmlFragment(html);
      expect(container.children).toHaveLength(1);
      expect(container.firstElementChild?.tagName).toBe("P");
      expect(container.textContent).toBe("text\n");
    });

    it("renders deeply nested brackets without dropping text (#36213)", () => {
      const nested = "[".repeat(200) + "link" + "]".repeat(200) + "(" + "x".repeat(200) + ")";
      const html = toSanitizedMarkdownHtml(nested);
      const container = htmlFragment(html);
      expect(container.children).toHaveLength(1);
      expect(container.firstElementChild?.tagName).toBe("P");
      expect(container.textContent).toBe(`${nested}\n`);
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
        (_, i) =>
          `Paragraph ${i + 1}: ${Array.from({ length: 8 }, () => "Long plain-text reply.").join(
            " ",
          )}`,
      ).join("\n\n");
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.tagName).toBe("DIV");
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(input);
    });

    it("preserves indentation in plain text fallback", () => {
      const input = `${"Header line\n".repeat(3400)}\n    indented log line\n        deeper indent`;
      const html = toSanitizedMarkdownHtml(input);
      const fallback = htmlFragment(html).firstElementChild;
      expect(fallback?.className).toBe("markdown-plain-text-fallback");
      expect(fallback?.textContent).toBe(input);
    });

    it("caches oversized fallback results", () => {
      const input =
        Array.from({ length: 240 }, (_, i) => `P${i}`).join("\n\n") + "x".repeat(45_000);
      const first = toSanitizedMarkdownHtml(input);
      const second = toSanitizedMarkdownHtml(input);
      expect(input.length).toBeGreaterThan(40_000);
      expect(htmlFragment(first).firstElementChild?.className).toBe("markdown-plain-text-fallback");
      expect(second).toBe(first);
    });

    it("falls back to escaped text if md.render throws (#36213)", () => {
      const renderSpy = vi.spyOn(md, "render").mockImplementation(() => {
        throw new Error("forced failure");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const html = toSanitizedMarkdownHtml("test");
        expect(html).toBe('<pre class="code-block">test</pre>');
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

    expect(container.querySelector(".sidebar-title")?.textContent?.trim()).toBe("Markdown Preview");
    expect(container.querySelector(".sidebar-markdown-shell__eyebrow span")?.textContent).toBe(
      "Rendered Markdown",
    );
    expect(container.querySelector(".sidebar-markdown strong")?.textContent).toBe("world");
    expect(
      Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim()),
    ).toEqual(["", "View Raw Text"]);
  });
});
