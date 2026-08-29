// Memory Wiki tests cover the wiki overview plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { listMemoryWikiOverview } from "./wiki-overview.js";

const { createVault } = createMemoryWikiTestHarness();

describe("listMemoryWikiOverview", () => {
  it("serves the immutable compiled projection without rereading source markdown", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-overview-cache-",
      initialize: true,
    });
    await fs.mkdir(path.join(rootDir, "entities"), { recursive: true });
    const entityPath = path.join(rootDir, "entities", "cached.md");
    await fs.writeFile(
      entityPath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          title: "Cached entity",
          claims: [{ text: "The compiled dashboard is immutable." }],
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        body: "# Cached entity\n\nThe dashboard reads this summary from the publication.",
      }),
      "utf8",
    );
    await compileMemoryWikiVault(config);
    await fs.rm(entityPath);

    const result = await listMemoryWikiOverview(config);
    const entity = result.clusters.find((cluster) => cluster.key === "entity")?.items[0];
    expect(entity?.title).toBe("Cached entity");
    expect(entity?.snippet).toBe("The dashboard reads this summary from the publication.");
  });

  it("keeps cached overview eligibility and ordering aligned with the raw reader", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-overview-cache-parity-",
      initialize: true,
    });
    await fs.mkdir(path.join(rootDir, "entities"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "reports"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "entities", "a.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          title: "Alpha",
          claims: [{ text: "Alpha has one claim." }],
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        body: "# Alpha\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "b.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          title: "Zulu",
          claims: [{ text: "Zulu has the first claim." }, { text: "Zulu has the second claim." }],
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
        body: "# Zulu\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "empty.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          title: "Empty source",
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
        body: "# Empty source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "reports", "empty.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "report",
          title: "Empty report",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
        body: "# Empty report\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    const result = await listMemoryWikiOverview(config);
    const entityItems = result.clusters.find((cluster) => cluster.key === "entity")?.items ?? [];

    expect(entityItems.map((item) => item.title)).toEqual(["Zulu", "Alpha"]);
    expect(result.clusters.some((cluster) => cluster.key === "source")).toBe(false);
    expect(result.clusters.some((cluster) => cluster.key === "report")).toBe(false);
  });

  it("groups wiki pages by kind and surfaces claims, questions, and contradictions", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-overview-",
      initialize: true,
    });

    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "entities"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "travel-system.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          id: "synthesis.travel.system",
          title: "Travel system",
          claims: [
            { text: "Mariano prefers direct receipts from airlines when possible." },
            { text: "Travel admin friction keeps showing up across chats." },
          ],
          questions: ["Should flight receipts be standardized into one process?"],
          contradictions: ["Old BA receipts guidance may now be stale."],
          updatedAt: "2026-04-10T12:00:00.000Z",
        },
        body: [
          "# Travel system",
          "",
          "This synthesis rolls up recurring travel admin patterns from imported chats.",
          "",
        ].join("\n"),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "raw-chat.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.raw.chat",
          title: "Raw chat source",
          sourceType: "chatgpt",
          updatedAt: "2026-04-08T08:00:00.000Z",
        },
        body: ["# Raw chat source", "", "Original imported source with no claim rows.", ""].join(
          "\n",
        ),
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "entities", "mariano.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.mariano",
          title: "Mariano",
          claims: [{ text: "He prefers compact, inspectable systems." }],
          updatedAt: "2026-04-09T08:00:00.000Z",
        },
        body: ["# Mariano", "", "Primary operator profile page.", ""].join("\n"),
      }),
      "utf8",
    );

    const result = await listMemoryWikiOverview(config);

    expect(result.totalItems).toBe(2);
    expect(result.totalPages).toBe(3);
    expect(result.pageCounts).toEqual({
      synthesis: 1,
      entity: 1,
      concept: 0,
      source: 1,
      report: 0,
    });
    expect(result.totalClaims).toBe(3);
    expect(result.totalQuestions).toBe(1);
    expect(result.totalContradictions).toBe(1);

    const synthesisCluster = result.clusters[0];
    expect(synthesisCluster?.key).toBe("synthesis");
    expect(synthesisCluster?.label).toBe("Syntheses");
    expect(synthesisCluster?.itemCount).toBe(1);
    expect(synthesisCluster?.claimCount).toBe(2);
    expect(synthesisCluster?.questionCount).toBe(1);
    expect(synthesisCluster?.contradictionCount).toBe(1);

    const synthesisItem = synthesisCluster?.items[0];
    expect(synthesisItem?.title).toBe("Travel system");
    expect(synthesisItem?.claims).toEqual([
      "Mariano prefers direct receipts from airlines when possible.",
      "Travel admin friction keeps showing up across chats.",
    ]);
    expect(synthesisItem?.questions).toEqual([
      "Should flight receipts be standardized into one process?",
    ]);
    expect(synthesisItem?.contradictions).toEqual(["Old BA receipts guidance may now be stale."]);
    expect(synthesisItem?.snippet).toBe(
      "This synthesis rolls up recurring travel admin patterns from imported chats.",
    );

    const entityCluster = result.clusters[1];
    expect(entityCluster?.key).toBe("entity");
    expect(entityCluster?.label).toBe("Entities");
    expect(entityCluster?.itemCount).toBe(1);
    expect(entityCluster?.claimCount).toBe(1);
  });
});
