// web_fetch extraction utility tests cover HTML entity decoding.
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, truncateText } from "./web-fetch-utils.js";

describe("web-fetch-utils htmlToMarkdown entity decoding", () => {
  const grin = String.fromCodePoint(0x1f600); // 😀 — an astral (> U+FFFF) code point
  const doubleT = String.fromCodePoint(0x1d54b); // 𝕋 — mathematical double-struck capital T

  it("decodes astral numeric entities via code points instead of truncating to garbage", () => {
    expect(htmlToMarkdown(`<p>I &#128512; this</p>`).text).toBe(`I ${grin} this`);
    expect(htmlToMarkdown(`<p>&#x1F600;</p>`).text).toBe(grin);
    expect(htmlToMarkdown(`<p>&#x1D54B;</p>`).text).toBe(doubleT);
  });

  it("preserves surrogate numeric entities as literal text", () => {
    const highSurrogate = String.fromCharCode(0xd800);

    expect(htmlToMarkdown(`<p>bad &#xD800; end</p>`).text).toBe("bad &#xD800; end");
    expect(htmlToMarkdown(`<p>bad &#55296; end</p>`).text).toBe("bad &#55296; end");
    expect(htmlToMarkdown(`<p>bad &#xDFFF; end</p>`).text).toBe("bad &#xDFFF; end");
    expect(htmlToMarkdown(`<p>bad &#xD800; end</p>`).text).not.toContain(highSurrogate);
  });

  it("decodes &amp; last so an escaped entity is not double-decoded", () => {
    // "&amp;#39;" is the correct HTML encoding of the literal text "&#39;" and must survive intact.
    expect(htmlToMarkdown(`<p>Tom &amp;#39;s pub</p>`).text).toBe("Tom &#39;s pub");
  });

  it("still decodes BMP named and numeric entities", () => {
    expect(htmlToMarkdown(`<p>caf&#233; &amp; tea &lt;b&gt;</p>`).text).toBe("café & tea <b>");
  });

  it("preserves the prior contract: uppercase named entities decode, malformed numeric stays literal", () => {
    // web_fetch historically matched named entities case-insensitively, so
    // uppercase forms must keep decoding rather than leaking through as text.
    expect(htmlToMarkdown(`<p>a &AMP; b</p>`).text).toBe("a & b");
    expect(htmlToMarkdown(`<p>x &QUOT;y&QUOT;</p>`).text).toBe('x "y"');
    // A malformed numeric reference is not an entity and must survive as text,
    // not be consumed by a lenient parseInt (e.g. "&#39x;" must not become "'").
    expect(htmlToMarkdown(`<p>&#39x; end</p>`).text).toBe("&#39x; end");
  });

  it("truncates without splitting a boundary emoji", () => {
    const prefix = "a".repeat(79);
    const result = truncateText(`${prefix}${grin}tail`, 80);

    expect(result.truncated).toBe(true);
    expect(result.text).toBe(prefix);
    expect(result.text).not.toContain(String.fromCharCode(0xd83d));
  });
});
