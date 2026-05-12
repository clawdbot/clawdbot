import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderWikiMarkdown } from "./markdown.js";
import { listMemoryWikiPalace } from "./memory-palace.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("listMemoryWikiPalace", () => {
  it("groups wiki pages by kind and surfaces claims, questions, and contradictions", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-palace-",
      initialize: true,
    });

    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "entities"), { recursive: true });
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

    const result = await listMemoryWikiPalace(config);

    expect(result.totalItems).toBe(2);
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
