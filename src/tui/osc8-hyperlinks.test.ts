import { describe, expect, it } from "vitest";
import { addOsc8Hyperlinks, extractUrls, wrapOsc8 } from "./osc8-hyperlinks.js";

describe("wrapOsc8", () => {
  it("wraps text with OSC 8 open and close sequences", () => {
    const result = wrapOsc8("https://example.com", "click here");
    expect(result).toBe("\x1b]8;;https://example.com\x07click here\x1b]8;;\x07");
  });

  it("handles empty text", () => {
    const result = wrapOsc8("https://example.com", "");
    expect(result).toBe("\x1b]8;;https://example.com\x07\x1b]8;;\x07");
  });
});

describe("extractUrls", () => {
  it("extracts bare URLs", () => {
    const urls = extractUrls("Check out https://example.com for more info");
    expect(urls).toEqual(["https://example.com"]);
  });

  it("extracts multiple bare URLs", () => {
    const urls = extractUrls("Visit https://foo.com and http://bar.com");
    expect(urls).toContain("https://foo.com");
    expect(urls).toContain("http://bar.com");
    expect(urls).toHaveLength(2);
  });

  it("extracts markdown link hrefs", () => {
    const urls = extractUrls("[Click here](https://example.com/path)");
    expect(urls).toEqual(["https://example.com/path"]);
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
});

describe("addOsc8Hyperlinks", () => {
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

  it("wraps a URL broken across two lines", () => {
    const fullUrl = "https://example.com/very/long/path/to/resource";
    const lines = ["https://example.com/very/long/pa", "th/to/resource"];
    const result = addOsc8Hyperlinks(lines, [fullUrl]);

    // Line 1: fragment should be wrapped with the full URL
    expect(result[0]).toContain(`\x1b]8;;${fullUrl}\x07`);
    // Line 2: continuation should also be wrapped
    expect(result[1]).toContain(`\x1b]8;;${fullUrl}\x07`);
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
