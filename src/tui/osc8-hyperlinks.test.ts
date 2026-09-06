// Verifies OSC8 hyperlink formatting for TUI terminal output.
import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { addOsc8Hyperlinks, extractUrls } from "./osc8-hyperlinks.js";

describe("extractUrls", () => {
  it("extracts bare URLs", () => {
    const urls = extractUrls("Check out https://example.com for more info");
    expect(urls).toEqual(["https://example.com"]);
  });

  it.each([".", ",", ";", "!", "?", ":", "*", "_", "~", ".?!"])(
    "excludes trailing GFM punctuation %s from bare URLs",
    (punctuation) => {
      expect(extractUrls(`Visit https://example.com/path${punctuation}`)).toEqual([
        "https://example.com/path",
      ]);
    },
  );

  it("stops bare URLs before bidi formatting controls", () => {
    const url = "https://example.com/path";
    expect(extractUrls(`مرحبا ${url}\u2069`)).toEqual([url]);
    expect(extractUrls(`مرحبا ${url}\u200f`)).toEqual([url]);
  });

  it("extracts multiple bare URLs", () => {
    const urls = extractUrls("Visit https://foo.com and http://bar.com");
    expect(urls).toContain("https://foo.com");
    expect(urls).toContain("http://bar.com");
    expect(urls).toHaveLength(2);
  });

  it.each(["", ".", "?", ";"])("preserves authored markdown href suffix %s", (suffix) => {
    const url = `https://example.com/path${suffix}`;
    expect(extractUrls(`[Click here](${url})`)).toEqual([url]);
  });

  it("extracts markdown links with angle brackets and title text", () => {
    const urls = extractUrls('[Click here](<https://example.com/path> "Example Title")');
    expect(urls).toEqual(["https://example.com/path"]);
  });

  it("extracts both bare URLs and markdown links", () => {
    const md = "See [docs](https://docs.example.com) and https://api.example.com";
    const urls = extractUrls(md);
    expect(urls).toContain("https://docs.example.com");
    expect(urls).toContain("https://api.example.com");
    expect(urls).toHaveLength(2);
  });

  it("deduplicates URLs", () => {
    const md = "Visit https://example.com and [link](https://example.com)";
    const urls = extractUrls(md);
    expect(urls).toEqual(["https://example.com"]);
  });

  it("returns empty array for text without URLs", () => {
    expect(extractUrls("No links here")).toStrictEqual([]);
  });

  it("handles URLs with query params and fragments", () => {
    const urls = extractUrls("https://example.com/path?q=1&r=2#section");
    expect(urls).toEqual(["https://example.com/path?q=1&r=2#section"]);
  });

  it("extracts a bare URL with a bracketed IPv6 authority", () => {
    const url = "http://[::1]:8080/path";
    expect(extractUrls(url)).toEqual([url]);
  });

  it("extracts markdown link hrefs with parentheses in the URL", () => {
    const url = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
    expect(extractUrls(`[Wikipedia](${url})`)).toEqual([url]);
  });

  it("keeps balanced URL parentheses and internal query punctuation", () => {
    const url = "https://example.com/v1.0/URL_(disambiguation)?a=1&b=2#section";
    expect(extractUrls(`Visit ${url}.`)).toEqual([url]);
  });

  it("does not extract an incomplete markdown link destination", () => {
    expect(extractUrls("[broken](https://)")).toEqual([]);
  });

  it.each(["[broken](https://.)", "https://.", "https:///path"])(
    "does not extract a URL without a real authority from %s",
    (text) => {
      expect(extractUrls(text)).toEqual([]);
    },
  );

  it("handles bare URLs with trailing closing paren as punctuation", () => {
    const urls = extractUrls("(see https://example.com/path)");
    expect(urls).toEqual(["https://example.com/path"]);
  });

  it("drops punctuation after an unmatched closing paren", () => {
    const urls = extractUrls("(see https://example.com/path).");
    expect(urls).toEqual(["https://example.com/path"]);
  });

  it("handles markdown link with angle brackets and parenthetical URL", () => {
    const url = "https://en.wikipedia.org/wiki/Special_(film)";
    expect(extractUrls(`[link](<${url}>)`)).toEqual([url]);
  });
});

describe("addOsc8Hyperlinks", () => {
  it.each([
    { name: "BEL", params: "", terminator: "\x07" },
    { name: "ST with link identity", params: "id=docs", terminator: "\x1b\\" },
  ])("preserves authored spans alongside unlinked URLs ($name)", ({ params, terminator }) => {
    const label = "https://example.test/label";
    const target = "https://example.test/destination";
    const bare = "https://example.test/bare";
    const prefix = "See ";
    const authored = `\x1b]8;${params};${target}${terminator}\x1b[32m${label}\x1b[0m\x1b]8;;${terminator}`;
    const line = `${prefix}${authored} then ${bare}`;

    const [rendered] = addOsc8Hyperlinks([line], [target, bare]);

    expect(rendered).toContain(authored);
    expect(getOsc8LinkAtColumn(rendered!, prefix.length)).toBe(target);
    expect(getOsc8LinkAtColumn(rendered!, prefix.length + label.length)).toBeUndefined();
    expect(getOsc8LinkAtColumn(rendered!, prefix.length + label.length + " then ".length)).toBe(
      bare,
    );
  });

  it("returns lines unchanged when no URLs", () => {
    const lines = ["Hello world", "No links here"];
    expect(addOsc8Hyperlinks(lines, [])).toEqual(lines);
  });

  it("wraps a single-line URL with OSC 8", () => {
    const url = "https://example.com";
    const lines = [`Visit ${url} for info`];
    const result = addOsc8Hyperlinks(lines, [url]);

    expect(result[0]).toContain(`\x1b]8;;${url}\x07`);
    expect(result[0]).toContain(`\x1b]8;;\x07`);
    // The URL text should be between open and close
    expect(result[0]).toBe(`Visit \x1b]8;;${url}\x07${url}\x1b]8;;\x07 for info`);
  });

  it.each([".", ",", ";", "!", "?", ":", "*", "_", "~", ".?!"])(
    "keeps trailing GFM punctuation %s outside terminal hyperlink targets",
    (punctuation) => {
      const url = "https://example.com/path";
      const line = `Visit ${url}${punctuation}`;

      expect(addOsc8Hyperlinks([line], extractUrls(line))).toEqual([
        `Visit \x1b]8;;${url}\x07${url}\x1b]8;;\x07${punctuation}`,
      ]);
    },
  );

  it("preserves punctuation explicitly authored in markdown hyperlink targets", () => {
    const url = "https://example.com/path.";
    const line = `Docs (${url})`;

    expect(addOsc8Hyperlinks([line], extractUrls(`[Docs](${url})`))).toEqual([
      `Docs (\x1b]8;;${url}\x07${url}\x1b]8;;\x07)`,
    ]);
  });

  it.each([".", ","])(
    "keeps authored and bare hyperlink occurrences distinct before %s",
    (punctuation) => {
      const bareUrl = "https://example.com/path";
      const authoredUrl = `${bareUrl}${punctuation}`;
      const markdown = `[Docs](${authoredUrl}) and ${bareUrl}${punctuation}`;
      const rendered = `Docs (${authoredUrl}) and ${bareUrl}${punctuation}`;

      expect(addOsc8Hyperlinks([rendered], extractUrls(markdown))).toEqual([
        `Docs (\x1b]8;;${authoredUrl}\x07${authoredUrl}\x1b]8;;\x07) and \x1b]8;;${bareUrl}\x07${bareUrl}\x1b]8;;\x07${punctuation}`,
      ]);
    },
  );

  it("keeps bidi isolation outside the exact OSC 8 target", () => {
    const url = "https://example.com/path";
    expect(addOsc8Hyperlinks([`\u2067مرحبا ${url}\u2069`], [url])).toEqual([
      `\u2067مرحبا \x1b]8;;${url}\x07${url}\x1b]8;;\x07\u2069`,
    ]);
  });

  it("wraps a URL broken across two lines", () => {
    const fullUrl = "https://example.com/very/long/path/to/resource";
    const lines = ["https://example.com/very/long/pa", "th/to/resource"];
    const result = addOsc8Hyperlinks(lines, [fullUrl]);

    // Line 1: fragment should be wrapped with the full URL
    expect(result[0]).toContain(`\x1b]8;;${fullUrl}\x07`);
    // Line 2: continuation should also be wrapped
    expect(result[1]).toContain(`\x1b]8;;${fullUrl}\x07`);
  });

  it("wraps a URL with a bracketed IPv6 authority", () => {
    const url = "http://[::1]:8080/path";
    expect(addOsc8Hyperlinks([url], [url])).toEqual([`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`]);
  });

  it("wraps a URL broken immediately after its scheme", () => {
    const fullUrl = "https://example.com/path";
    const result = addOsc8Hyperlinks(["https://", "example.com/path"], [fullUrl]);

    expect(result[0]).toBe(`\x1b]8;;${fullUrl}\x07https://\x1b]8;;\x07`);
    expect(result[1]).toBe(`\x1b]8;;${fullUrl}\x07example.com/path\x1b]8;;\x07`);
  });

  it("does not cross-link a scheme-only fragment to a partial domain match", () => {
    const result = addOsc8Hyperlinks(["https://", "example.org"], ["https://example.com"]);

    expect(result).toEqual(["https://", "example.org"]);
  });

  it("does not cross-link a scheme-only fragment to a longer URL token", () => {
    const result = addOsc8Hyperlinks(
      ["https://", "example.com/pathology"],
      ["https://example.com/path"],
    );

    expect(result).toEqual(["https://", "example.com/pathology"]);
  });

  it("does not recover a punctuated incomplete URL as a wrapped URL", () => {
    const result = addOsc8Hyperlinks(["broken (https://)", "example.com"], ["https://example.com"]);

    expect(result).toEqual(["broken (https://)", "example.com"]);
  });

  it("does not wrap a punctuation-only URL body", () => {
    expect(addOsc8Hyperlinks(["https://."], ["https://."])).toEqual(["https://."]);
  });

  it("handles URL with ANSI styling codes", () => {
    const url = "https://example.com";
    // Simulate styled text: green URL
    const styledLine = `\x1b[32m${url}\x1b[0m`;
    const result = addOsc8Hyperlinks([styledLine], [url]);

    // Should preserve ANSI codes and add OSC 8 around the visible URL
    expect(result[0]).toContain("\x1b[32m");
    expect(result[0]).toContain("\x1b[0m");
    expect(result[0]).toContain(`\x1b]8;;${url}\x07`);
    expect(result[0]).toContain(`\x1b]8;;\x07`);
  });

  it("handles named link rendered as text (url)", () => {
    const url = "https://github.com/org/repo";
    // pi-tui renders [text](url) as "text (url)"
    const line = `Click here (${url})`;
    const result = addOsc8Hyperlinks([line], [url]);

    // The URL part should be wrapped with OSC 8
    expect(result[0]).toContain(`\x1b]8;;${url}\x07`);
  });

  it("handles multiple URLs on the same line", () => {
    const url1 = "https://foo.com";
    const url2 = "https://bar.com";
    const line = `${url1} and ${url2}`;
    const result = addOsc8Hyperlinks([line], [url1, url2]);

    expect(result[0]).toContain(`\x1b]8;;${url1}\x07`);
    expect(result[0]).toContain(`\x1b]8;;${url2}\x07`);
  });

  it("does not modify lines without URL text", () => {
    const url = "https://example.com";
    const lines = ["Just some text", "No URLs here"];
    const result = addOsc8Hyperlinks(lines, [url]);

    expect(result).toEqual(lines);
  });

  it("prefers the longest known URL when a fragment matches multiple prefixes", () => {
    const short = "https://example.com/api/v2/users";
    const long = "https://example.com/api/v2/users/list";
    const fragment = "https://example.com/api/v2/u";
    const result = addOsc8Hyperlinks([fragment], [short, long]);
    expect(result[0]).toContain(`\x1b]8;;${long}\x07${fragment}\x1b]8;;\x07`);
  });

  it("wraps URLs with parentheses in markdown rendered text", () => {
    const url = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
    const line = `Wikipedia (${url})`;
    const result = addOsc8Hyperlinks([line], [url]);
    expect(result[0]).toBe(`Wikipedia (\x1b]8;;${url}\x07${url}\x1b]8;;\x07)`);
  });

  it("does not resolve an incomplete URL to another known URL", () => {
    const url = "https://example.com";
    const result = addOsc8Hyperlinks(["broken (https://)", url], [url]);
    expect(result[0]).toBe("broken (https://)");
    expect(result[1]).toContain(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
  });

  it("handles URL split across three lines", () => {
    const fullUrl = "https://example.com/a/very/long/path/that/keeps/going/and/going";
    const lines = ["https://example.com/a/very/lon", "g/path/that/keeps/going/and/g", "oing"];
    const result = addOsc8Hyperlinks(lines, [fullUrl]);

    // All three lines should have OSC 8 wrapping
    for (const line of result) {
      expect(line).toContain(`\x1b]8;;${fullUrl}\x07`);
      expect(line).toContain(`\x1b]8;;\x07`);
    }
  });
});
