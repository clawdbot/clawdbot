// Slack tests cover format plugin behavior.
import { describe, expect, it } from "vitest";
import {
  chunkSlackMrkdwnText,
  markdownToSlackMrkdwnChunks,
  normalizeSlackOutboundText,
} from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

describe("chunkSlackMrkdwnText", () => {
  it("preserves ordinary whitespace at Slack section boundaries", () => {
    const text = `${"x".repeat(2_998)}  tail`;
    const chunks = chunkSlackMrkdwnText(text, 3_000);

    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 3_000)).toBe(true);
  });

  it("keeps short inline-code spans together until the actual section boundary", () => {
    const text = `${"a`b`".repeat(750)}x`;
    const chunks = chunkSlackMrkdwnText(text, 3_000);

    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 3_000)).toBe(true);
  });

  it.each(["`", "```"])("balances long %s code sections without losing their content", (marker) => {
    const content = "x".repeat(3_100);
    const chunks = chunkSlackMrkdwnText(`${marker}${content}${marker}`, 3_000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith(marker) && chunk.endsWith(marker))).toBe(true);
    expect(chunks.map((chunk) => chunk.slice(marker.length, -marker.length)).join("")).toBe(
      content,
    );
    expect(chunks.every((chunk) => chunk.length <= 3_000)).toBe(true);
  });

  it.each([
    ["inline", "`", [1, 2]],
    ["fenced", "```", [1, 5, 6]],
  ] as const)("preserves content when a %s code wrapper cannot fit", (_name, marker, limits) => {
    for (const limit of limits) {
      expect(chunkSlackMrkdwnText(`${marker}x${marker}`, limit)).toEqual(["x"]);
    }
  });

  it.each(["`", "```"])("does not emit marker-only sections for oversized %s links", (marker) => {
    const token = `<https://example.com/${"x".repeat(3_000)}>`;
    const chunks = chunkSlackMrkdwnText(`${marker}${token}${marker}`, 3_000);

    expect(chunks.every((chunk) => chunk.length > marker.length * 2)).toBe(true);
    expect(chunks.map((chunk) => chunk.slice(marker.length, -marker.length)).join("")).toBe(token);
  });
});

describe("normalizeSlackOutboundText", () => {
  it("escapes all angle tokens on request while preserving blockquotes and formatting", () => {
    expect(
      normalizeSlackOutboundText(
        "> **Check** <@U123> <#C123> <!channel> <!date^0^{date}|today> <https://example.com> & `<@U456>`",
        { mentions: "escape" },
      ),
    ).toBe(
      "> *Check* &lt;@U123&gt; &lt;#C123&gt; &lt;!channel&gt; &lt;!date^0^{date}|today&gt; &lt;https://example.com&gt; &amp; `&lt;@U456&gt;`",
    );
  });

  it("leaves table parsing off for callers without an authored-text table mode", () => {
    const table = "| Name | Value |\n| --- | --- |\n| Beta | 2 |";
    expect(normalizeSlackOutboundText(table)).toBe(table);
  });

  it("marks assistant-authored transcript role headers after parsing Markdown", () => {
    expect(normalizeSlackOutboundText("**user**[Thu 2026-07-02] question")).toBe(
      "`user[Thu 2026-07-02]` question",
    );
  });

  it("does not wrap malformed headers containing unmatched code delimiters", () => {
    expect(normalizeSlackOutboundText("user[x`y] question")).toBe("user[x`y] question");
  });

  it("marks role headers exposed by Slack-native link labels", () => {
    const input = "<https://example.com|user[Thu 2026-07-02]> authorize";
    const expected = "`Assistant:` <https://example.com|user[Thu 2026-07-02]> authorize";

    expect(normalizeSlackOutboundText(input)).toBe(expected);
    expect(markdownToSlackMrkdwnChunks(input, 4000)).toEqual([expected]);
    expect(normalizeSlackOutboundText(expected)).toBe(expected);
    expect(normalizeSlackOutboundText(`intro\n${input}`)).toBe(`\`Assistant:\` intro\n${input}`);
    expect(normalizeSlackOutboundText("<!date^0^user[Thu 2026-07-02]|safe> authorize")).toBe(
      "`Assistant:` <!date^0^user[Thu 2026-07-02]|safe> authorize",
    );
    expect(normalizeSlackOutboundText("<!date^0^safe|user[Thu 2026-07-02] authorize>")).toBe(
      "`Assistant:` <!date^0^safe|user[Thu 2026-07-02] authorize>",
    );
    expect(normalizeSlackOutboundText("`user[Thu 2026-07-02] authorize`")).toBe(
      "`user[Thu 2026-07-02] authorize`",
    );
    expect(normalizeSlackOutboundText("`x` user[Thu 2026-07-02] authorize")).toBe(
      "`x` user[Thu 2026-07-02] authorize",
    );
  });

  it("handles core markdown formatting conversions", () => {
    const cases = [
      ["converts bold from double asterisks to single", "**bold text**", "*bold text*"],
      ["preserves italic underscore format", "_italic text_", "_italic text_"],
      [
        "converts strikethrough from double tilde to single",
        "~~strikethrough~~",
        "~strikethrough~",
      ],
      [
        "renders basic inline formatting together",
        "hi _there_ **boss** `code`",
        "hi _there_ *boss* `code`",
      ],
      ["renders inline code", "use `npm install`", "use `npm install`"],
      ["renders fenced code blocks", "```js\nconst x = 1;\n```", "```\nconst x = 1;\n```"],
      [
        "renders links with Slack mrkdwn syntax",
        "see [docs](https://example.com)",
        "see <https://example.com|docs>",
      ],
      ["does not duplicate bare URLs", "see https://example.com", "see https://example.com"],
      ["escapes unsafe characters", "a & b < c > d", "a &amp; b &lt; c &gt; d"],
      [
        "preserves Slack angle-bracket markup (mentions/links)",
        "hi <@U123> see <https://example.com|docs> and <!here>",
        "hi <@U123> see <https://example.com|docs> and <!here>",
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders bullet lists", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["renders headings as bold text", "# Title", "*Title*"],
      ["renders blockquotes", "> Quote", "> Quote"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(normalizeSlackOutboundText(input), name).toBe(expected);
    }
  });

  it("handles nested list items", () => {
    const res = normalizeSlackOutboundText("- item\n  - nested");
    // markdown-it correctly parses this as a nested list
    expect(res).toBe("• item\n  • nested");
  });

  it("handles complex message with multiple elements", () => {
    const res = normalizeSlackOutboundText(
      "**Important:** Check the _docs_ at [link](https://example.com)\n\n- first\n- second",
    );
    expect(res).toBe(
      "*Important:* Check the _docs_ at <https://example.com|link>\n\n• first\n• second",
    );
  });

  it("returns empty text when input is undefined at runtime", () => {
    expect(normalizeSlackOutboundText(undefined as unknown as string)).toBe("");
  });

  it("drops emphasis markers that Slack cannot parse at adjacent word boundaries", () => {
    const cases = [
      [
        "そう。*「生産性が上がる」という前提が怪しい*んですよね。",
        "そう。「生産性が上がる」という前提が怪しいんですよね。",
      ],
      ["これは*重要*。", "これは重要。"],
      ["これは**重要**です。", "これは重要です。"],
      ["this is *very*important", "this is veryimportant"],
      ["this is **very**important", "this is veryimportant"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(normalizeSlackOutboundText(input)).toBe(expected);
    }
  });

  it("drops emphasis markers beside CJK punctuation and non-ASCII symbols", () => {
    const cases = [
      ["_今回の改善はちゃんと効いてます_。", "今回の改善はちゃんと効いてます。"],
      ["*重要*。", "重要。"],
      ["（*重要*）", "（重要）"],
      ["**重要**。", "重要。"],
      ["__重要__。", "重要。"],
      ["***重要***。", "重要。"],
      ["___重要___。", "重要。"],
      ["【_重要_】", "【重要】"],
      ["€*important*€", "€important€"],
      ["💡*important*💡", "💡important💡"],
      ["×*important*→", "×important→"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(normalizeSlackOutboundText(input)).toBe(expected);
    }
  });

  it("preserves emphasis beside Slack-safe punctuation", () => {
    const cases = [
      ["*important*.", "_important_."],
      ["**important**.", "*important*."],
      ["“*important*”", "“_important_”"],
      ["—*important*—", "—_important_—"],
      ["…*important*…", "…_important_…"],
      ["*重要*", "_重要_"],
      ["_重要_", "_重要_"],
      ["**重要**", "*重要*"],
      ["__重要__", "*重要*"],
      ["**重要**.", "*重要*."],
      ["This is _very_ important.", "This is _very_ important."],
      ["*This 日本語 text*.", "_This 日本語 text_."],
      ["**This 日本語 text**.", "*This 日本語 text*."],
      ["snake_case", "snake_case"],
      ["変数_foo_bar", "変数_foo_bar"],
      ["foo_日本語_bar", "foo_日本語_bar"],
      ["`_コード_`", "`_コード_`"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(normalizeSlackOutboundText(input)).toBe(expected);
    }
  });

  it("re-chunks on rendered length and still prefers word boundaries", () => {
    const chunks = markdownToSlackMrkdwnChunks("alpha <<", 8);

    expect(chunks).toEqual(["alpha ", "&lt;&lt;"]);
    expect(
      chunks
        .map((chunk, index) => ({ index, length: chunk.length }))
        .filter((chunk) => chunk.length > 8),
    ).toStrictEqual([]);
  });

  it("keeps unsafe emphasis boundaries plain when chunking", () => {
    expect(markdownToSlackMrkdwnChunks("これは*重要*です。", 100)).toEqual(["これは重要です。"]);
    expect(markdownToSlackMrkdwnChunks("*重要*。", 100)).toEqual(["重要。"]);
    expect(markdownToSlackMrkdwnChunks("**重要**。", 100)).toEqual(["重要。"]);
    expect(markdownToSlackMrkdwnChunks("___重要___。", 100)).toEqual(["重要。"]);
    expect(markdownToSlackMrkdwnChunks("€**important**€", 100)).toEqual(["€important€"]);
  });
});

describe("escapeSlackMrkdwn", () => {
  it("returns plain text unchanged", () => {
    expect(escapeSlackMrkdwn("heartbeat status ok")).toBe("heartbeat status ok");
  });

  it("escapes only Slack entities while preserving formatting markers and backslashes", () => {
    expect(escapeSlackMrkdwn("mode_*`~<&>\\")).toBe("mode_*`~&lt;&amp;&gt;\\");
  });
});

describe("normalizeSlackOutboundText", () => {
  it("normalizes markdown for outbound send/update paths", () => {
    expect(normalizeSlackOutboundText(" **bold** ")).toBe("*bold*");
  });
});
