// Shared HTML entity tests cover all agent renderers and tool-argument repair callers.
import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./html.js";

describe("decodeHtmlEntities", () => {
  it("decodes HTML5 named entities beyond the XML subset", () => {
    expect(decodeHtmlEntities("&mdash; &copy; &hellip; &nbsp;")).toBe("— © … \u00a0");
  });

  it("uses exact HTML5 names before the legacy case-insensitive fallback", () => {
    expect(decodeHtmlEntities("&Lt; &Gt; &lT; &gT; &Apos; &aMp;")).toBe("≪ ≫ < > ' &");
  });

  it("decodes decimal and hexadecimal astral entities without truncation", () => {
    expect(decodeHtmlEntities("&#128512; &#x1F600;")).toBe("😀 😀");
  });

  it("keeps direct numeric mapping, single-pass decoding, and invalid scalar references", () => {
    expect(
      decodeHtmlEntities("&#128; &#0; &amp;#39; &#38;mdash; &#xD800; &#55296; &#x110000;"),
    ).toBe("\u0080 \0 &#39; &mdash; &#xD800; &#55296; &#x110000;");
  });
});
