// Memory Wiki tests cover lint plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintMemoryWikiVault } from "./lint.js";
import {
  renderWikiMarkdown,
  WIKI_RAW_SOURCE_MARKER,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { writeMemoryWikiSourceSyncState } from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

function issueCodesForPath(
  result: Awaited<ReturnType<typeof lintMemoryWikiVault>>,
  pagePath: string,
): string[] {
  return result.issues
    .filter((issue) => issue.path === pagePath)
    .map((issue) => issue.code)
    .toSorted();
}

describe("lintMemoryWikiVault", () => {
  it("accepts native markdown links that include the relative .md target", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-native-links-",
      config: {
        vault: { renderMode: "native" },
      },
    });
    await Promise.all(
      ["entities", "sources"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
        },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
        },
        body: "# Alpha\n\n[Alpha Source](../sources/alpha.md)\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.map((issue) => issue.code)).not.toContain("broken-wikilink");
  });

  it("does not report broken wikilinks for [[…]] patterns inside fenced code blocks or inline code (#97945)", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-fenced-code-wikilinks-",
      config: {
        vault: { renderMode: "native" },
      },
    });
    await Promise.all(
      ["entities", "sources"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
        },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );
    // Fenced code blocks and inline code with [[…]] syntax must not produce
    // broken-wikilink warnings — the text inside code regions is literal,
    // not a wikilink reference.
    await fs.writeFile(
      path.join(rootDir, "entities", "code-samples.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.code-samples",
          title: "Code Samples",
          sourceIds: ["source.alpha"],
        },
        body:
          "# Code Samples\n\n" +
          "Bash inside a fenced code block:\n\n" +
          "```bash\n" +
          'if [[ "$name" == "Alice" ]]; then echo "ok"; fi\n' +
          "```\n\n" +
          "Scala generics inside a tilde-fenced block:\n\n" +
          "~~~scala\n" +
          "def handle(userId: String, request: Request[A]): Future[Option[User]] = ???\n" +
          "~~~\n\n" +
          'Inline `[[ -z "$str" ]]` code must be skipped.\n\n' +
          "Outside code, [[real-missing-link]] must still be reported.\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);
    const linkIssues = result.issues.filter(
      (issue) => issue.path === "entities/code-samples.md" && issue.code === "broken-wikilink",
    );
    expect(linkIssues.map((issue) => issue.message)).toEqual([
      "Broken wikilink target `real-missing-link`.",
    ]);
  });

  it("accepts unmanaged raw markdown source pages without page frontmatter", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-raw-sources-",
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "raw-alpha.md"),
      `# Raw Alpha Source\n\n${WIKI_RAW_SOURCE_MARKER}\n\nRaw source notes stay usable as source evidence.\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "raw-native-frontmatter.md"),
      `---\nid: note\n---\n\n# Raw Native Frontmatter\n\n${WIKI_RAW_SOURCE_MARKER}\n\nRaw source notes stay usable as source evidence.\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "raw-native-frontmatter-copy.md"),
      `---\nid: note\n---\n\n# Raw Native Frontmatter Copy\n\n${WIKI_RAW_SOURCE_MARKER}\n\nRaw source notes stay usable as source evidence.\n`,
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    const rawIssueCodes = issueCodesForPath(result, "sources/raw-alpha.md");
    expect(rawIssueCodes).not.toContain("missing-id");
    expect(rawIssueCodes).not.toContain("missing-page-type");
    expect(rawIssueCodes).not.toContain("stale-page");
    expect(
      result.issuesByCategory.structure.filter((issue) => issue.path === "sources/raw-alpha.md"),
    ).toHaveLength(0);
    const nativeFrontmatterIssueCodes = issueCodesForPath(
      result,
      "sources/raw-native-frontmatter.md",
    );
    expect(nativeFrontmatterIssueCodes).not.toContain("missing-id");
    expect(nativeFrontmatterIssueCodes).not.toContain("missing-page-type");
    expect(nativeFrontmatterIssueCodes).not.toContain("stale-page");
    expect(nativeFrontmatterIssueCodes).toContain("duplicate-id");
    expect(issueCodesForPath(result, "sources/raw-native-frontmatter-copy.md")).toContain(
      "duplicate-id",
    );
  });

  it("keeps unmarked source pages without frontmatter visible to structure lint", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-unmarked-sources-",
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "unmarked-alpha.md"),
      "# Unmarked Alpha Source\n\nThis page has no raw-source designation.\n",
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(issueCodesForPath(result, "sources/unmarked-alpha.md")).toEqual(
      expect.arrayContaining(["missing-id", "missing-page-type", "stale-page"]),
    );
  });

  it("keeps malformed imported source bodies visible to structure lint", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-malformed-imports-",
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      [
        "# Memory Bridge: Alpha",
        "",
        "## Bridge Source",
        "- Workspace: `/tmp/workspace`",
        "- Relative path: `MEMORY.md`",
        "",
        "## Content",
        "alpha bridge body",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe-alpha.md"),
      [
        "# Unsafe Local Import: alpha.md",
        "",
        "## Unsafe Local Source",
        "- Configured path: `/tmp/private`",
        "- Relative path: `alpha.md`",
        "",
        "## Content",
        "alpha unsafe-local body",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
      ].join("\n"),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(issueCodesForPath(result, "sources/bridge-alpha.md")).toEqual(
      expect.arrayContaining(["missing-id", "missing-page-type"]),
    );
    expect(issueCodesForPath(result, "sources/unsafe-alpha.md")).toEqual(
      expect.arrayContaining(["missing-id", "missing-page-type"]),
    );
  });

  it("keeps fully truncated tracked imported source pages visible to structure lint", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-tracked-truncated-imports-",
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-truncated.md"),
      [
        "## Related",
        WIKI_RELATED_START_MARKER,
        "- No related pages yet.",
        WIKI_RELATED_END_MARKER,
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe-truncated.md"),
      [
        "## Related",
        WIKI_RELATED_START_MARKER,
        "- No related pages yet.",
        WIKI_RELATED_END_MARKER,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeMemoryWikiSourceSyncState(config.vault.path, {
      version: 1,
      entries: {
        bridge: {
          group: "bridge",
          pagePath: "sources/bridge-truncated.md",
          sourcePath: "/tmp/MEMORY.md",
          sourceUpdatedAtMs: 1,
          sourceSize: 2,
          renderFingerprint: "bridge-fingerprint",
        },
        unsafe: {
          group: "unsafe-local",
          pagePath: "sources/unsafe-truncated.md",
          sourcePath: "/tmp/private/alpha.md",
          sourceUpdatedAtMs: 3,
          sourceSize: 4,
          renderFingerprint: "unsafe-fingerprint",
        },
      },
    });

    const result = await lintMemoryWikiVault(config);

    expect(issueCodesForPath(result, "sources/bridge-truncated.md")).toEqual(
      expect.arrayContaining(["missing-id", "missing-page-type"]),
    );
    expect(issueCodesForPath(result, "sources/unsafe-truncated.md")).toEqual(
      expect.arrayContaining(["missing-id", "missing-page-type"]),
    );
  });

  it("keeps generated source pages with missing frontmatter visible to structure lint", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-generated-source-bodies-",
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "local-file.md"),
      [
        "# Local File Source",
        "",
        "## Source",
        "- Type: `local-file`",
        "- Path: `/tmp/source.md`",
        "",
        "## Content",
        "source body",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "local-file-partial-frontmatter.md"),
      renderWikiMarkdown({
        frontmatter: {
          id: "source.partial",
          title: "Partial Source",
        },
        body: [
          WIKI_RAW_SOURCE_MARKER,
          "",
          "# Local File Source",
          "",
          "## Source",
          "- Type: `local-file`",
          "- Path: `/tmp/source.md`",
          "",
          "## Content",
          "source body",
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "chatgpt-export.md"),
      [
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
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(issueCodesForPath(result, "sources/local-file.md")).toEqual(
      expect.arrayContaining(["missing-id", "missing-page-type", "stale-page"]),
    );
    expect(issueCodesForPath(result, "sources/local-file-partial-frontmatter.md")).toEqual(
      expect.arrayContaining(["missing-page-type", "stale-page"]),
    );
    expect(issueCodesForPath(result, "sources/chatgpt-export.md")).toEqual(
      expect.arrayContaining(["missing-id", "missing-page-type", "stale-page"]),
    );
  });

  it("resolves title, slug, fragment, and imported source-path wikilinks", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-links-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "syntheses"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );

    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.alpha",
          title: "Imported Alpha Source",
          sourceType: "memory-bridge",
          sourcePath: "/workspace/research notes/Alpha System Overview.md",
          bridgeRelativePath: "research notes/Alpha System Overview.md",
          bridgeWorkspaceDir: "/workspace",
        },
        body: [
          "# Imported Alpha Source",
          "",
          "[[Alpha Database#Evidence]]",
          "[[alpha-database]]",
          "[[syntheses/alpha-db#Details]]",
        ].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-db.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.alpha.db",
          title: "Alpha Database",
          sourceIds: ["source.bridge.alpha"],
        },
        body: [
          "# Alpha Database",
          "",
          "[[research notes/Alpha System Overview#Quote]]",
          "[[Alpha System Overview]]",
          "[[alpha-system-overview]]",
        ].join("\n"),
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issues.filter((issue) => issue.code === "broken-wikilink")).toEqual([]);
  });

  it("keeps path target matching case-sensitive", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-path-case-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "syntheses"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );

    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.alpha",
          title: "Bridge Alpha",
          sourceType: "memory-bridge",
          sourcePath: "/workspace/Alpha.md",
          bridgeRelativePath: "Alpha.md",
          bridgeWorkspaceDir: "/workspace",
        },
        body: [
          "# Bridge Alpha",
          "",
          "[[Alpha Database]]",
          "[[alpha-database]]",
          "[[syntheses/Alpha-DB]]",
          "[[Alpha-DB]]",
        ].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-db.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.alpha.db",
          title: "Alpha Database",
          sourceIds: ["source.bridge.alpha"],
        },
        body: "# Alpha Database\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);
    const brokenTargets = result.issues
      .filter((issue) => issue.code === "broken-wikilink")
      .map((issue) => issue.message);

    expect(brokenTargets).toEqual([
      "Broken wikilink target `syntheses/Alpha-DB`.",
      "Broken wikilink target `Alpha-DB`.",
    ]);
  });

  it("preserves question marks in Obsidian title and slug wikilinks", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-title-query-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["sources", "syntheses"].map((dir) => fs.mkdir(path.join(rootDir, dir), { recursive: true })),
    );

    await fs.writeFile(
      path.join(rootDir, "sources", "roadmap-source.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.roadmap",
          title: "Roadmap Source",
        },
        body: [
          "# Roadmap Source",
          "",
          "[[Roadmap? v2]]",
          "[[roadmap? v2]]",
          "[[syntheses/roadmap?view=compact]]",
          "[[syntheses/roadmap.md?view=compact]]",
        ].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "roadmap.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.roadmap",
          title: "Roadmap",
          sourceIds: ["source.roadmap"],
        },
        body: "# Roadmap\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);
    const brokenTargets = result.issues
      .filter((issue) => issue.code === "broken-wikilink")
      .map((issue) => issue.message);

    expect(brokenTargets).toEqual([
      "Broken wikilink target `Roadmap? v2`.",
      "Broken wikilink target `roadmap? v2`.",
    ]);
  });

  it("detects duplicate ids, provenance gaps, contradictions, and open questions", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-",
      config: {
        vault: { renderMode: "obsidian" },
      },
    });
    await Promise.all(
      ["entities", "concepts", "sources", "syntheses"].map((dir) =>
        fs.mkdir(path.join(rootDir, dir), { recursive: true }),
      ),
    );

    const duplicate = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        contradictions: ["Conflicts with source.beta"],
        questions: ["Is Alpha still active?"],
        confidence: 0.2,
        claims: [
          {
            id: "claim.alpha.db",
            text: "Alpha uses PostgreSQL for production writes.",
            confidence: 0.2,
            evidence: [],
          },
        ],
      },
      body: "# Alpha\n\n[[missing-page]]\n",
    });
    await fs.writeFile(path.join(rootDir, "entities", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(path.join(rootDir, "concepts", "alpha.md"), duplicate, "utf8");
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.alpha",
          title: "Bridge Alpha",
          sourceType: "memory-bridge",
        },
        body: "# Bridge Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-db.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.alpha.db",
          title: "Alpha Database",
          sourceIds: ["source.bridge.alpha"],
          updatedAt: "2025-10-01T00:00:00.000Z",
          claims: [
            {
              id: "claim.alpha.db",
              text: "Alpha uses MySQL for production writes.",
              status: "contested",
              confidence: 0.7,
              evidence: [
                {
                  sourceId: "source.bridge.alpha",
                  lines: "1-3",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        body: "# Alpha Database\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(result.issueCount).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate-id");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-source-ids");
    expect(result.issues.map((issue) => issue.code)).toContain("missing-import-provenance");
    expect(result.issues.map((issue) => issue.code)).toContain("broken-wikilink");
    expect(result.issues.map((issue) => issue.code)).toContain("contradiction-present");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-conflict");
    expect(result.issues.map((issue) => issue.code)).toContain("open-question");
    expect(result.issues.map((issue) => issue.code)).toContain("low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-missing-evidence");
    expect(result.issues.map((issue) => issue.code)).toContain("claim-low-confidence");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-page");
    expect(result.issues.map((issue) => issue.code)).toContain("stale-claim");
    expect(result.issuesByCategory.contradictions.map((issue) => issue.code)).toContain(
      "claim-conflict",
    );
    expect(result.issuesByCategory["open-questions"].length).toBeGreaterThanOrEqual(2);
    expect(result.issuesByCategory.provenance.map((issue) => issue.code)).toContain(
      "missing-import-provenance",
    );
    expect(result.issuesByCategory.provenance.map((issue) => issue.code)).toContain(
      "claim-missing-evidence",
    );
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Errors");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Contradictions");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain("### Open Questions");
  });

  it("reports unparsable frontmatter as a lint issue instead of failing the whole vault (#96125)", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-lint-invalid-frontmatter-",
    });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "broken.md"),
      [
        "---",
        "pageType: synthesis",
        "id: synthesis.broken",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
        "---",
        "",
        "# Broken",
        "",
        "Body text.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "healthy.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.healthy",
          title: "Healthy",
          sourceIds: ["source.alpha"],
        },
        body: "# Healthy\n",
      }),
      "utf8",
    );

    const result = await lintMemoryWikiVault(config);

    expect(issueCodesForPath(result, "syntheses/broken.md")).toEqual(["invalid-frontmatter"]);
    expect(issueCodesForPath(result, "syntheses/healthy.md")).not.toContain("invalid-frontmatter");
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain(
      "Frontmatter failed to parse: Unexpected scalar",
    );
  });

  it.each([
    {
      name: "syntax-error",
      frontmatterLines: [
        "pageType: report",
        "id: report.lint",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
      ],
      error: "Unexpected scalar",
    },
    {
      name: "sequence-root",
      frontmatterLines: ["- pageType: report", "  id: report.lint"],
      error: "Wiki frontmatter must be a YAML mapping",
    },
  ])(
    "rejects a malformed lint report without changing its bytes ($name)",
    async ({ frontmatterLines, error }) => {
      const { rootDir, config } = await createVault({
        prefix: "memory-wiki-lint-malformed-report-",
      });
      const reportPath = path.join(rootDir, "reports", "lint.md");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      const malformedReport = [
        "---",
        ...frontmatterLines,
        "---",
        "",
        "# Lint Report",
        "",
        "Existing report body.",
        "",
      ].join("\n");
      await fs.writeFile(reportPath, malformedReport, "utf8");

      await expect(lintMemoryWikiVault(config)).rejects.toThrow(error);
      await expect(fs.readFile(reportPath, "utf8")).resolves.toBe(malformedReport);
    },
  );
});
