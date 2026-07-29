// Memory Wiki tests cover markdown plugin behavior.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWikiPageFilename,
  parseWikiMarkdown,
  renderWikiMarkdown,
  scanWikiPageSummary,
  slugifyWikiSegment,
  toWikiPageSummary,
  WIKI_RAW_SOURCE_MARKER,
} from "./markdown.js";

function scanWikiLinkTargets(markdown: string, relativePath: string): string[] {
  const result = scanWikiPageSummary({
    absolutePath: path.join("/tmp/wiki", relativePath),
    relativePath,
    raw: markdown,
  });
  if (result.status !== "valid") {
    throw new Error(`Expected valid wiki page scan, got ${result.status}`);
  }
  return result.page.linkTargets;
}

describe("slugifyWikiSegment", () => {
  it("preserves Unicode letters and numbers in wiki slugs", () => {
    expect(slugifyWikiSegment("大语言模型概述")).toBe("大语言模型概述");
    expect(slugifyWikiSegment("LLM 架构分析")).toBe("llm-架构分析");
    expect(slugifyWikiSegment("Circuit Breaker 自動恢復")).toBe("circuit-breaker-自動恢復");
  });

  it("keeps ASCII behavior unchanged", () => {
    expect(slugifyWikiSegment("hello world")).toBe("hello-world");
    expect(slugifyWikiSegment("")).toBe("page");
  });

  it("retains combining marks so distinct titles do not collapse", () => {
    expect(slugifyWikiSegment("किताब")).toBe("किताब");
    expect(slugifyWikiSegment("कुतुब")).toBe("कुतुब");
    expect(slugifyWikiSegment("कीताब")).toBe("कीताब");
  });

  it("caps long Unicode slugs to a safe filename byte length", () => {
    const title = "漢".repeat(90);
    const slug = slugifyWikiSegment(title);

    expect(slug.endsWith(`-${createHash("sha1").update(title).digest("hex").slice(0, 12)}`)).toBe(
      true,
    );
    expect(Buffer.byteLength(slug)).toBeLessThanOrEqual(240);
    expect(slugifyWikiSegment(title)).toBe(slug);
  });

  it("caps composed wiki page filenames to a safe path-component length", () => {
    const stem = `bridge-${"漢".repeat(45)}-${"語".repeat(45)}`;
    const fileName = createWikiPageFilename(stem);

    expect(fileName.endsWith(".md")).toBe(true);
    expect(
      Buffer.byteLength(`.${fileName}.00000000-0000-4000-8000-000000000000.fallback.tmp`),
    ).toBeLessThanOrEqual(255);
    expect(createWikiPageFilename(stem)).toBe(fileName);
  });
});

describe("toWikiPageSummary", () => {
  it("marks raw and generated source body metadata", () => {
    const rawSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/raw-alpha.md",
      relativePath: "sources/raw-alpha.md",
      raw: `# Raw Alpha Source\n\n${WIKI_RAW_SOURCE_MARKER}\n\nRaw source notes.\n`,
    });
    const rawSourceWithImportWords = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/raw-import-words.md",
      relativePath: "sources/raw-import-words.md",
      raw: "# Raw Source\n\nsourceType: memory-bridge\n\n## Bridge Source\n",
    });
    const rawSourceWithIndentedMarker = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/raw-indented-marker.md",
      relativePath: "sources/raw-indented-marker.md",
      raw: `# Raw Source\n\n    ${WIKI_RAW_SOURCE_MARKER}\n`,
    });
    const rawSourceWithQuotedWrapper = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/raw-quoted-wrapper.md",
      relativePath: "sources/raw-quoted-wrapper.md",
      raw: [
        "# Raw Source",
        "",
        "Copied import example:",
        "",
        "# Memory Bridge: Alpha",
        "",
        "## Bridge Source",
        "",
        "## Content",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const rawSourceWithQuotedLocalFileWrapper = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/raw-quoted-local-file-wrapper.md",
      relativePath: "sources/raw-quoted-local-file-wrapper.md",
      raw: [
        "# Raw Source",
        "",
        WIKI_RAW_SOURCE_MARKER,
        "",
        "Copied local-file import example:",
        "",
        "## Source",
        "- Type: `local-file`",
        "",
        "## Content",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const bridgeSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/bridge-alpha.md",
      relativePath: "sources/bridge-alpha.md",
      raw: [
        "# Memory Bridge: Alpha",
        "",
        "## Bridge Source",
        "",
        "## Content",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const unsafeLocalSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/unsafe-alpha.md",
      relativePath: "sources/unsafe-alpha.md",
      raw: [
        "# Unsafe Local Import: alpha.md",
        "",
        "## Unsafe Local Source",
        "",
        "## Content",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const localFileSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/local-alpha.md",
      relativePath: "sources/local-alpha.md",
      raw: [
        "# Alpha",
        "",
        "## Source",
        "- Type: `local-file`",
        "- Path: `/tmp/alpha.md`",
        "",
        "## Content",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const markedLocalFileSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/local-marked-alpha.md",
      relativePath: "sources/local-marked-alpha.md",
      raw: [
        "# Alpha",
        "",
        WIKI_RAW_SOURCE_MARKER,
        "",
        "## Source",
        "- Type: `local-file`",
        "- Path: `/tmp/source.md`",
        "",
        "## Content",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const leadingMarkedLocalFileSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/local-leading-marked-alpha.md",
      relativePath: "sources/local-leading-marked-alpha.md",
      raw: [
        WIKI_RAW_SOURCE_MARKER,
        "",
        "# Alpha",
        "",
        "## Source",
        "- Type: `local-file`",
        "- Path: `/tmp/source.md`",
        "",
        "## Content",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const partialFrontmatterLocalFileSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/local-partial-frontmatter-alpha.md",
      relativePath: "sources/local-partial-frontmatter-alpha.md",
      raw: renderWikiMarkdown({
        frontmatter: {
          id: "source.partial",
          title: "Partial Source",
        },
        body: [
          WIKI_RAW_SOURCE_MARKER,
          "",
          "# Alpha",
          "",
          "## Source",
          "- Type: `local-file`",
          "- Path: `/tmp/source.md`",
          "",
          "## Content",
          "alpha",
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
      }),
    });
    const chatGptSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/chatgpt-alpha.md",
      relativePath: "sources/chatgpt-alpha.md",
      raw: [
        "# ChatGPT Export: Alpha",
        "",
        "## Source",
        "- Conversation id: `abc123`",
        "- Export file: `/tmp/conversations.json`",
        "",
        "## Active Branch Transcript",
        "### User",
        "alpha",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    const structuredSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/structured-alpha.md",
      relativePath: "sources/structured-alpha.md",
      raw: renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
        },
        body: "# Alpha Source\n",
      }),
    });
    const rawSourceWithNativeFrontmatter = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/native-frontmatter.md",
      relativePath: "sources/native-frontmatter.md",
      raw: `---\ntags:\n  - alpha\n---\n\n# Native Frontmatter\n\n${WIKI_RAW_SOURCE_MARKER}\n\nRaw notes.\n`,
    });
    const wikiSourceWithRawMarker = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/wiki-frontmatter.md",
      relativePath: "sources/wiki-frontmatter.md",
      raw: renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          title: "Damaged Wiki Source",
        },
        body: `# Damaged Wiki Source\n\n${WIKI_RAW_SOURCE_MARKER}\n`,
      }),
    });
    const crlfStructuredSource = toWikiPageSummary({
      absolutePath: "/tmp/wiki/sources/crlf-structured-alpha.md",
      relativePath: "sources/crlf-structured-alpha.md",
      raw: "---\r\npageType: source\r\nid: source.crlf\r\ntitle: CRLF Source\r\n---\r\n\r\n# CRLF Source\r\n",
    });

    expect(rawSource?.hasFrontmatter).toBe(false);
    expect(rawSource?.importedSourceBody).toBeUndefined();
    expect(rawSource?.generatedSourceBody).toBeUndefined();
    expect(rawSource?.unmanagedRawSourceBody).toBe(true);
    expect(rawSourceWithImportWords?.importedSourceBody).toBeUndefined();
    expect(rawSourceWithImportWords?.generatedSourceBody).toBeUndefined();
    expect(rawSourceWithImportWords?.unmanagedRawSourceBody).toBeUndefined();
    expect(rawSourceWithIndentedMarker?.unmanagedRawSourceBody).toBeUndefined();
    expect(rawSourceWithQuotedWrapper?.importedSourceBody).toBeUndefined();
    expect(rawSourceWithQuotedWrapper?.generatedSourceBody).toBeUndefined();
    expect(rawSourceWithQuotedWrapper?.unmanagedRawSourceBody).toBeUndefined();
    expect(rawSourceWithQuotedLocalFileWrapper?.generatedSourceBody).toBeUndefined();
    expect(rawSourceWithQuotedLocalFileWrapper?.unmanagedRawSourceBody).toBe(true);
    expect(bridgeSource?.hasFrontmatter).toBe(false);
    expect(bridgeSource?.importedSourceBody).toBe("bridge");
    expect(bridgeSource?.generatedSourceBody).toBe("bridge");
    expect(unsafeLocalSource?.hasFrontmatter).toBe(false);
    expect(unsafeLocalSource?.importedSourceBody).toBe("unsafe-local");
    expect(unsafeLocalSource?.generatedSourceBody).toBe("unsafe-local");
    expect(localFileSource?.generatedSourceBody).toBe("local-file");
    expect(markedLocalFileSource?.generatedSourceBody).toBe("local-file");
    expect(markedLocalFileSource?.unmanagedRawSourceBody).toBeUndefined();
    expect(leadingMarkedLocalFileSource?.generatedSourceBody).toBe("local-file");
    expect(leadingMarkedLocalFileSource?.unmanagedRawSourceBody).toBeUndefined();
    expect(partialFrontmatterLocalFileSource?.generatedSourceBody).toBe("local-file");
    expect(partialFrontmatterLocalFileSource?.unmanagedRawSourceBody).toBeUndefined();
    expect(chatGptSource?.generatedSourceBody).toBe("chatgpt-export");
    expect(structuredSource?.hasFrontmatter).toBe(true);
    expect(structuredSource?.importedSourceBody).toBeUndefined();
    expect(structuredSource?.generatedSourceBody).toBeUndefined();
    expect(structuredSource?.unmanagedRawSourceBody).toBeUndefined();
    expect(rawSourceWithNativeFrontmatter?.hasFrontmatter).toBe(true);
    expect(rawSourceWithNativeFrontmatter?.unmanagedRawSourceBody).toBe(true);
    expect(wikiSourceWithRawMarker?.hasFrontmatter).toBe(true);
    expect(wikiSourceWithRawMarker?.unmanagedRawSourceBody).toBeUndefined();
    expect(crlfStructuredSource?.hasFrontmatter).toBe(true);
    expect(crlfStructuredSource?.pageType).toBe("source");
  });

  it("normalizes agent-facing people wiki metadata", () => {
    const raw = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        entityType: "person",
        id: "entity.brad",
        title: "Brad Groux",
        canonicalId: "maintainer.brad-groux",
        aliases: ["brad", "bgroux"],
        privacyTier: "local-private",
        bestUsedFor: ["Microsoft ecosystem routing"],
        notEnoughFor: ["legal approval"],
        lastRefreshedAt: "2026-04-29T00:00:00.000Z",
        personCard: {
          handles: ["@bgroux"],
          socials: ["https://x.example/bgroux"],
          email: "brad@example.com",
          timezone: "America/Chicago",
          lane: "Microsoft Teams",
          askFor: ["Teams and Azure questions"],
          avoidAskingFor: ["unrelated billing"],
          confidence: 0.8,
          privacyTier: "confirm-before-use",
          lastRefreshedAt: "2026-04-28T00:00:00.000Z",
        },
        relationships: [
          {
            targetId: "entity.alice",
            targetTitle: "Alice",
            kind: "collaborates-with",
            weight: 0.7,
            confidence: 0.6,
            evidenceKind: "discrawl-stat",
            privacyTier: "local-private",
          },
        ],
        claims: [
          {
            id: "claim.brad.teams",
            text: "Brad is useful for Microsoft Teams routing.",
            confidence: 0.9,
            evidence: [
              {
                kind: "maintainer-whois",
                sourceId: "source.maintainers",
                confidence: 0.8,
                privacyTier: "local-private",
              },
            ],
          },
        ],
      },
      body: "# Brad Groux\n",
    });

    const summary = toWikiPageSummary({
      absolutePath: "/tmp/wiki/entities/brad.md",
      relativePath: "entities/brad.md",
      raw,
    });
    if (!summary) {
      throw new Error("expected wiki summary");
    }

    expect(summary.entityType).toBe("person");
    expect(summary.canonicalId).toBe("maintainer.brad-groux");
    expect(summary.aliases).toEqual(["brad", "bgroux"]);
    expect(summary.privacyTier).toBe("local-private");
    expect(summary.bestUsedFor).toEqual(["Microsoft ecosystem routing"]);
    expect(summary.notEnoughFor).toEqual(["legal approval"]);
    expect(summary.lastRefreshedAt).toBe("2026-04-29T00:00:00.000Z");
    expect(summary.personCard?.handles).toEqual(["@bgroux"]);
    expect(summary.personCard?.emails).toEqual(["brad@example.com"]);
    expect(summary.personCard?.lane).toBe("Microsoft Teams");
    expect(summary.personCard?.privacyTier).toBe("confirm-before-use");
    expect(summary.relationships).toEqual([
      {
        targetId: "entity.alice",
        targetTitle: "Alice",
        kind: "collaborates-with",
        weight: 0.7,
        confidence: 0.6,
        evidenceKind: "discrawl-stat",
        privacyTier: "local-private",
      },
    ]);
    expect(summary.claims[0]?.id).toBe("claim.brad.teams");
    expect(summary.claims[0]?.evidence).toEqual([
      {
        kind: "maintainer-whois",
        sourceId: "source.maintainers",
        confidence: 0.8,
        privacyTier: "local-private",
      },
    ]);
  });

  it("reports and excludes unparsable frontmatter from page scans (#96125)", () => {
    const raw = [
      "---",
      "pageType: synthesis",
      "id: synthesis.test",
      "sourceIds:",
      '  - **MEMORY.md line 235**:"some quoted, value"',
      "---",
      "",
      "# Test Title",
      "",
      "Body text that should be preserved.",
    ].join("\n");

    const params = {
      absolutePath: "/tmp/wiki/syntheses/test.md",
      relativePath: "syntheses/test.md",
      raw,
    };
    const result = scanWikiPageSummary(params);
    if (result.status !== "invalid-frontmatter") {
      throw new Error("expected invalid frontmatter result");
    }

    expect(result.error.relativePath).toBe("syntheses/test.md");
    expect(result.error.message).toContain("Unexpected scalar");
    expect(toWikiPageSummary(params)).toBeNull();
    expect(() => parseWikiMarkdown(raw)).toThrow("Unexpected scalar");
  });

  it.each([
    { name: "sequence", frontmatter: "- pageType: synthesis" },
    { name: "scalar", frontmatter: "synthesis" },
  ])("reports and excludes $name frontmatter roots from page scans", ({ frontmatter }) => {
    const raw = ["---", frontmatter, "---", "", "# Invalid Root"].join("\n");
    const params = {
      absolutePath: "/tmp/wiki/syntheses/invalid-root.md",
      relativePath: "syntheses/invalid-root.md",
      raw,
    };
    const result = scanWikiPageSummary(params);
    if (result.status !== "invalid-frontmatter") {
      throw new Error("expected invalid frontmatter result");
    }

    expect(result.error.message).toBe("Wiki frontmatter must be a YAML mapping");
    expect(toWikiPageSummary(params)).toBeNull();
    expect(() => parseWikiMarkdown(raw)).toThrow("Wiki frontmatter must be a YAML mapping");
  });

  it("preserves frontmatter and body for valid YAML (#96125 control)", () => {
    const raw = [
      "---",
      "pageType: synthesis",
      "id: synthesis.healthy",
      "sourceIds:",
      "  - source.alpha",
      "---",
      "",
      "# Healthy Page",
      "",
      "Healthy body.",
    ].join("\n");

    const summary = toWikiPageSummary({
      absolutePath: "/tmp/wiki/syntheses/healthy.md",
      relativePath: "syntheses/healthy.md",
      raw,
    });
    if (!summary) {
      throw new Error("expected wiki summary");
    }

    expect(summary.hasFrontmatter).toBe(true);
    expect(summary.title).toBe("Healthy Page");
    expect(summary.id).toBe("synthesis.healthy");
    expect(summary.sourceIds).toEqual(["source.alpha"]);
    expect(summary.pageType).toBe("synthesis");
  });
});

describe("scanWikiPageSummary linkTargets", () => {
  it("extracts real wikilinks from prose", () => {
    const links = scanWikiLinkTargets(
      "See [[Alpha]] and [[Beta]] for details.",
      "entities/test.md",
    );
    expect(links).toEqual(["Alpha", "Beta"]);
  });

  it("does not extract [[…]] inside fenced code blocks (#97945)", () => {
    const markdown = [
      "# Test Page",
      "",
      "Real link: [[RealPage]]",
      "",
      "```bash",
      'if [[ "$x" == "y" ]]; then echo "ok"; fi',
      "```",
      "",
      "```scala",
      "val x: Future[Option[User]] = handle(req)",
      "```",
    ].join("\n");
    const links = scanWikiLinkTargets(markdown, "entities/test.md");
    // Only the real wikilink — none from fenced code blocks.
    expect(links).toEqual(["RealPage"]);
  });

  it("does not extract [[…]] inside inline code spans (#97945)", () => {
    const links = scanWikiLinkTargets(
      'See [[RealPage]].  Never `[[ -z "$str" ]]` extract this.',
      "entities/test.md",
    );
    expect(links).toEqual(["RealPage"]);
  });

  it("does not extract [[…]] inside tilde-fenced code blocks (#97945)", () => {
    const markdown = [
      "# Tilde Fence",
      "",
      "~~~scala",
      "def handle(userId: String, request: Request[A]): Future[Option[User]] = ???",
      "~~~",
      "",
      "Actual link: [[ActualPage]]",
    ].join("\n");
    const links = scanWikiLinkTargets(markdown, "entities/test.md");
    expect(links).toEqual(["ActualPage"]);
  });

  it("does not extract [[…]] inside 6-backtick fenced code blocks (#97945)", () => {
    const markdown = [
      "# Long Fence",
      "",
      "``````csharp",
      "var result = await client.GetAsync<Response<Item>>(url, cancellationToken);",
      "``````",
      "",
      "Valid: [[ValidTarget]]",
    ].join("\n");
    const links = scanWikiLinkTargets(markdown, "entities/test.md");
    expect(links).toEqual(["ValidTarget"]);
  });

  it("accepts a closing fence longer than the opening fence (#97945)", () => {
    // CommonMark allows the closing fence to be the same or longer than the
    // opening fence.  A `` ``` `` opener with a `` ```` `` closer must still
    // strip the block so the Scala generic inside is not extracted.
    const markdown = [
      "# Longer Close",
      "",
      "```scala",
      "def handle(req: Request[A]): Future[Option[User]] = ???",
      "````",
      "",
      "Prose: [[RealTarget]]",
    ].join("\n");
    const links = scanWikiLinkTargets(markdown, "entities/test.md");
    expect(links).toEqual(["RealTarget"]);
  });

  it("does not leak [[…]] when a shorter fence-like line appears inside a longer fenced block (#97945)", () => {
    // A 6-backtick block containing a shorter 3-backtick line before the real
    // 6-backtick close must not cause the scanner to exit early.
    const markdown = [
      "# Long Fence With Shorter Inner Line",
      "",
      "``````bash",
      "some code",
      "```",
      "[[not-a-link]]",
      "``````",
      "",
      "After fence: [[RealPage]]",
    ].join("\n");
    const links = scanWikiLinkTargets(markdown, "entities/test.md");
    expect(links).toEqual(["RealPage"]);
  });

  it.each([
    {
      name: "an invalid backtick info string",
      markdown: "```lang`oops\n[[RealPage]]",
      expected: ["RealPage"],
    },
    {
      name: "an unmatched backtick run",
      markdown: "```foo``\n[[RealPage]]",
      expected: ["RealPage"],
    },
    {
      name: "a fenced block inside a blockquote",
      markdown: "> ```bash\n> [[not-a-link]]\n> ```\n\n[[RealPage]]",
      expected: ["RealPage"],
    },
    {
      name: "a fenced block inside a list",
      markdown: "- ```bash\n  [[not-a-link]]\n  ```\n\n[[RealPage]]",
      expected: ["RealPage"],
    },
    {
      name: "a multiline code span",
      markdown: "``\n[[not-a-link]]\n`` and [[RealPage]]",
      expected: ["RealPage"],
    },
    {
      name: "separate multi-backtick code spans",
      markdown: "``code`` [[RealPage]] ``more``",
      expected: ["RealPage"],
    },
  ])("handles $name without hiding prose links", ({ markdown, expected }) => {
    expect(scanWikiLinkTargets(markdown, "entities/test.md")).toEqual(expected);
  });
});
