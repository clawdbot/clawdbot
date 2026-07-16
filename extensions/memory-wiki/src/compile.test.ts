import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("compileMemoryWikiVault", () => {
  let suiteRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-compile-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  function nextCaseRoot() {
    return path.join(suiteRoot, `case-${caseId++}`);
  }

  it("writes root and directory indexes for native markdown", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha",
          claims: [
            {
              id: "claim.alpha.doc",
              text: "Alpha is the canonical source page.",
              status: "supported",
              evidence: [{ sourceId: "source.alpha", lines: "1-3" }],
            },
          ],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.source).toBe(1);
    expect(result.claimCount).toBe(1);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "- Claims: 1",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "index.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    const agentDigest = JSON.parse(
      await fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"), "utf8"),
    ) as {
      claimCount: number;
      pages: Array<{ path: string; claimCount: number; topClaims: Array<{ text: string }> }>;
    };
    expect(agentDigest.claimCount).toBe(1);
    expect(agentDigest.pages).toContainEqual(
      expect.objectContaining({
        path: "sources/alpha.md",
        claimCount: 1,
        topClaims: [expect.objectContaining({ text: "Alpha is the canonical source page." })],
      }),
    );
    await expect(
      fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "claims.jsonl"), "utf8"),
    ).resolves.toContain('"text":"Alpha is the canonical source page."');
  });

  it("renders obsidian-friendly links when configured", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
      config: {
        vault: { renderMode: "obsidian" },
      },
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[[sources/alpha|Alpha]]",
    );
  });

  it("writes related blocks from source ids and shared sources", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.beta",
          title: "Beta",
          sourceIds: ["source.alpha"],
        },
        body: "# Beta\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.gamma",
          title: "Gamma",
          sourceIds: ["source.alpha"],
        },
        body: "# Gamma\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "## Related",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Alpha](sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Beta](entities/beta.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
  });

  it("writes dashboard report pages when createDashboards is enabled", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
          questions: ["What changed after launch?"],
          contradictions: ["Conflicts with source.beta"],
          confidence: 0.3,
          claims: [
            {
              id: "claim.alpha.db",
              text: "Alpha uses PostgreSQL for production writes.",
              status: "supported",
              confidence: 0.4,
              evidence: [],
            },
          ],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "alpha-db.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.alpha.db",
          title: "Alpha DB",
          sourceIds: ["source.alpha"],
          updatedAt: "2025-10-01T00:00:00.000Z",
          claims: [
            {
              id: "claim.alpha.db",
              text: "Alpha uses MySQL for production writes.",
              status: "contested",
              confidence: 0.62,
              evidence: [
                {
                  sourceId: "source.alpha",
                  lines: "9-11",
                  updatedAt: "2025-10-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        body: "# Alpha DB\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.report).toBeGreaterThanOrEqual(5);
    await expect(
      fs.readFile(path.join(rootDir, "reports", "open-questions.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): What changed after launch?");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("Conflicts with source.beta: [Alpha](entities/alpha.md)");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("`claim.alpha.db`");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): confidence 0.30");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("Alpha uses PostgreSQL for production writes.");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "claim-health.md"), "utf8"),
    ).resolves.toContain("Missing Evidence");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "claim-health.md"), "utf8"),
    ).resolves.toContain("Alpha uses PostgreSQL for production writes.");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "stale-pages.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md): missing updatedAt");
    const agentDigest = JSON.parse(
      await fs.readFile(path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json"), "utf8"),
    ) as {
      claimHealth: { missingEvidence: number; freshness: { unknown: number } };
      contradictionClusters: Array<{ key: string }>;
    };
    expect(agentDigest.claimHealth.missingEvidence).toBeGreaterThanOrEqual(1);
    expect(agentDigest.claimHealth.freshness.unknown).toBeGreaterThanOrEqual(1);
    expect(agentDigest.contradictionClusters).toContainEqual(
      expect.objectContaining({ key: "claim.alpha.db" }),
    );
  });

  it("skips dashboard report pages when createDashboards is disabled", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
      config: {
        render: { createDashboards: false },
      },
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.alpha"],
          questions: ["What changed after launch?"],
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(fs.access(path.join(rootDir, "reports", "open-questions.md"))).rejects.toThrow();
  });

  it("ignores generated related links when computing backlinks on repeated compile", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "beta.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "entity", id: "entity.beta", title: "Beta" },
        body: "# Beta\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "gamma.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "concept", id: "concept.gamma", title: "Gamma" },
        body: "# Gamma\n\nSee [Beta](entities/beta.md).\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);
    const second = await compileMemoryWikiVault(config);

    expect(second.updatedFiles).toEqual([]);
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](concepts/gamma.md)",
    );
    await expect(
      fs.readFile(path.join(rootDir, "concepts", "gamma.md"), "utf8"),
    ).resolves.not.toContain("### Referenced By");
  });
});
