// Memory Wiki tests cover apply plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("applyMemoryWikiMutation", () => {
  it("normalizes string confidence in wiki mutations", () => {
    expect(
      normalizeMemoryWikiMutationInput({
        op: "create_synthesis",
        title: "Alpha Synthesis",
        body: "Alpha summary body.",
        sourceIds: ["source.alpha"],
        confidence: "0.7",
      }),
    ).toMatchObject({ confidence: 0.7 });

    expect(
      normalizeMemoryWikiMutationInput({
        op: "update_metadata",
        lookup: "entity.alpha",
        confidence: "0.4",
      }),
    ).toMatchObject({ confidence: 0.4 });
  });

  it("normalizes CLI-style wiki mutation operation aliases", () => {
    expect(
      normalizeMemoryWikiMutationInput({
        op: "synthesis",
        title: "Alpha Synthesis",
        body: "Alpha summary body.",
        sourceIds: ["source.alpha"],
      }),
    ).toMatchObject({
      op: "create_synthesis",
      title: "Alpha Synthesis",
    });

    expect(
      normalizeMemoryWikiMutationInput({
        op: "metadata",
        lookup: "entity.alpha",
        sourceIds: ["source.alpha"],
      }),
    ).toMatchObject({
      op: "update_metadata",
      lookup: "entity.alpha",
    });
  });

  it("rejects out-of-range string confidence in wiki mutations", () => {
    expect(() =>
      normalizeMemoryWikiMutationInput({
        op: "update_metadata",
        lookup: "entity.alpha",
        confidence: "1.5",
      }),
    ).toThrow("confidence must be a finite number");
  });

  it("creates synthesis pages with managed summary blocks and refreshed indexes", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-apply-" });

    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Alpha Synthesis",
        body: "Alpha summary body.",
        sourceIds: ["source.alpha", "source.beta"],
        claims: [
          {
            id: "claim.alpha.postgres",
            text: "Alpha uses PostgreSQL for production writes.",
            status: "supported",
            confidence: 0.86,
            evidence: [
              {
                sourceId: "source.alpha",
                lines: "12-18",
                weight: 0.9,
              },
            ],
          },
        ],
        contradictions: ["Needs a better primary source"],
        questions: ["What changed after launch?"],
        confidence: 0.7,
      },
    });

    expect(result.changed).toBe(true);
    expect(result.pagePath).toBe("syntheses/alpha-synthesis.md");
    expect(result.pageId).toBe("synthesis.alpha-synthesis");
    expect(result.compile.pageCounts.synthesis).toBe(1);

    const page = await fs.readFile(path.join(rootDir, result.pagePath), "utf8");
    const parsed = parseWikiMarkdown(page);

    expect(parsed.frontmatter.pageType).toBe("synthesis");
    expect(parsed.frontmatter.id).toBe("synthesis.alpha-synthesis");
    expect(parsed.frontmatter.title).toBe("Alpha Synthesis");
    expect(parsed.frontmatter.sourceIds).toEqual(["source.alpha", "source.beta"]);
    expect(parsed.frontmatter.claims).toHaveLength(1);
    const claims = parsed.frontmatter.claims as
      | Array<{
          confidence?: number;
          evidence?: Array<Record<string, unknown>>;
          id?: string;
          status?: string;
          text?: string;
        }>
      | undefined;
    const claim = claims?.[0];
    expect(claim?.id).toBe("claim.alpha.postgres");
    expect(claim?.text).toBe("Alpha uses PostgreSQL for production writes.");
    expect(claim?.status).toBe("supported");
    expect(claim?.confidence).toBe(0.86);
    expect(claim?.evidence).toEqual([
      {
        sourceId: "source.alpha",
        lines: "12-18",
        weight: 0.9,
      },
    ]);
    expect(parsed.frontmatter.contradictions).toEqual(["Needs a better primary source"]);
    expect(parsed.frontmatter.questions).toEqual(["What changed after launch?"]);
    expect(parsed.frontmatter.confidence).toBe(0.7);
    expect(parsed.frontmatter.status).toBe("active");
    expect(parsed.body).toContain("## Summary");
    expect(parsed.body).toContain("<!-- openclaw:wiki:generated:start -->");
    expect(parsed.body).toContain("Alpha summary body.");
    expect(parsed.body).toContain("## Notes");
    expect(parsed.body).toContain("<!-- openclaw:human:start -->");
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha Synthesis](syntheses/alpha-synthesis.md)",
    );
  });

  it("applies a write when an unrelated vault page has malformed frontmatter (#96125)", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-apply-unrelated-invalid-",
    });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    const brokenPath = path.join(rootDir, "sources", "broken.md");
    const brokenPage = [
      "---",
      "pageType: source",
      "id: source.broken",
      "sourceIds:",
      '  - **MEMORY.md line 235**:"some quoted, value"',
      "---",
      "",
      "# Broken",
    ].join("\n");
    await fs.writeFile(brokenPath, brokenPage, "utf8");

    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Healthy Synthesis",
        body: "Healthy summary body.",
        sourceIds: ["source.healthy"],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.compile.pageCounts.source).toBe(0);
    expect(result.compile.pageCounts.synthesis).toBe(1);
    expect(result.compile.frontmatterErrors).toEqual([
      expect.objectContaining({ relativePath: "sources/broken.md" }),
    ]);
    await expect(fs.readFile(brokenPath, "utf8")).resolves.toBe(brokenPage);
  });

  it.each([
    {
      name: "syntax-error",
      frontmatterLines: [
        "pageType: synthesis",
        "id: synthesis.conflicted",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
      ],
      error: "Unexpected scalar",
    },
    {
      name: "sequence-root",
      frontmatterLines: ["- pageType: synthesis", "  id: synthesis.conflicted"],
      error: "Wiki frontmatter must be a YAML mapping",
    },
  ])(
    "rejects a malformed write target without replacing its metadata ($name) (#96125)",
    async ({ frontmatterLines, error }) => {
      const { rootDir, config } = await createVault({
        prefix: "memory-wiki-apply-invalid-target-",
      });
      await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
      const targetPath = path.join(rootDir, "syntheses", "conflicted.md");
      const original = [
        "---",
        ...frontmatterLines,
        "---",
        "",
        "# Conflicted",
        "",
        "Keep this body.",
      ].join("\n");
      await fs.writeFile(targetPath, original, "utf8");

      await expect(
        applyMemoryWikiMutation({
          config,
          mutation: {
            op: "create_synthesis",
            title: "Conflicted",
            body: "Replacement body.",
            sourceIds: ["source.new"],
          },
        }),
      ).rejects.toThrow(error);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(original);
    },
  );

  it("updates page metadata without overwriting existing human notes", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-apply-",
    });

    const targetPath = path.join(rootDir, "entities", "alpha.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.old"],
          confidence: 0.3,
        },
        body: `# Alpha

## Notes
<!-- openclaw:human:start -->
keep this note
<!-- openclaw:human:end -->
`,
      }),
      "utf8",
    );

    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "update_metadata",
        lookup: "entity.alpha",
        sourceIds: ["source.new"],
        claims: [
          {
            id: "claim.alpha.status",
            text: "Alpha is still active for existing tenants.",
            status: "contested",
            evidence: [{ sourceId: "source.new", lines: "4-9" }],
          },
        ],
        contradictions: ["Conflicts with source.beta"],
        questions: ["Is Alpha still active?"],
        confidence: null,
        status: "review",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.pagePath).toBe("entities/alpha.md");
    expect(result.compile.pageCounts.entity).toBe(1);

    const updated = await fs.readFile(targetPath, "utf8");
    const parsed = parseWikiMarkdown(updated);

    expect(parsed.frontmatter.pageType).toBe("entity");
    expect(parsed.frontmatter.id).toBe("entity.alpha");
    expect(parsed.frontmatter.title).toBe("Alpha");
    expect(parsed.frontmatter.sourceIds).toEqual(["source.new"]);
    expect(parsed.frontmatter.claims).toHaveLength(1);
    const claims = parsed.frontmatter.claims as
      | Array<{
          evidence?: Array<Record<string, unknown>>;
          id?: string;
          status?: string;
          text?: string;
        }>
      | undefined;
    const claim = claims?.[0];
    expect(claim?.id).toBe("claim.alpha.status");
    expect(claim?.text).toBe("Alpha is still active for existing tenants.");
    expect(claim?.status).toBe("contested");
    expect(claim?.evidence).toEqual([{ sourceId: "source.new", lines: "4-9" }]);
    expect(parsed.frontmatter.contradictions).toEqual(["Conflicts with source.beta"]);
    expect(parsed.frontmatter.questions).toEqual(["Is Alpha still active?"]);
    expect(parsed.frontmatter.status).toBe("review");
    expect(parsed.frontmatter).not.toHaveProperty("confidence");
    expect(parsed.body).toContain("keep this note");
    expect(parsed.body).toContain("<!-- openclaw:human:start -->");
    await expect(
      fs.readFile(path.join(rootDir, "entities", "index.md"), "utf8"),
    ).resolves.toContain("[Alpha](alpha.md)");
  });

  it("preserves disjoint metadata updates from concurrent agent turns", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-apply-concurrent-",
    });
    const targetPath = path.join(rootDir, "entities", "shared.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.shared",
          title: "Shared",
        },
        body: "# Shared\n",
      }),
      "utf8",
    );

    await Promise.all([
      applyMemoryWikiMutation({
        config,
        mutation: {
          op: "update_metadata",
          lookup: "entity.shared",
          sourceIds: ["source.concurrent"],
        },
      }),
      applyMemoryWikiMutation({
        config,
        mutation: {
          op: "update_metadata",
          lookup: "entity.shared",
          questions: ["Which agent owns the next action?"],
        },
      }),
      applyMemoryWikiMutation({
        config,
        mutation: {
          op: "update_metadata",
          lookup: "entity.shared",
          confidence: 0.9,
        },
      }),
      applyMemoryWikiMutation({
        config,
        mutation: {
          op: "update_metadata",
          lookup: "entity.shared",
          status: "review",
        },
      }),
    ]);

    const parsed = parseWikiMarkdown(await fs.readFile(targetPath, "utf8"));
    expect(parsed.frontmatter).toMatchObject({
      sourceIds: ["source.concurrent"],
      questions: ["Which agent owns the next action?"],
      confidence: 0.9,
      status: "review",
    });
  });
});
