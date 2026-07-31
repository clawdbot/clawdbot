// Firecrawl tests cover firecrawl client behavior — URL safety,
// scrape payload parsing, and search-item extraction.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let firecrawlClient: typeof import("./firecrawl-client.js").testing;

function requireSearchResult<T>(results: readonly T[], index: number): T {
  return expectDefined(results[index], `firecrawl search result ${index}`);
}

beforeAll(async () => {
  firecrawlClient = (
    await vi.importActual<typeof import("./firecrawl-client.js")>("./firecrawl-client.js")
  ).testing;
});

afterAll(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// assertFirecrawlScrapeTargetAllowed
// ---------------------------------------------------------------------------
describe("assertFirecrawlScrapeTargetAllowed", () => {
  it("allows valid public HTTPS URLs", () => {
    expect(() =>
      firecrawlClient.assertFirecrawlScrapeTargetAllowed("https://example.com/page"),
    ).not.toThrow();
    expect(() =>
      firecrawlClient.assertFirecrawlScrapeTargetAllowed("https://api.firecrawl.dev/v1/scrape"),
    ).not.toThrow();
  });

  it("rejects invalid URL strings", () => {
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("not a url")).toThrow(
      "Invalid URL",
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("")).toThrow("Invalid URL");
  });

  it("rejects non-HTTP(S) protocols", () => {
    expect(() =>
      firecrawlClient.assertFirecrawlScrapeTargetAllowed("ftp://example.com/file"),
    ).toThrow(/Blocked non-HTTP\(S\) protocol/);
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("file:///etc/passwd")).toThrow(
      /Blocked non-HTTP\(S\) protocol/,
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("data:text/html,<x>")).toThrow(
      /Blocked non-HTTP\(S\) protocol/,
    );
  });

  it("rejects private and loopback IP addresses", () => {
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://127.0.0.1")).toThrow(
      /Blocked/,
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://10.0.0.1")).toThrow(
      /Blocked/,
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://192.168.1.1")).toThrow(
      /Blocked/,
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://172.16.0.1")).toThrow(
      /Blocked/,
    );
  });

  it("rejects blocked hostnames like localhost", () => {
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://localhost")).toThrow(
      /Blocked/,
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://LOCALHOST")).toThrow(
      /Blocked/,
    );
  });

  it("allows HTTP URLs to public hosts (SSRF check targets the hostname, not the scheme)", () => {
    // Plain HTTP to a public hostname is not blocked here — the SSRF
    // layer resolves the hostname to decide if it targets a private network.
    expect(() =>
      firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://example.com"),
    ).not.toThrow();
  });

  it("rejects IPv6 loopback and private addresses", () => {
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://[::1]")).toThrow(
      /Blocked/,
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("https://[::1]")).toThrow(
      /Blocked/,
    );
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://[fc00::]")).toThrow(
      /Blocked/,
    );
  });

  it("rejects URL with embedded credentials targeting a blocked host", () => {
    // Credentials in the URL do not bypass the hostname/IP check.
    expect(() =>
      firecrawlClient.assertFirecrawlScrapeTargetAllowed("http://user:pass@127.0.0.1"),
    ).toThrow(/Blocked/);
  });

  it("rejects bare hostname strings without a scheme as invalid", () => {
    expect(() => firecrawlClient.assertFirecrawlScrapeTargetAllowed("example.com")).toThrow(
      "Invalid URL",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveSearchItems
// ---------------------------------------------------------------------------
describe("resolveSearchItems", () => {
  it("extracts items from a top-level data array (Firecrawl Search API)", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://example.com", title: "Example" },
        { url: "https://openclaw.ai", title: "OpenClaw" },
      ],
    });

    expect(result).toHaveLength(2);
    expect(requireSearchResult(result, 0)).toMatchObject({
      url: "https://example.com",
      title: "Example",
    });
    expect(requireSearchResult(result, 1)).toMatchObject({
      url: "https://openclaw.ai",
      title: "OpenClaw",
    });
  });

  it("extracts items from a results array", () => {
    const result = firecrawlClient.resolveSearchItems({
      results: [{ url: "https://example.org", title: "Org" }],
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).url).toBe("https://example.org");
    expect(requireSearchResult(result, 0).title).toBe("Org");
  });

  it("extracts items from data.results (nested)", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: {
        results: [
          { url: "https://example.com/a", title: "A" },
          { url: "https://example.com/b", title: "B" },
        ],
      },
    });

    expect(result).toHaveLength(2);
  });

  it("extracts items from data.data (doubly nested)", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: {
        data: [{ url: "https://example.com/nested", title: "Nested" }],
      },
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).url).toBe("https://example.com/nested");
  });

  it("extracts items from data.web array (Firecrawl web search format)", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: {
        web: [{ url: "https://example.com/web", title: "Web Result" }],
      },
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).url).toBe("https://example.com/web");
    expect(requireSearchResult(result, 0).title).toBe("Web Result");
  });

  it("extracts items from web.results (top-level)", () => {
    const result = firecrawlClient.resolveSearchItems({
      web: {
        results: [{ url: "https://example.com/top-web", title: "Top Web" }],
      },
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).url).toBe("https://example.com/top-web");
  });

  it("returns an empty array when no search items are present", () => {
    expect(firecrawlClient.resolveSearchItems({})).toEqual([]);
    expect(firecrawlClient.resolveSearchItems({ data: "not-an-array" })).toEqual([]);
    expect(firecrawlClient.resolveSearchItems({ data: [] })).toEqual([]);
    expect(firecrawlClient.resolveSearchItems({ data: { items: [] } })).toEqual([]);
  });

  it("skips entries without a resolvable URL", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://example.com/ok", title: "OK" },
        { title: "No URL" },
        {},
        null,
        "string entry",
        42,
      ],
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).title).toBe("OK");
  });

  it("resolves URL from alternate fields: sourceURL, sourceUrl, metadata.sourceURL", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://a.com", title: "A" },
        { sourceURL: "https://b.com", title: "B" },
        { sourceUrl: "https://c.com", title: "C" },
        { metadata: { sourceURL: "https://d.com" }, title: "D" },
      ],
    });

    expect(result).toHaveLength(4);
    expect(result.map((r) => r.url)).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
      "https://d.com",
    ]);
  });

  it("reads description from multiple possible fields", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://a.com", description: "explicit desc" },
        { url: "https://b.com", snippet: "snippet text" },
        { url: "https://c.com", summary: "summary text" },
      ],
    });

    expect(requireSearchResult(result, 0).description).toBe("explicit desc");
    expect(requireSearchResult(result, 1).description).toBe("snippet text");
    expect(requireSearchResult(result, 2).description).toBe("summary text");
  });

  it("reads content from multiple possible fields", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://a.com", markdown: "# md" },
        { url: "https://b.com", content: "plain content" },
        { url: "https://c.com", text: "raw text" },
      ],
    });

    expect(requireSearchResult(result, 0).content).toBe("# md");
    expect(requireSearchResult(result, 1).content).toBe("plain content");
    expect(requireSearchResult(result, 2).content).toBe("raw text");
  });

  it("reads published date from multiple possible fields", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://a.com", publishedDate: "2025-01-01" },
        { url: "https://b.com", published: "2025-02-02" },
        { url: "https://c.com", metadata: { publishedTime: "2025-03-03" } },
        { url: "https://d.com", metadata: { publishedDate: "2025-04-04" } },
      ],
    });

    expect(requireSearchResult(result, 0).published).toBe("2025-01-01");
    expect(requireSearchResult(result, 1).published).toBe("2025-02-02");
    expect(requireSearchResult(result, 2).published).toBe("2025-03-03");
    expect(requireSearchResult(result, 3).published).toBe("2025-04-04");
  });

  it("resolves siteName by stripping www. prefix from URL hostname", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://www.example.com/page", title: "WWW" },
        { url: "https://example.org", title: "No WWW" },
      ],
    });

    expect(requireSearchResult(result, 0).siteName).toBe("example.com");
    expect(requireSearchResult(result, 1).siteName).toBe("example.org");
  });

  it("sets description and content to undefined when absent", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [{ url: "https://example.com", title: "Minimal" }],
    });

    expect(requireSearchResult(result, 0).description).toBeUndefined();
    expect(requireSearchResult(result, 0).content).toBeUndefined();
    expect(requireSearchResult(result, 0).published).toBeUndefined();
  });

  it("falls back from empty url to sourceURL within the same entry", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "", sourceURL: "https://fallback.com", title: "Fallback" },
        { sourceURL: "https://only-source.com", title: "Only Source" },
      ],
    });

    expect(result).toHaveLength(2);
    expect(requireSearchResult(result, 0).url).toBe("https://fallback.com");
    expect(requireSearchResult(result, 1).url).toBe("https://only-source.com");
  });

  it("includes entries with empty title (title defaults to empty string)", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://example.com/no-title" },
        { url: "https://example.com/with-title", title: "Has Title" },
      ],
    });

    expect(result).toHaveLength(2);
    expect(requireSearchResult(result, 0).title).toBe("");
    expect(requireSearchResult(result, 1).title).toBe("Has Title");
  });

  it("picks the first candidate array when multiple are present", () => {
    // The candidates list checks data before results. Both are arrays here,
    // so data wins and results is ignored.
    const result = firecrawlClient.resolveSearchItems({
      data: [{ url: "https://from-data.com", title: "From Data" }],
      results: [{ url: "https://from-results.com", title: "From Results" }],
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).url).toBe("https://from-data.com");
  });

  it("treats non-object metadata as absent (number, string)", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "https://example.com/meta-num", metadata: 42 },
        { url: "https://example.com/meta-str", metadata: "oops" },
      ],
    });

    expect(result).toHaveLength(2);
    // Both should still be resolved; metadata fallback should not crash.
    expect(requireSearchResult(result, 0).url).toBe("https://example.com/meta-num");
    expect(requireSearchResult(result, 1).url).toBe("https://example.com/meta-str");
  });

  it("sets siteName to undefined when url is not a valid URL", () => {
    // resolveSiteName uses new URL() internally and catches errors.
    const result = firecrawlClient.resolveSearchItems({
      data: [
        { url: "not-a-valid-url", title: "Invalid" },
        { url: "", title: "Empty URL" }, // will be skipped
      ],
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).siteName).toBeUndefined();
  });

  it("prefers record.title over metadata.title when both are present", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        {
          url: "https://example.com",
          title: "record title",
          metadata: { title: "metadata title" },
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).title).toBe("record title");
  });

  it("falls back to metadata.title when record.title is absent", () => {
    const result = firecrawlClient.resolveSearchItems({
      data: [
        {
          url: "https://example.com",
          metadata: { title: "metadata title" },
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).title).toBe("metadata title");
  });

  it("falls back to metadata.title when record.title is empty string", () => {
    // typeof "" === "string" && "" → falsy → falls through to metadata.title
    const result = firecrawlClient.resolveSearchItems({
      data: [
        {
          url: "https://example.com",
          title: "",
          metadata: { title: "metadata title" },
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(requireSearchResult(result, 0).title).toBe("metadata title");
  });
});

// ---------------------------------------------------------------------------
// parseFirecrawlScrapePayload
// ---------------------------------------------------------------------------
describe("parseFirecrawlScrapePayload", () => {
  const baseOpts = {
    url: "https://example.com/page",
    extractMode: "markdown" as const,
    maxChars: 50_000,
  };

  it("parses a standard markdown scrape response", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: {
          markdown: "# Hello\n\nThis is page content.",
        },
      },
    });

    expect(result.url).toBe("https://example.com/page");
    expect(result.extractor).toBe("firecrawl");
    expect(result.extractMode).toBe("markdown");
    expect(result.text).toContain("# Hello");
    expect(result.length).toBe((result.text as string).length);
    expect(result.truncated).toBe(false);
  });

  it("falls back to content field when markdown is absent", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: {
          content: "Fallback content body",
        },
      },
    });

    expect(result.text).toContain("Fallback content body");
  });

  it("throws when no content is returned", () => {
    expect(() =>
      firecrawlClient.parseFirecrawlScrapePayload({
        ...baseOpts,
        payload: { data: {} },
      }),
    ).toThrow(/no content/i);

    expect(() =>
      firecrawlClient.parseFirecrawlScrapePayload({
        ...baseOpts,
        payload: {},
      }),
    ).toThrow(/no content/i);
  });

  it("converts markdown to plain text in text mode", () => {
    const markdownResult = firecrawlClient.parseFirecrawlScrapePayload({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 50_000,
      payload: {
        data: {
          markdown: "# Heading\n\n**bold** and `code`",
        },
      },
    });

    const textResult = firecrawlClient.parseFirecrawlScrapePayload({
      url: "https://example.com",
      extractMode: "text",
      maxChars: 50_000,
      payload: {
        data: {
          markdown: "# Heading\n\n**bold** and `code`",
        },
      },
    });

    expect(markdownResult.extractMode).toBe("markdown");
    expect(textResult.extractMode).toBe("text");
    // text mode strips markdown syntax: heading markers should be removed
    expect(textResult.text).not.toContain("# Heading");
    // The raw lengths differ because text mode strips markdown characters
    expect(textResult.rawLength as number).toBeLessThan(markdownResult.rawLength as number);
  });

  it("includes metadata: finalUrl, title, and statusCode", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: {
          markdown: "content with metadata",
          url: "https://redirected.example.com",
          statusCode: 200,
          metadata: {
            sourceURL: "https://final.example.com/page",
            title: "Page Title",
            statusCode: 200,
          },
        },
      },
    });

    expect(result.finalUrl).toBe("https://final.example.com/page");
    expect(result.title).toContain("Page Title");
    expect(result.status).toBe(200);
  });

  it("falls back to data.url for finalUrl when metadata.sourceURL is absent", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: {
          markdown: "content",
          url: "https://direct.example.com",
        },
      },
    });

    expect(result.finalUrl).toBe("https://direct.example.com");
  });

  it("uses the requested url as finalUrl when no redirect is present", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "no redirect info" },
      },
    });

    expect(result.finalUrl).toBe("https://example.com/page");
  });

  it("omits title when metadata title is absent", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "no title" },
      },
    });

    expect(result.title).toBeUndefined();
    expect(Object.hasOwn(result, "title")).toBe(false);
  });

  it("omits status when no statusCode is available", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "no status" },
      },
    });

    expect(result.status).toBeUndefined();
    expect(Object.hasOwn(result, "status")).toBe(false);
  });

  it("truncates content when it exceeds maxChars", () => {
    const longContent = "a".repeat(200);
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 50,
      payload: {
        data: { markdown: longContent },
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.rawLength as number).toBe(200);
  });

  it("does not truncate content within maxChars limit", () => {
    const shortContent = "short content here";
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: shortContent },
      },
    });

    expect(result.truncated).toBe(false);
    expect(result.rawLength as number).toBe(shortContent.length);
  });

  it("handles truncation at exact boundary (not truncated)", () => {
    const content = "x".repeat(100);
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 100,
      payload: {
        data: { markdown: content },
      },
    });

    // When raw length equals maxChars, truncateText returns the full text.
    expect(result.truncated).toBe(false);
    expect(result.rawLength as number).toBe(100);
  });

  it("truncates content one character over maxChars", () => {
    const content = "x".repeat(101);
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 100,
      payload: {
        data: { markdown: content },
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.rawLength as number).toBe(101);
  });

  it("handles maxChars of 0 (truncates everything)", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 0,
      payload: {
        data: { markdown: "some content" },
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.rawLength as number).toBe("some content".length);
  });

  it("preserves warning string from the response payload", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "content with warning" },
        warning: "Proxy fallback was used for this request",
      },
    });

    expect(result.warning).toContain("Proxy fallback was used");
  });

  it("omits warning when response has no warning field", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "content without warning" },
      },
    });

    expect(result.warning).toBeUndefined();
    expect(Object.hasOwn(result, "warning")).toBe(false);
  });

  it("handles non-string warning gracefully", () => {
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "content" },
        warning: 42,
      },
    });

    expect(result.warning).toBeUndefined();
  });

  it("ignores non-numeric statusCode values", () => {
    // Firecrawl may return statusCode as a string in some response shapes.
    // The check is `typeof ... === "number"`, so strings are treated as absent.
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: {
          markdown: "content",
          statusCode: "200",
        },
      },
    });

    expect(result.status).toBeUndefined();
  });

  it("treats whitespace-only markdown as valid content", () => {
    // typeof "   " === "string" && "   " → truthy → treated as content.
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "   " },
      },
    });

    expect(result.rawLength as number).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("silently drops empty-string warning", () => {
    // typeof "" === "string" && "" → "" is falsy → warning = undefined.
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: { markdown: "content" },
        warning: "",
      },
    });

    expect(result.warning).toBeUndefined();
  });

  it("drops empty-string metadata.title (treated as absent)", () => {
    // typeof "" === "string" && "" → falsy → title = undefined.
    const result = firecrawlClient.parseFirecrawlScrapePayload({
      ...baseOpts,
      payload: {
        data: {
          markdown: "content",
          metadata: { title: "" },
        },
      },
    });

    expect(result.title).toBeUndefined();
  });
});
