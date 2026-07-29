// Memory Wiki tests cover compile plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { loadMemoryWikiCompiledCache } from "./compiled-cache.js";
import { renderWikiMarkdown, WIKI_RAW_SOURCE_MARKER } from "./markdown.js";
import { writeMemoryWikiSourceSyncState } from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("compileMemoryWikiVault", () => {
  let suiteRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-compile-suite-"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  function nextCaseRoot() {
    return path.join(suiteRoot, `case-${caseId++}`);
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    let error: unknown;
    try {
      await fs.access(targetPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }

  function expectDigestPage<T extends { path: string }>(pages: T[], pagePath: string): T {
    const page = pages.find((candidate) => candidate.path === pagePath);
    if (!page) {
      throw new Error(`Expected digest page ${pagePath}`);
    }
    return page;
  }

  async function expectCompiledCache(config: Parameters<typeof compileMemoryWikiVault>[0]) {
    const snapshot = await loadMemoryWikiCompiledCache(config);
    if (!snapshot) {
      throw new Error(`Expected compiled cache for ${config.vault.path}`);
    }
    return snapshot;
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
      "[Alpha](alpha.md)",
    );
    const { digest: agentDigest, claims } = await expectCompiledCache(config);
    expect(agentDigest.claimCount).toBe(1);
    const alphaPage = expectDigestPage(agentDigest.pages, "sources/alpha.md");
    expect(alphaPage.claimCount).toBe(1);
    expect(alphaPage.topClaims.map((claim) => claim.text)).toEqual([
      "Alpha is the canonical source page.",
    ]);
    expect(claims.map((claim) => claim.text)).toContain("Alpha is the canonical source page.");
  });

  it("excludes malformed pages from indexes, digests, counts, and page writes (#96125)", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
      config: { render: { createDashboards: false } },
    });
    const brokenPath = path.join(rootDir, "syntheses", "broken.md");
    const brokenPage = [
      "---",
      "pageType: synthesis",
      "id: synthesis.broken",
      "sourceIds:",
      '  - **MEMORY.md line 235**:"some quoted, value"',
      "---",
      "",
      "# Broken",
      "",
      "Body that compile must not rewrite.",
    ].join("\n");
    await fs.writeFile(brokenPath, brokenPage, "utf8");
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

    const result = await compileMemoryWikiVault(config);

    expect(result.frontmatterErrors).toHaveLength(1);
    expect(result.frontmatterErrors[0]).toMatchObject({
      relativePath: "syntheses/broken.md",
    });
    expect(result.pageCounts.synthesis).toBe(1);
    expect(result.pages.map((page) => page.relativePath)).not.toContain("syntheses/broken.md");
    await expect(fs.readFile(brokenPath, "utf8")).resolves.toBe(brokenPage);
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.not.toContain(
      "Broken",
    );
    expect((await expectCompiledCache(config)).digest.pages.map((page) => page.path)).not.toContain(
      "syntheses/broken.md",
    );
  });

  it.each([
    {
      name: "root index with syntax-error frontmatter",
      relativePath: "index.md",
      frontmatterLines: [
        "pageType: report",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
      ],
      error: "Unexpected scalar",
    },
    {
      name: "root index with sequence-root frontmatter",
      relativePath: "index.md",
      frontmatterLines: ["- pageType: report"],
      error: "Wiki frontmatter must be a YAML mapping",
    },
    {
      name: "directory index with syntax-error frontmatter",
      relativePath: "sources/index.md",
      frontmatterLines: [
        "pageType: report",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
      ],
      error: "Unexpected scalar",
    },
    {
      name: "directory index with scalar-root frontmatter",
      relativePath: "sources/index.md",
      frontmatterLines: ["report"],
      error: "Wiki frontmatter must be a YAML mapping",
    },
  ])(
    "rejects $name without changing its bytes",
    async ({ relativePath, frontmatterLines, error }) => {
      const { rootDir, config } = await createVault({
        rootDir: nextCaseRoot(),
        initialize: true,
        config: { render: { createDashboards: false } },
      });
      const targetPath = path.join(rootDir, relativePath);
      const original = [
        "---",
        ...frontmatterLines,
        "---",
        "",
        "# Existing Index",
        "",
        "Keep this body.",
      ].join("\n");
      await fs.writeFile(targetPath, original, "utf8");

      await expect(compileMemoryWikiVault(config)).rejects.toThrow(error);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(original);
    },
  );

  it("discovers pages in nested subdirectories during compile", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.mkdir(path.join(rootDir, "sources", "sub"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "top.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.top", title: "Top Source" },
        body: "# Top Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "sub", "nested.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.nested", title: "Nested Source" },
        body: "# Nested Source\n",
      }),
      "utf8",
    );

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.source).toBe(2);
    // Root index should link to both
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Top Source](sources/top.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Nested Source](sources/sub/nested.md)",
    );
    // Sources index should link to nested file
    await expect(fs.readFile(path.join(rootDir, "sources", "index.md"), "utf8")).resolves.toContain(
      "[Nested Source](sub/nested.md)",
    );
  });

  it("renders native directory index links relative to each generated index", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "concepts", "alpha-concept.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "concept", id: "concept.alpha", title: "Alpha Concept" },
        body: "# Alpha Concept\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha-entity.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "entity", id: "entity.alpha", title: "Alpha Entity" },
        body: "# Alpha Entity\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-synthesis.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "synthesis", id: "synthesis.alpha", title: "Alpha Synthesis" },
        body: "# Alpha Synthesis\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(
      fs.readFile(path.join(rootDir, "concepts", "index.md"), "utf8"),
    ).resolves.toContain("[Alpha Concept](alpha-concept.md)");
    await expect(
      fs.readFile(path.join(rootDir, "entities", "index.md"), "utf8"),
    ).resolves.toContain("[Alpha Entity](alpha-entity.md)");
    await expect(
      fs.readFile(path.join(rootDir, "syntheses", "index.md"), "utf8"),
    ).resolves.toContain("[Alpha Synthesis](alpha-synthesis.md)");
  });

  it("bounds concurrent page reads while compiling", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    for (let index = 0; index < 24; index += 1) {
      await fs.writeFile(
        path.join(rootDir, "sources", `page-${index}.md`),
        renderWikiMarkdown({
          frontmatter: {
            pageType: "source",
            id: `source.page-${index}`,
            title: `Page ${index}`,
          },
          body: `# Page ${index}\n`,
        }),
        "utf8",
      );
    }

    const originalReadFile = fs.readFile.bind(fs);
    let activePageReads = 0;
    let maxActivePageReads = 0;
    const readFileSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        const targetPath = args[0];
        const isTestPageRead =
          typeof targetPath === "string" &&
          targetPath.startsWith(path.join(rootDir, "sources", "page-"));
        if (!isTestPageRead) {
          return await originalReadFile(...args);
        }

        activePageReads += 1;
        maxActivePageReads = Math.max(maxActivePageReads, activePageReads);
        try {
          await Promise.resolve();
          return await originalReadFile(...args);
        } finally {
          activePageReads -= 1;
        }
      });

    try {
      await compileMemoryWikiVault(config);
    } finally {
      readFileSpy.mockRestore();
    }

    expect(maxActivePageReads).toBeGreaterThan(0);
    expect(maxActivePageReads).toBeLessThanOrEqual(16);
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
      "[Alpha](../sources/alpha.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](../concepts/gamma.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Beta](../entities/beta.md)",
    );
    await expect(fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8")).resolves.toContain(
      "[Gamma](../concepts/gamma.md)",
    );
  });

  it("renders native synthesis related and source links relative to the synthesis page", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts", "alpha-concept.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.alpha",
          title: "Alpha Concept",
          sourceIds: ["source.alpha"],
        },
        body: "# Alpha Concept\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "syntheses", "alpha-synthesis.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.alpha",
          title: "Alpha Synthesis",
          sourceIds: ["source.alpha"],
        },
        body: "# Alpha Synthesis\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    const synthesis = await fs.readFile(
      path.join(rootDir, "syntheses", "alpha-synthesis.md"),
      "utf8",
    );
    expect(synthesis).toContain("### Sources\n\n- [Alpha Source](../sources/alpha.md)");
    expect(synthesis).toContain(
      "### Related Pages\n\n- [Alpha Concept](../concepts/alpha-concept.md)",
    );
  });

  it("does not rewrite empty source pages into related-only stubs", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });
    const emptySourcePath = path.join(rootDir, "sources", "empty.md");
    const whitespaceSourcePath = path.join(rootDir, "sources", "whitespace.md");
    await fs.writeFile(emptySourcePath, "", "utf8");
    await fs.writeFile(whitespaceSourcePath, " \n\t", "utf8");

    const result = await compileMemoryWikiVault(config);

    await expect(fs.readFile(emptySourcePath, "utf8")).resolves.toBe("");
    await expect(fs.readFile(whitespaceSourcePath, "utf8")).resolves.toBe(" \n\t");
    expect(result.updatedFiles).not.toContain(emptySourcePath);
    expect(result.updatedFiles).not.toContain(whitespaceSourcePath);
  });

  it("does not relate every page through a broad shared source", async () => {
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

    for (let index = 0; index < 30; index += 1) {
      await fs.writeFile(
        path.join(rootDir, "entities", `entity-${index}.md`),
        renderWikiMarkdown({
          frontmatter: {
            pageType: "entity",
            id: `entity.${index}`,
            title: `Entity ${index}`,
            sourceIds: ["source.alpha"],
          },
          body: `# Entity ${index}\n`,
        }),
        "utf8",
      );
    }

    await compileMemoryWikiVault(config);

    const firstEntity = await fs.readFile(path.join(rootDir, "entities", "entity-0.md"), "utf8");
    const sourcePage = await fs.readFile(path.join(rootDir, "sources", "alpha.md"), "utf8");
    expect(firstEntity).toContain("[Alpha](../sources/alpha.md)");
    expect(firstEntity).not.toContain("### Related Pages");
    expect(sourcePage).not.toContain("### Referenced By");
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
    await fs.writeFile(
      path.join(rootDir, "sources", "raw-alpha.md"),
      `# Raw Alpha Source\n\n${WIKI_RAW_SOURCE_MARKER}\n\nRaw source notes stay usable as source evidence.\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "tracked-raw-alpha.md"),
      `# Tracked Raw Alpha Source\n\n${WIKI_RAW_SOURCE_MARKER}\n\nImported source body was damaged.\n`,
      "utf8",
    );
    await writeMemoryWikiSourceSyncState(config.vault.path, {
      version: 1,
      entries: {
        tracked: {
          group: "bridge",
          pagePath: "sources/tracked-raw-alpha.md",
          sourcePath: "/tmp/MEMORY.md",
          sourceUpdatedAtMs: 1,
          sourceSize: 2,
          renderFingerprint: "tracked-fingerprint",
        },
      },
    });

    const result = await compileMemoryWikiVault(config);

    expect(result.pageCounts.report).toBeGreaterThanOrEqual(5);
    await expect(
      fs.readFile(path.join(rootDir, "reports", "open-questions.md"), "utf8"),
    ).resolves.toContain("[Alpha](../entities/alpha.md): What changed after launch?");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("Conflicts with source.beta: [Alpha](../entities/alpha.md)");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "contradictions.md"), "utf8"),
    ).resolves.toContain("`claim.alpha.db`");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "low-confidence.md"), "utf8"),
    ).resolves.toContain("[Alpha](../entities/alpha.md): confidence 0.30");
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
    ).resolves.toContain("[Alpha](../entities/alpha.md): missing updatedAt");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "stale-pages.md"), "utf8"),
    ).resolves.not.toContain("[Raw Alpha Source](../sources/raw-alpha.md)");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "stale-pages.md"), "utf8"),
    ).resolves.toContain("Tracked Raw Alpha Source");
    expect((await expectCompiledCache(config)).digest.contradictionCount).toBeGreaterThanOrEqual(1);
  });

  it("excludes concept and synthesis pages from stale-pages report", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "entity-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha Entity",
          sourceIds: ["source.alpha"],
          updatedAt: "2025-06-01T00:00:00.000Z",
        },
        body: "# Alpha Entity\n",
      }),
      "utf8",
    );

    await fs.writeFile(
      path.join(rootDir, "sources", "source-alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.alpha",
          title: "Alpha Source",
          updatedAt: "2025-06-01T00:00:00.000Z",
        },
        body: "# Alpha Source\n",
      }),
      "utf8",
    );

    // Concept page with old updatedAt — should be excluded from stale-pages
    await fs.writeFile(
      path.join(rootDir, "concepts", "concept-beta.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.beta",
          title: "Beta Concept",
          sourceIds: ["source.alpha"],
          updatedAt: "2025-06-01T00:00:00.000Z",
        },
        body: "# Beta Concept\n",
      }),
      "utf8",
    );

    // Synthesis page with old updatedAt — should be excluded from stale-pages
    await fs.writeFile(
      path.join(rootDir, "syntheses", "synthesis-gamma.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.gamma",
          title: "Gamma Synthesis",
          sourceIds: ["source.alpha"],
          updatedAt: "2025-06-01T00:00:00.000Z",
        },
        body: "# Gamma Synthesis\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    const stalePages = await fs.readFile(path.join(rootDir, "reports", "stale-pages.md"), "utf8");

    // Entity and source pages still appear in stale-pages
    expect(stalePages).toContain("[Alpha Entity](../entities/entity-alpha.md)");
    expect(stalePages).toContain("[Alpha Source](../sources/source-alpha.md)");
    // Concept and synthesis pages are excluded
    expect(stalePages).not.toContain("[Beta Concept](../concepts/concept-beta.md)");
    expect(stalePages).not.toContain("[Gamma Synthesis](../syntheses/synthesis-gamma.md)");
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

    await expectPathMissing(path.join(rootDir, "reports", "open-questions.md"));
  });

  it("writes agent directory, relationship, provenance, and privacy reports", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });

    await fs.writeFile(
      path.join(rootDir, "entities", "brad.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          entityType: "person",
          id: "entity.brad",
          title: "Brad Groux",
          canonicalId: "maintainer.brad-groux",
          aliases: ["brad"],
          privacyTier: "local-private",
          bestUsedFor: ["Microsoft routing"],
          lastRefreshedAt: "2026-04-29T00:00:00.000Z",
          personCard: {
            handles: ["@bgroux"],
            lane: "Microsoft Teams",
            askFor: ["Teams and Azure questions"],
            privacyTier: "confirm-before-use",
          },
          relationships: [
            {
              targetId: "entity.alice",
              targetTitle: "Alice",
              kind: "collaborates-with",
              evidenceKind: "discrawl-stat",
              privacyTier: "local-private",
            },
          ],
          claims: [
            {
              id: "claim.brad.teams",
              text: "Brad is useful for Microsoft Teams routing.",
              status: "supported",
              confidence: 0.9,
              evidence: [
                {
                  kind: "maintainer-whois",
                  sourceId: "source.maintainers",
                  privacyTier: "local-private",
                },
              ],
            },
          ],
        },
        body: "# Brad Groux\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(
      fs.readFile(path.join(rootDir, "reports", "person-agent-directory.md"), "utf8"),
    ).resolves.toContain("[Brad Groux](../entities/brad.md)");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "relationship-graph.md"), "utf8"),
    ).resolves.toContain("[Brad Groux](../entities/brad.md) -> Alice");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "provenance-coverage.md"), "utf8"),
    ).resolves.toContain("maintainer-whois: 1");
    await expect(
      fs.readFile(path.join(rootDir, "reports", "privacy-review.md"), "utf8"),
    ).resolves.toContain("[Brad Groux](../entities/brad.md)");

    const { digest: agentDigest, claims } = await expectCompiledCache(config);
    const bradPage = expectDigestPage(agentDigest.pages, "entities/brad.md");
    expect(bradPage.canonicalId).toBe("maintainer.brad-groux");
    expect(bradPage.aliases).toEqual(["brad"]);
    expect(bradPage.personCard?.lane).toBe("Microsoft Teams");
    expect(bradPage.relationshipCount).toBe(1);
    expect(claims.flatMap((claim) => claim.evidenceKinds ?? [])).toContain("maintainer-whois");
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
        body: "# Gamma\n\nSee [Beta](../entities/beta.md).\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);
    const second = await compileMemoryWikiVault(config);

    expect(second.updatedFiles).toStrictEqual([]);
    await expect(fs.readFile(path.join(rootDir, "entities", "beta.md"), "utf8")).resolves.toContain(
      "[Gamma](../concepts/gamma.md)",
    );
    await expect(
      fs.readFile(path.join(rootDir, "concepts", "gamma.md"), "utf8"),
    ).resolves.not.toContain("### Referenced By");
  });

  it("retries transient page reads during compile", async () => {
    const { rootDir, config } = await createVault({
      rootDir: nextCaseRoot(),
      initialize: true,
    });
    const sourcePath = path.join(rootDir, "sources", "alpha.md");

    await fs.writeFile(
      sourcePath,
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

    const realReadFile = fs.readFile;
    let attempts = 0;
    const readFileSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        const [target, options] = args;
        if (
          typeof target === "string" &&
          path.resolve(target) === sourcePath &&
          options === "utf8" &&
          attempts++ === 0
        ) {
          const err = new Error(
            "Unknown system error -11: Unknown system error -11, read",
          ) as NodeJS.ErrnoException;
          err.code = "EDEADLK";
          err.errno = -11;
          throw err;
        }
        return await realReadFile(target, options as never);
      });

    try {
      const result = await compileMemoryWikiVault(config);
      expect(result.pageCounts.source).toBe(1);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      readFileSpy.mockRestore();
    }
  });
});
