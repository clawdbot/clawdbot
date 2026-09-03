// Covers bounded untrusted web-search output and preserved provider source facts.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeWebSearchOutput, WebSearchOutputSchema } from "./web-search-output.js";

const WRAP_MARKER_RE =
  /\n?<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\n?(?:Source: Web Search\n---\n)?/gu;

function stripWrapMarkers(value: string): string {
  return value.replace(WRAP_MARKER_RE, "");
}

function assertOutputKind<T extends { kind: string }, K extends T["kind"]>(
  value: T,
  kind: K,
): asserts value is Extract<T, { kind: K }> {
  if (value.kind !== kind) {
    throw new Error(`expected ${kind} branch`);
  }
}

describe("web_search normalized output security", () => {
  it.each([
    {
      label: "provider results",
      result: {
        results: [{ title: "bounded title", url: "https://example.com/result" }],
        truncated: true,
      },
      expectedKind: "results",
    },
    {
      label: "provider answer",
      result: { content: "bounded answer", truncated: true },
      expectedKind: "answer",
    },
  ])(
    "preserves actual $label truncation through the closed model contract",
    ({ result, expectedKind }) => {
      const normalized = normalizeWebSearchOutput({
        provider: "trusted-owner",
        query: "q",
        result,
      });

      expect(normalized).toMatchObject({ kind: expectedKind, truncated: true });
      expect(Value.Check(WebSearchOutputSchema, normalized)).toBe(true);
    },
  );

  it.each([
    { results: [{ title: "complete", url: "https://example.com" }], truncated: false },
    { content: "complete", truncated: "true" },
  ])("does not invent truncation metadata for complete or untrusted shapes", (result) => {
    const normalized = normalizeWebSearchOutput({ provider: "trusted-owner", query: "q", result });

    expect(normalized).not.toHaveProperty("truncated");
  });

  it("bounds conforming result rows to the public search count and reports the emitted count", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-demo",
      query: "bounded result rows",
      result: {
        count: 25,
        results: Array.from({ length: 25 }, (_, index) => ({
          title: `result ${index}`,
          url: `https://example.com/result/${index}`,
        })),
      },
    });

    assertOutputKind(normalized, "results");
    expect(normalized.results).toHaveLength(10);
    expect(normalized.count).toBe(10);
    expect(normalized.truncated).toBe(true);
  });

  it("bounds the aggregate untrusted result URLs, titles, snippets, and site names", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-demo",
      query: "bounded result metadata",
      result: {
        results: Array.from({ length: 10 }, (_, index) => ({
          title: "t".repeat(15_000),
          url: `https://example.com/${index}`,
          snippet: "s".repeat(15_000),
          siteName: "n".repeat(15_000),
        })),
      },
    });

    assertOutputKind(normalized, "results");
    const untrustedContentChars = normalized.results.reduce(
      (total, row) =>
        total +
        row.url.length +
        stripWrapMarkers(row.title).length +
        stripWrapMarkers(row.snippet ?? "").length +
        stripWrapMarkers(row.siteName ?? "").length,
      0,
    );
    expect(normalized.truncated).toBe(true);
    expect(untrustedContentChars).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(normalized).length).toBeLessThan(22_000);
  });

  it.each(["answer", "results"] as const)(
    "charges final sanitized %s text when short special tokens expand",
    (kind) => {
      const expanding = "<s>".repeat(6_666);
      const result =
        kind === "answer"
          ? { content: expanding }
          : { results: [{ title: expanding, url: "https://example.com/result" }] };
      const normalized = normalizeWebSearchOutput({
        provider: "external-demo",
        query: "sanitizer expansion",
        result,
      });

      expect(normalized.kind).toBe(kind);
      expect(normalized).toMatchObject({ truncated: true });
      expect(JSON.stringify(normalized).length).toBeLessThan(21_000);
      expect(JSON.stringify(normalized)).not.toContain("<s>");
    },
  );

  it("keeps later legitimate result sources when the first page exhausts the prose budget", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-demo",
      query: "source preservation",
      result: {
        results: [
          { title: "x".repeat(25_000), url: "https://example.com/first" },
          { title: "second", url: "https://example.com/second" },
        ],
      },
    });

    assertOutputKind(normalized, "results");
    expect(normalized.results.map((row) => row.url)).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
    expect(normalized.truncated).toBe(true);
  });

  it("bounds citations and their URLs and titles within the shared answer budget", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-answer",
      query: "bounded citation count",
      result: {
        content: "answer body",
        citations: Array.from({ length: 25 }, (_, index) => ({
          url: `https://example.com/citation/${index}`,
          title: `citation ${index}`,
        })),
      },
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toHaveLength(20);
    expect(normalized.truncated).toBe(true);
  });

  it("reserves valid source URLs when an answer already fills the provider content cap", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-answer",
      query: "source preservation",
      result: {
        content: "x".repeat(20_000),
        citations: ["https://example.com/first", "https://example.com/second"],
      },
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toEqual([
      { url: "https://example.com/first" },
      { url: "https://example.com/second" },
    ]);
    expect(normalized.truncated).toBe(true);
    expect(JSON.stringify(normalized).length).toBeLessThan(20_500);
  });

  it("keeps the first valid citation after malformed provider entries", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-answer",
      query: "valid citation priority",
      result: {
        content: "answer",
        citations: [
          ...Array.from({ length: 20 }, () => "invalid citation"),
          "https://example.com/valid",
        ],
      },
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toEqual([{ url: "https://example.com/valid" }]);
  });

  it("bounds provider-controlled error text and rejects oversized unwrapped docs URLs", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-demo",
      query: "oversized error",
      result: {
        error: "e".repeat(3_000),
        message: `${"m".repeat(1_997)}🤖${"m".repeat(20_000)}`,
        docs: `https://example.com/${"x".repeat(3_000)}`,
      },
    });

    assertOutputKind(normalized, "error");
    const unwrapped = stripWrapMarkers(normalized.message);
    expect(unwrapped).toHaveLength(3_999);
    expect(unwrapped).toBe(`${"e".repeat(2_000)}: ${"m".repeat(1_997)}`);
    expect(normalized.docs).toBeUndefined();
  });

  it("rejects oversized provider citations before URL parsing", () => {
    const normalized = normalizeWebSearchOutput({
      provider: "external-answer",
      query: "citation length",
      result: {
        content: "body",
        citations: [`https://example.com/${"x".repeat(3_000)}`, "https://example.com/ok"],
      },
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toEqual([{ url: "https://example.com/ok" }]);
  });

  it("rejects citations whose normalized Unicode URL expands beyond the hard bound", () => {
    const expandedUrl = `https://example.com/${"🦀".repeat(1_000)}`;
    expect(expandedUrl.length).toBeLessThan(2_048);
    const normalized = normalizeWebSearchOutput({
      provider: "external-answer",
      query: "canonical citation length",
      result: {
        content: "body",
        citations: [expandedUrl, "https://example.com/🦀"],
      },
    });

    assertOutputKind(normalized, "answer");
    expect(normalized.citations).toEqual([{ url: "https://example.com/%F0%9F%A6%80" }]);
  });

  it("preserves the raw compatibility branch when a malformed result follows ten valid rows", () => {
    const payload = {
      results: [
        ...Array.from({ length: 10 }, (_, index) => ({
          title: `valid ${index}`,
          url: `https://example.com/${index}`,
        })),
        { name: "provider-specific", link: "https://example.com/custom" },
      ],
    };

    expect(
      normalizeWebSearchOutput({ provider: "external-demo", query: "raw tail", result: payload }),
    ).toEqual({ kind: "raw", provider: "external-demo", data: payload });
  });
});
