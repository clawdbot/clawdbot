import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMemoryWikiMutation } from "./apply.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { slugifyWikiPageStem, slugifyWikiSegment } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault, createTempDir } = createMemoryWikiTestHarness();

describe("reserved index.md filename collision (repro)", () => {
  it("create_synthesis titled Index stays retrievable", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-reserved-" });

    const applied = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Index",
        body: "Durable synthesis body that must survive.",
        sourceIds: ["source.alpha"],
      },
    });

    const found = await searchMemoryWiki({
      config,
      query: "Durable synthesis body that must survive",
      maxResults: 10,
    });
    expect(found.some((hit) => hit.path === applied.pagePath)).toBe(true);

    const fetched = await getMemoryWikiPage({ config, lookup: applied.pagePath });
    expect(fetched?.content).toContain("Durable synthesis body that must survive.");
    expect(applied.pageId).toBe("synthesis.index");
    expect(await getMemoryWikiPage({ config, lookup: "synthesis.index" })).not.toBeNull();

    const onDisk = await fs.readFile(path.join(rootDir, applied.pagePath), "utf8");
    expect(onDisk).toContain("Durable synthesis body that must survive.");
  });

  it("ingest of a file titled Index stays retrievable", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-reserved-ingest-" });
    const inputDir = await createTempDir("memory-wiki-reserved-input-");
    const inputPath = path.join(inputDir, "notes.md");
    await fs.writeFile(inputPath, "Unique ingest content sentinel ZZZ.", "utf8");

    const result = await ingestMemoryWikiSource({
      config,
      inputPath,
      title: "Index",
    });

    const found = await searchMemoryWiki({
      config,
      query: "Unique ingest content sentinel ZZZ",
      maxResults: 10,
    });
    expect(found.some((hit) => hit.path === result.pagePath)).toBe(true);
    expect(result.pageId).toBe("source.index");
    expect(await getMemoryWikiPage({ config, lookup: result.pageId })).not.toBeNull();
  });

  it("disambiguates the compiler-owned index stem but leaves shared slug output stable", () => {
    expect(slugifyWikiSegment("Index")).toBe("index");

    expect(slugifyWikiPageStem("Index")).toMatch(/^index-[0-9a-f]{12}$/);
    expect(slugifyWikiPageStem(" INDEX ")).toBe(slugifyWikiPageStem("Index"));
    expect(slugifyWikiPageStem("Log")).toBe("log");
    expect(slugifyWikiPageStem("Overview")).toBe("overview");
  });
});
