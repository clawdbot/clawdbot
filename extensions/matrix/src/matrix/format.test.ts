import { describe, expect, it } from "vitest";
import { markdownToMatrixHtml, renderMarkdownToMatrixHtmlWithMentions } from "./format.js";

function createMentionClient(selfUserId = "@bot:example.org") {
  return {
    getUserId: async () => selfUserId,
  } as unknown as import("./sdk.js").MatrixClient;
}

describe("markdownToMatrixHtml", () => {
  it("renders basic inline formatting", () => {
    const html = markdownToMatrixHtml("hi _there_ **boss** `code`");
    expect(html).toBe("<p>hi <em>there</em> <strong>boss</strong> <code>code</code></p>");
  });

  it("renders links as HTML", () => {
    const html = markdownToMatrixHtml("see [docs](https://example.com)");
    expect(html).toBe('<p>see <a href="https://example.com">docs</a></p>');
  });

  it("does not auto-link bare file references into external urls", () => {
    const html = markdownToMatrixHtml("Check README.md and backup.sh");
    expect(html).toBe("<p>Check README.md and backup.sh</p>");
  });

  it("keeps real domains linked even when path segments look like filenames", () => {
    const html = markdownToMatrixHtml("See https://docs.example.com/backup.sh");
    expect(html).toBe(
      '<p>See <a href="https://docs.example.com/backup.sh">https://docs.example.com/backup.sh</a></p>',
    );
  });

  it("escapes raw HTML", () => {
    const html = markdownToMatrixHtml("<b>nope</b>");
    expect(html).toBe("<p>&lt;b&gt;nope&lt;/b&gt;</p>");
  });

  it("flattens images into alt text", () => {
    const html = markdownToMatrixHtml("![alt](https://example.com/img.png)");
    expect(html).toBe("<p>alt</p>");
  });

  it("preserves line breaks", () => {
    const html = markdownToMatrixHtml("line1\nline2");
    expect(html).toBe("<p>line1<br>\nline2</p>");
  });

  it("compacts loose ordered lists without paragraph tags", () => {
    const html = markdownToMatrixHtml("1. first\n\n2. second\n\n3. third");
    expect(html).toBe("<ol>\n<li>first</li>\n<li>second</li>\n<li>third</li>\n</ol>");
  });

  it("compacts loose unordered lists without paragraph tags", () => {
    const html = markdownToMatrixHtml("- one\n\n- two\n\n- three");
    expect(html).toBe("<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>");
  });

  it("keeps tight lists unchanged", () => {
    const html = markdownToMatrixHtml("- one\n- two");
    expect(html).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
  });

  it("preserves inline formatting in loose lists", () => {
    const html = markdownToMatrixHtml("1. **bold**\n\n2. _italic_");
    expect(html).toBe("<ol>\n<li><strong>bold</strong></li>\n<li><em>italic</em></li>\n</ol>");
  });

  it("does not strip paragraph tags outside lists", () => {
    const html = markdownToMatrixHtml("Hello\n\nWorld");
    expect(html).toBe("<p>Hello</p>\n<p>World</p>");
  });

  it("compacts nested sublists without paragraph tags", () => {
    const html = markdownToMatrixHtml("1. parent\n\n   - child\n\n2. other");
    expect(html).toBe(
      "<ol>\n<li>parent\n<ul>\n<li>child</li>\n</ul>\n</li>\n<li>other</li>\n</ol>",
    );
  });

  it("compacts loose lists with mentions via renderMarkdownToMatrixHtmlWithMentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "1. hello @alice:example.org\n\n2. bye",
      client: createMentionClient(),
    });
    expect(result.html).toBe(
      '<ol>\n<li>hello <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></li>\n<li>bye</li>\n</ol>',
    );
    expect(result.mentions).toEqual({ user_ids: ["@alice:example.org"] });
  });

  it("preserves paragraph wrappers for multi-paragraph list items", () => {
    const html = markdownToMatrixHtml("1. First sentence.\n\n   Second sentence in the same item.");
    expect(html).toBe(
      "<ol>\n<li>\n<p>First sentence.</p>\n<p>Second sentence in the same item.</p>\n</li>\n</ol>",
    );
  });

  it("renders qualified Matrix user mentions as matrix.to links and m.mentions metadata", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice:example.org",
      client: createMentionClient(),
    });

    expect(result.html).toBe(
      '<p>hello <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a></p>',
    );
    expect(result.mentions).toEqual({
      user_ids: ["@alice:example.org"],
    });
  });

  it("url-encodes matrix.to hrefs for valid mxids with path characters", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @foo/bar:example.org",
      client: createMentionClient(),
    });

    expect(result.html).toBe(
      '<p>hello <a href="https://matrix.to/#/%40foo%2Fbar%3Aexample.org">@foo/bar:example.org</a></p>',
    );
    expect(result.mentions).toEqual({
      user_ids: ["@foo/bar:example.org"],
    });
  });

  it("treats mxids that begin with room as user mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @room:example.org",
      client: createMentionClient(),
    });

    expect(result.html).toBe(
      '<p>hello <a href="https://matrix.to/#/%40room%3Aexample.org">@room:example.org</a></p>',
    );
    expect(result.mentions).toEqual({
      user_ids: ["@room:example.org"],
    });
  });

  it("treats hyphenated room-prefixed mxids as user mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @room-admin:example.org",
      client: createMentionClient(),
    });

    expect(result.html).toBe(
      '<p>hello <a href="https://matrix.to/#/%40room-admin%3Aexample.org">@room-admin:example.org</a></p>',
    );
    expect(result.mentions).toEqual({
      user_ids: ["@room-admin:example.org"],
    });
  });

  it("keeps explicit room mentions as room mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @room",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>hello @room</p>");
    expect(result.mentions).toEqual({
      room: true,
    });
  });

  it("treats sentence-ending room mentions as room mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @room.",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>hello @room.</p>");
    expect(result.mentions).toEqual({
      room: true,
    });
  });

  it("treats colon-suffixed room mentions as room mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @room:",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>hello @room:</p>");
    expect(result.mentions).toEqual({
      room: true,
    });
  });

  it("trims punctuation before storing mentioned user ids", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice:example.org.",
      client: createMentionClient(),
    });

    expect(result.html).toBe(
      '<p>hello <a href="https://matrix.to/#/%40alice%3Aexample.org">@alice:example.org</a>.</p>',
    );
    expect(result.mentions).toEqual({
      user_ids: ["@alice:example.org"],
    });
  });

  it("does not emit mentions for mxid-like tokens with path suffixes", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice:example.org/path",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>hello @alice:example.org/path</p>");
    expect(result.mentions).toStrictEqual({});
  });

  it("accepts bracketed homeservers in matrix mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice:[2001:db8::1]",
      client: createMentionClient(),
    });

    expect(result.html).toBe(
      '<p>hello <a href="https://matrix.to/#/%40alice%3A%5B2001%3Adb8%3A%3A1%5D">@alice:[2001:db8::1]</a></p>',
    );
    expect(result.mentions).toEqual({
      user_ids: ["@alice:[2001:db8::1]"],
    });
  });

  it("accepts bracketed homeservers with ports in matrix mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice:[2001:db8::1]:8448.",
      client: createMentionClient(),
    });

    expect(result.html).toBe(
      '<p>hello <a href="https://matrix.to/#/%40alice%3A%5B2001%3Adb8%3A%3A1%5D%3A8448">@alice:[2001:db8::1]:8448</a>.</p>',
    );
    expect(result.mentions).toEqual({
      user_ids: ["@alice:[2001:db8::1]:8448"],
    });
  });

  it("leaves bare localpart text unmentioned", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "hello @alice",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>hello @alice</p>");
    expect(result.mentions).toStrictEqual({});
  });

  it("does not convert escaped qualified mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "\\@alice:example.org",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>@alice:example.org</p>");
    expect(result.mentions).toStrictEqual({});
  });

  it("does not convert escaped room mentions", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "\\@room",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>@room</p>");
    expect(result.mentions).toStrictEqual({});
  });

  it("keeps escaped mentions literal after escaped backticks", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "\\`literal then \\@alice:example.org",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p>`literal then @alice:example.org</p>");
    expect(result.mentions).toStrictEqual({});
  });

  it("restores escaped mentions in markdown link labels without linking them", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "[\\@alice:example.org](https://example.com)",
      client: createMentionClient(),
    });

    expect(result.html).toBe('<p><a href="https://example.com">@alice:example.org</a></p>');
    expect(result.mentions).toStrictEqual({});
  });

  it("keeps backslashes inside code spans", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "`\\@alice:example.org`",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p><code>\\@alice:example.org</code></p>");
    expect(result.mentions).toStrictEqual({});
  });

  it("does not convert mentions inside code spans", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "`@alice:example.org`",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<p><code>@alice:example.org</code></p>");
    expect(result.mentions).toStrictEqual({});
  });

  it("keeps backslashes inside tilde fenced code blocks", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "~~~\n\\@alice:example.org\n~~~",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<pre><code>\\@alice:example.org\n</code></pre>");
    expect(result.mentions).toStrictEqual({});
  });

  it("keeps backslashes inside indented code blocks", async () => {
    const result = await renderMarkdownToMatrixHtmlWithMentions({
      markdown: "    \\@alice:example.org",
      client: createMentionClient(),
    });

    expect(result.html).toBe("<pre><code>\\@alice:example.org\n</code></pre>");
    expect(result.mentions).toStrictEqual({});
  });
});
