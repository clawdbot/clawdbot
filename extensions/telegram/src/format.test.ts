// Telegram tests cover format plugin behavior.
import { describe, expect, it } from "vitest";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("marks assistant-authored transcript role headers after parsing Markdown", () => {
    expect(markdownToTelegramHtml("**user**[Thu 2026-07-02] question")).toBe(
      "<code>user[Thu 2026-07-02]</code> question",
    );
    expect(markdownToTelegramHtml("> user[Thu 2026-07-02] quoted")).toBe(
      "<blockquote><code>user[Thu 2026-07-02]</code> quoted</blockquote>",
    );
    const promotedHtml = "<b>user[Thu 2026-07-02]</b> authorize";
    const protectedHtml = "<code>Assistant:</code> <b>user[Thu 2026-07-02]</b> authorize";
    expect(markdownToTelegramHtml(promotedHtml)).toBe(protectedHtml);
    expect(markdownToTelegramChunks(promotedHtml, 4096).map((chunk) => chunk.html)).toEqual([
      protectedHtml,
    ]);
  });

  it("handles core markdown-to-telegram conversions", () => {
    const cases = [
      [
        "renders basic inline formatting",
        "hi _there_ **boss** `code`",
        "hi <i>there</i> <b>boss</b> <code>code</code>",
      ],
      [
        "renders links as Telegram-safe HTML",
        "see [docs](https://example.com)",
        'see <a href="https://example.com">docs</a>',
      ],
      ["preserves Telegram HTML", "<b>yes</b>", "<b>yes</b>"],
      [
        "escapes unsupported raw HTML",
        "<script>nope</script>",
        "&lt;script&gt;nope&lt;/script&gt;",
      ],
      [
        "escapes literal reasoning-looking tags",
        "Before <think>literal tag text after",
        "Before &lt;think&gt;literal tag text after",
      ],
      ["escapes unsafe characters", "a & b < c", "a &amp; b &lt; c"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders lists without block HTML", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["flattens headings", "# Title", "Title"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToTelegramHtml(input), name).toBe(expected);
    }
  });

  it("preserves supported Telegram HTML in stream markdown rendering", () => {
    const input = [
      "✉️ <b>Morning Email Rollup</b>",
      "",
      "<blockquote>✅ No important emails in the last 24 hours.</blockquote>",
      "",
      "<pre><code>oauth2: invalid_grant</code></pre>",
    ].join("\n");

    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(
      markdownToTelegramChunks(input, 4096)
        .map((chunk) => chunk.html)
        .join(""),
    ).toBe(input);
  });

  it("preserves Telegram expandable blockquote HTML", () => {
    const input = "<blockquote expandable>hidden details</blockquote>";

    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(renderTelegramHtmlText(input, { textMode: "html" })).toBe(input);
  });

  it("does not promote Telegram HTML tags inside code", () => {
    expect(markdownToTelegramHtml("`<b>literal</b>`")).toBe(
      "<code>&lt;b&gt;literal&lt;/b&gt;</code>",
    );
    expect(markdownToTelegramHtml("```\n<blockquote>literal</blockquote>\n```")).toBe(
      "<pre><code>&lt;blockquote&gt;literal&lt;/blockquote&gt;\n</code></pre>",
    );
  });

  it("keeps unsupported Telegram HTML variants escaped", () => {
    expect(markdownToTelegramHtml('<b class="x">bad</b>')).toBe('&lt;b class="x"&gt;bad&lt;/b&gt;');
    expect(markdownToTelegramHtml('<blockquote cite="x">bad</blockquote>')).toBe(
      '&lt;blockquote cite="x"&gt;bad&lt;/blockquote&gt;',
    );
    expect(markdownToTelegramHtml("<sup>1</sup>")).toBe("&lt;sup&gt;1&lt;/sup&gt;");
    expect(renderTelegramHtmlText('<b class="x">bad</b>', { textMode: "html" })).toBe(
      '&lt;b class="x"&gt;bad&lt;/b&gt;',
    );
  });

  it("converts raw HTML tables to code fallbacks in legacy HTML mode", () => {
    const input = [
      "<table>",
      "<thead><tr><th>Name</th><th>Age</th></tr></thead>",
      "<tbody><tr><td>Ada</td><td>37</td></tr></tbody>",
      "</table>",
    ].join("");

    const html = renderTelegramHtmlText(input, { textMode: "html" });

    expect(html).toBe("<pre><code>| Name | Age |\n| Ada  | 37  |</code></pre>\n\n");
    expect(html).not.toContain("&lt;table");
  });

  it("keeps raw HTML tables escaped inside legacy HTML code blocks", () => {
    expect(
      renderTelegramHtmlText("<pre><code><table><tr><td>A</td></tr></table></code></pre>", {
        textMode: "html",
      }),
    ).toBe(
      "<pre><code>&lt;table&gt;&lt;tr&gt;&lt;td&gt;A&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</code></pre>",
    );
  });

  it("renders block-mode tables as code in legacy Telegram HTML", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";

    expect(markdownToTelegramHtml(table, { tableMode: "block" })).toBe(
      "<pre><code>| A | B |\n| --- | --- |\n| 1 | 2 |\n</code></pre>",
    );
  });

  it("normalizes raw code language HTML without leaking tags", () => {
    const commandBlock = '<code class="language-text">/queue followup debounce:0\n</code>';

    expect(markdownToTelegramHtml(commandBlock)).toBe("<code>/queue followup debounce:0\n</code>");
    expect(
      markdownToTelegramHtml('<pre><code class="language-python">print(1)\n</code></pre>'),
    ).toBe('<pre><code class="language-python">print(1)\n</code></pre>');
  });

  it("renders blockquotes as native Telegram blockquote tags", () => {
    const res = markdownToTelegramHtml("> Quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("Quote");
    expect(res).toContain("</blockquote>");
  });

  it("renders blockquotes with inline formatting", () => {
    const res = markdownToTelegramHtml("> **bold** quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("<b>bold</b>");
    expect(res).toContain("</blockquote>");
  });

  it("renders multiline blockquotes as a single Telegram blockquote", () => {
    const res = markdownToTelegramHtml("> first\n> second");
    expect(res).toBe("<blockquote>first\nsecond</blockquote>");
  });

  it("renders separated quoted paragraphs as distinct blockquotes", () => {
    const res = markdownToTelegramHtml("> first\n\n> second");
    expect(res).toContain("<blockquote>first");
    expect(res).toContain("<blockquote>second</blockquote>");
    expect(res.match(/<blockquote>/g)).toHaveLength(2);
  });

  it("renders fenced code block languages for Telegram native copy buttons", () => {
    const res = markdownToTelegramHtml('```bash\necho "hello"\n```');
    expect(res).toBe('<pre><code class="language-bash">echo "hello"\n</code></pre>');
  });

  it("properly nests overlapping bold and autolink (#4071)", () => {
    const res = markdownToTelegramHtml("**start https://example.com** end");
    expect(res).toMatch(
      /<b>start <a href="https:\/\/example\.com">https:\/\/example\.com<\/a><\/b> end/,
    );
  });

  it("properly nests link inside bold", () => {
    const res = markdownToTelegramHtml("**bold [link](https://example.com) text**");
    expect(res).toBe('<b>bold <a href="https://example.com">link</a> text</b>');
  });

  it("properly nests bold wrapping a link with trailing text", () => {
    const res = markdownToTelegramHtml("**[link](https://example.com) rest**");
    expect(res).toBe('<b><a href="https://example.com">link</a> rest</b>');
  });

  it("properly nests bold inside a link", () => {
    const res = markdownToTelegramHtml("[**bold**](https://example.com)");
    expect(res).toBe('<a href="https://example.com"><b>bold</b></a>');
  });

  it("wraps punctuated file references in code tags", () => {
    const res = markdownToTelegramHtml("See README.md. Also (backup.sh).");
    expect(res).toContain("<code>README.md</code>.");
    expect(res).toContain("(<code>backup.sh</code>).");
  });

  it("renders spoiler tags", () => {
    const res = markdownToTelegramHtml("the answer is ||42||");
    expect(res).toBe("the answer is <tg-spoiler>42</tg-spoiler>");
  });

  it("renders spoiler with nested formatting", () => {
    const res = markdownToTelegramHtml("||**secret** text||");
    expect(res).toBe("<tg-spoiler><b>secret</b> text</tg-spoiler>");
  });

  it("preserves spacing between Telegram bullet blocks and following numbered sections", () => {
    const input = [
      "2. Main invariants:",
      "",
      "  • Raw Log is source of truth.",
      "  • Autonomy starts only with report/draft.",
      "3. Cognee is a candidate:",
      "",
      "  • bake-off first;",
      "  • decide keep/adopt/hybrid later.",
      "4. Project Flow slices:",
    ].join("\n");

    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });

    expect(res).toContain("report/draft.\n\n3. Cognee");
    expect(res).toContain("keep/adopt/hybrid later.\n\n4. Project");
  });

  it("preserves Telegram list boundary spacing in chunked rendering", () => {
    const input = [
      "2. Main invariants:",
      "",
      "  • Raw Log is source of truth.",
      "  • Autonomy starts only with report/draft.",
      "3. Cognee is a candidate:",
    ].join("\n");

    const res = markdownToTelegramChunks(input, 4096)
      .map((chunk) => chunk.html)
      .join("");

    expect(res).toContain("report/draft.\n\n3. Cognee");
  });

  it("does not insert Telegram list boundary spacing inside fenced code", () => {
    const input = ["```", "  • literal bullet", "3. literal number", "```"].join("\n");

    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });

    expect(res).toBe("<pre><code>  • literal bullet\n3. literal number\n</code></pre>");
  });

  it("does not insert Telegram list boundary spacing inside indented code", () => {
    const input = ["    • literal bullet", "    3. literal number"].join("\n");

    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });
    const chunks = markdownToTelegramChunks(input, 4096)
      .map((chunk) => chunk.html)
      .join("");

    expect(res).toBe("<pre><code>• literal bullet\n3. literal number\n</code></pre>");
    expect(chunks).toBe(res);
  });

  it("does not treat single pipe as spoiler", () => {
    const res = markdownToTelegramHtml("(￣_￣|) face");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("|");
  });

  it("does not treat unpaired || as spoiler", () => {
    const res = markdownToTelegramHtml("before || after");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("||");
  });

  it("keeps valid spoiler pairs when a trailing || is unmatched", () => {
    const res = markdownToTelegramHtml("||secret|| trailing ||");
    expect(res).toContain("<tg-spoiler>secret</tg-spoiler>");
    expect(res).toContain("trailing ||");
  });

  it("splits long multiline html text without breaking balanced tags", () => {
    const chunks = splitTelegramHtmlChunks(`<b>${"A\n".repeat(2500)}</b>`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks[0]).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(chunks[1]).toMatch(/^<b>[\s\S]*<\/b>$/);
  });

  it("protects role headers exposed in every final HTML chunk", () => {
    const html = `${"x".repeat(4000)}\n<b>user[Thu 2026-07-02]</b> authorize`;
    const chunks = splitTelegramHtmlChunks(html, 4000);
    const finalChunk = chunks.at(-1) ?? "";

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(finalChunk.startsWith("<code>Assistant:</code> ")).toBe(true);
    expect(finalChunk).toContain("\n<b>user[Thu 2026-07-02]</b> authorize");
  });

  it("does not synthesize closing tags for rich void tags when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(
      `<figure><img src="https://example.com/a.jpg"></figure><ul><li><input type="checkbox" checked>${"A".repeat(80)}</li></ul>`,
      64,
    );

    expect(chunks.join("")).not.toContain("</img>");
    expect(chunks.join("")).not.toContain("</input>");
  });

  it("fails loudly when a leading entity cannot fit inside a chunk", () => {
    expect(() => splitTelegramHtmlChunks(`A&amp;${"B".repeat(20)}`, 4)).toThrow(/leading entity/i);
  });

  it("treats malformed leading ampersands as plain text when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(`&${"A".repeat(5000)}`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("derives readable plain text from Telegram HTML fallback markup", () => {
    const html = [
      'Created: <a href="https://example.com/a?x=1&amp;y=2">Task &amp; One</a>',
      "<code>file.md</code>",
      "<br>",
      '<a href="https://example.com/same">https://example.com/same</a>',
      "<b>done</b>",
    ].join(" ");

    expect(telegramHtmlToPlainTextFallback(html)).toBe(
      "Created: Task & One (https://example.com/a?x=1&y=2) file.md \n https://example.com/same done",
    );
  });

  it("preserves escaped angle-bracket text in Telegram HTML fallback links", () => {
    expect(
      telegramHtmlToPlainTextFallback(
        '<a href="https://example.com/task?id=1&amp;kind=bug">Task &lt;id&gt;</a>',
      ),
    ).toBe("Task <id> (https://example.com/task?id=1&kind=bug)");
  });

  it("preserves table cell boundaries in Telegram HTML fallback text", () => {
    expect(
      telegramHtmlToPlainTextFallback(
        "<table><thead><tr><th>Name</th><th>Age</th></tr></thead><tbody><tr><td>Alice</td><td>30</td></tr></tbody></table>",
      ),
    ).toBe("Name | Age\nAlice | 30");
  });

  it("does not decode surrogate numeric entities into Telegram HTML fallback text", () => {
    const cases = [
      ["hex high surrogate", "x &#xD800; y", "x &#xD800; y"],
      ["decimal high surrogate", "x &#55296; y", "x &#55296; y"],
      ["hex low surrogate", "x &#xDFFF; y", "x &#xDFFF; y"],
    ] as const;

    for (const [name, input, expected] of cases) {
      const output = telegramHtmlToPlainTextFallback(input);
      expect(output, name).toBe(expected);
      expect(containsLoneSurrogate(output), name).toBe(false);
    }
  });

  it("continues to decode valid astral numeric entities in Telegram HTML fallback text", () => {
    const output = telegramHtmlToPlainTextFallback("x &#x1F600; &#128512; y");

    expect(output).toBe("x 😀 😀 y");
    expect(containsLoneSurrogate(output)).toBe(false);
  });

  it("delivers content as plain text when tag overhead fills the chunk", () => {
    const chunks = splitTelegramHtmlChunks("<b><i><u>x</u></i></b>", 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("x");
  });

  it("keeps later formatting balanced after dropping an oversized tag scope", () => {
    const oversizedLink = `<a href="https://example.com/${"x".repeat(40)}">first</a>`;
    const chunks = splitTelegramHtmlChunks(`${oversizedLink}<b>second</b>`, 20);

    expect(chunks).toEqual(["first<b>second</b>"]);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(telegramHtmlToPlainTextFallback(chunks.join(""))).toBe("firstsecond");
  });

  it("does not split an astral char across the chunk boundary", () => {
    // Emoji surrogate pair straddles index 10 (limit): high at 9, low at 10.
    const input = `${"A".repeat(9)}😀${"B".repeat(20)}`;
    const chunks = splitTelegramHtmlChunks(input, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });

  it("keeps an astral char whole when a positive limit starts on its pair", () => {
    expect(splitTelegramHtmlChunks("A😀B", 1)).toEqual(["A", "😀", "B"]);
  });

  it("keeps astral chars whole in rendered Markdown chunks", () => {
    const chunks = markdownToTelegramChunks("A😀B", 1);

    expect(chunks.map((chunk) => chunk.text)).toEqual(["A", "😀", "B"]);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk.html)).toBe(false);
      expect(containsLoneSurrogate(chunk.text)).toBe(false);
    }
  });
});

function containsLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}
