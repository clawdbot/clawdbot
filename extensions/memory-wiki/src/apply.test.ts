import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMemoryWikiMutation } from "./apply.js";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("applyMemoryWikiMutation", () => {
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

    expect(parsed.frontmatter).toMatchObject({
      pageType: "synthesis",
      id: "synthesis.alpha-synthesis",
      title: "Alpha Synthesis",
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
      status: "active",
    });
    expect(parsed.body).toContain("## Summary");
    expect(parsed.body).toContain("<!-- openclaw:wiki:generated:start -->");
    expect(parsed.body).toContain("Alpha summary body.");
    expect(parsed.body).toContain("## Notes");
    expect(parsed.body).toContain("<!-- openclaw:human:start -->");
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha Synthesis](syntheses/alpha-synthesis.md)",
    );
  });

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

    expect(parsed.frontmatter).toMatchObject({
      pageType: "entity",
      id: "entity.alpha",
      title: "Alpha",
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
      status: "review",
    });
    expect(parsed.frontmatter).not.toHaveProperty("confidence");
    expect(parsed.body).toContain("keep this note");
    expect(parsed.body).toContain("<!-- openclaw:human:start -->");
    await expect(
      fs.readFile(path.join(rootDir, "entities", "index.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md)");
  });
});
