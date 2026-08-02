// Memory Wiki tests cover bounded batch behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMemoryWikiApplyBatch, runMemoryWikiSearchBatch } from "./batch.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

describe("memory-wiki batch operations", () => {
  it("preflights without writes, compiles once, and becomes a no-op", async () => {
    const tempDir = await createTempDir("memory-wiki-batch-");
    const sourcePath = path.join(tempDir, "alpha.txt");
    const applyPath = path.join(tempDir, "apply.json");
    await fs.writeFile(sourcePath, "Alpha source evidence.\n", "utf8");
    const { rootDir, config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(applyPath, {
      version: 1,
      operations: [
        {
          id: "source",
          kind: "ingest-source",
          inputPath: sourcePath,
          title: "Alpha Reference",
          evidence: {
            sourceType: "evidence-primary-document",
            type: "primary_document",
            kind: "primary_document",
            origin: "test-fixture",
            directness: "primary",
            weight: 1,
          },
        },
        {
          id: "synthesis",
          kind: "upsert-synthesis",
          title: "Alpha Synthesis",
          body: "Alpha explanatory summary.",
          sourceRefs: ["source"],
          confidence: 0.8,
          status: "active",
        },
      ],
    });

    const planned = await runMemoryWikiApplyBatch({ config, inputPath: applyPath, dryRun: true });
    expect(planned.changed).toBe(true);
    await expect(fs.stat(path.join(rootDir, "sources", "alpha-reference.md"))).rejects.toThrow();

    const applied = await runMemoryWikiApplyBatch({ config, inputPath: applyPath });
    expect(applied.changed).toBe(true);
    expect(applied.operationCount).toBe(2);
    expect(applied.compile?.pageCounts.source).toBe(1);
    expect(applied.compile?.pageCounts.synthesis).toBe(1);

    const repeated = await runMemoryWikiApplyBatch({ config, inputPath: applyPath, dryRun: true });
    expect(repeated.changed).toBe(false);
    expect(repeated.compile).toBeNull();

    const indexPath = path.join(rootDir, "index.md");
    await fs.rm(indexPath);
    const repaired = await runMemoryWikiApplyBatch({ config, inputPath: applyPath });
    expect(repaired.changed).toBe(true);
    expect(repaired.operations.every((operation) => operation.changed === false)).toBe(true);
    expect(repaired.compile).not.toBeNull();
    await expect(fs.readFile(indexPath, "utf8")).resolves.toContain(
      "[Alpha Reference](sources/alpha-reference.md)",
    );
  });

  it("verifies exact, explanatory, and evidence queries from one batch", async () => {
    const tempDir = await createTempDir("memory-wiki-search-batch-");
    const sourcePath = path.join(tempDir, "alpha.txt");
    const applyPath = path.join(tempDir, "apply.json");
    const searchPath = path.join(tempDir, "search.json");
    await fs.writeFile(sourcePath, "Alpha source evidence.\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(applyPath, {
      version: 1,
      operations: [
        {
          id: "source",
          kind: "ingest-source",
          inputPath: sourcePath,
          title: "Alpha Reference",
        },
        {
          id: "synthesis",
          kind: "upsert-synthesis",
          title: "Alpha Synthesis",
          body: "Alpha explanatory summary.",
          sourceRefs: ["source"],
        },
      ],
    });
    await runMemoryWikiApplyBatch({ config, inputPath: applyPath });
    await writeJson(searchPath, {
      version: 1,
      queries: [
        {
          id: "exact-document",
          query: "Alpha Reference",
          expectedPaths: ["sources/alpha-reference.md"],
          expectedPageTypes: ["source"],
        },
        {
          id: "explanatory",
          query: "Alpha explanatory summary",
          expectedIds: ["synthesis.alpha-synthesis"],
          expectedPageTypes: ["synthesis"],
        },
        {
          id: "evidence",
          query: "Alpha source evidence",
          mode: "source-evidence",
          expectedIds: ["source.alpha-reference"],
          expectedPageTypes: ["source"],
        },
      ],
    });

    const result = await runMemoryWikiSearchBatch({ config, inputPath: searchPath });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((item) => item.ok)).toBe(true);
    expect(result.results.every((item) => item.candidatePageCount <= 2)).toBe(true);
  });

  it("keeps ordered operations and one compile under one vault lease", async () => {
    const tempDir = await createTempDir("memory-wiki-batch-lease-");
    const sourcePath = path.join(tempDir, "ordered.txt");
    const applyPath = path.join(tempDir, "apply.json");
    await fs.writeFile(sourcePath, "Ordered source evidence.\n", "utf8");
    const { rootDir, config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(applyPath, {
      version: 1,
      operations: [
        {
          id: "source-first",
          kind: "ingest-source",
          inputPath: sourcePath,
          title: "Ordered Reference",
        },
        {
          id: "synthesis-second",
          kind: "upsert-synthesis",
          title: "Ordered Synthesis",
          body: "Built from the earlier source operation.",
          sourceRefs: ["source-first"],
        },
      ],
    });
    const enqueue = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");

    const result = await runMemoryWikiApplyBatch({ config, inputPath: applyPath });

    expect(result.operations.map((operation) => operation.id)).toEqual([
      "source-first",
      "synthesis-second",
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const log = await fs.readFile(path.join(rootDir, ".openclaw-wiki", "log.jsonl"), "utf8");
    expect(log.match(/"pageCounts"/g)).toHaveLength(1);
  });

  it("rejects expected paths outside the wiki page directories", async () => {
    const tempDir = await createTempDir("memory-wiki-search-path-");
    const searchPath = path.join(tempDir, "search.json");
    const { config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(searchPath, {
      version: 1,
      queries: [
        {
          id: "escape",
          query: "secret",
          expectedPaths: ["../secret.md"],
          expectedPageTypes: ["source"],
        },
      ],
    });

    await expect(runMemoryWikiSearchBatch({ config, inputPath: searchPath })).rejects.toThrow(
      "invalid wiki path",
    );
  });

  it("matches exact paths case-sensitively", async () => {
    const tempDir = await createTempDir("memory-wiki-search-path-case-");
    const sourcePath = path.join(tempDir, "alpha.txt");
    const applyPath = path.join(tempDir, "apply.json");
    const searchPath = path.join(tempDir, "search.json");
    await fs.writeFile(sourcePath, "Alpha source evidence.\n", "utf8");
    const { config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(applyPath, {
      version: 1,
      operations: [
        {
          id: "source",
          kind: "ingest-source",
          inputPath: sourcePath,
          title: "Alpha Reference",
        },
      ],
    });
    await runMemoryWikiApplyBatch({ config, inputPath: applyPath });
    await writeJson(searchPath, {
      version: 1,
      queries: [
        {
          id: "wrong-case",
          query: "Alpha Reference",
          expectedPaths: ["sources/ALPHA-reference.md"],
          expectedPageTypes: ["source"],
          required: false,
        },
      ],
    });

    const result = await runMemoryWikiSearchBatch({ config, inputPath: searchPath });
    expect(result.results[0]).toMatchObject({
      id: "wrong-case",
      ok: false,
      matchedPath: null,
      resultCount: 1,
    });
  });

  it("reports a missing optional target without aborting the batch", async () => {
    const tempDir = await createTempDir("memory-wiki-search-optional-");
    const searchPath = path.join(tempDir, "search.json");
    const { config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(searchPath, {
      version: 1,
      queries: [
        {
          id: "optional-missing",
          query: "Missing reference",
          expectedPaths: ["sources/missing-reference.md"],
          required: false,
        },
      ],
    });

    const result = await runMemoryWikiSearchBatch({ config, inputPath: searchPath });
    expect(result.ok).toBe(true);
    expect(result.results[0]).toMatchObject({
      id: "optional-missing",
      ok: false,
      required: false,
      candidatePageCount: 0,
    });
  });

  it("rejects every invalid source before writing an earlier operation", async () => {
    const tempDir = await createTempDir("memory-wiki-batch-preflight-");
    const validSourcePath = path.join(tempDir, "valid.txt");
    const binarySourcePath = path.join(tempDir, "binary.dat");
    const applyPath = path.join(tempDir, "apply.json");
    await fs.writeFile(validSourcePath, "valid source\n", "utf8");
    await fs.writeFile(binarySourcePath, Buffer.from([0, 1, 2, 3]));
    const { rootDir, config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(applyPath, {
      version: 1,
      operations: [
        { id: "valid", kind: "ingest-source", inputPath: validSourcePath, title: "Valid" },
        { id: "binary", kind: "ingest-source", inputPath: binarySourcePath, title: "Binary" },
      ],
    });

    await expect(runMemoryWikiApplyBatch({ config, inputPath: applyPath })).rejects.toThrow(
      "Cannot ingest binary file",
    );
    await expect(fs.stat(path.join(rootDir, "sources", "valid.md"))).rejects.toThrow();
  });

  it("rejects negative evidence weight during preflight", async () => {
    const tempDir = await createTempDir("memory-wiki-batch-evidence-");
    const sourcePath = path.join(tempDir, "source.txt");
    const applyPath = path.join(tempDir, "apply.json");
    await fs.writeFile(sourcePath, "source\n", "utf8");
    const { rootDir, config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(applyPath, {
      version: 1,
      operations: [
        {
          id: "source",
          kind: "ingest-source",
          inputPath: sourcePath,
          title: "Source",
          evidence: {
            sourceType: "evidence-primary-document",
            type: "primary_document",
            kind: "primary_document",
            origin: "test-fixture",
            directness: "primary",
            weight: -1,
          },
        },
      ],
    });

    await expect(runMemoryWikiApplyBatch({ config, inputPath: applyPath })).rejects.toThrow(
      "non-negative finite numeric weight",
    );
    await expect(fs.stat(path.join(rootDir, "sources", "source.md"))).rejects.toThrow();
  });

  it.each([
    {
      name: "source",
      operations: (sourcePath: string) => [
        { id: "first", kind: "ingest-source", inputPath: sourcePath, title: "Duplicate" },
        { id: "second", kind: "ingest-source", inputPath: sourcePath, title: "duplicate" },
      ],
    },
    {
      name: "synthesis",
      operations: (sourcePath: string) => [
        { id: "source", kind: "ingest-source", inputPath: sourcePath, title: "Evidence" },
        {
          id: "first",
          kind: "upsert-synthesis",
          title: "Duplicate",
          body: "first",
          sourceRefs: ["source"],
        },
        {
          id: "second",
          kind: "upsert-synthesis",
          title: "duplicate",
          body: "second",
          sourceRefs: ["source"],
        },
      ],
    },
  ])("rejects duplicate $name page targets during preflight", async ({ operations }) => {
    const tempDir = await createTempDir("memory-wiki-batch-target-");
    const sourcePath = path.join(tempDir, "source.txt");
    const applyPath = path.join(tempDir, "apply.json");
    await fs.writeFile(sourcePath, "source\n", "utf8");
    const { rootDir, config } = await createVault({
      rootDir: path.join(tempDir, "vault"),
      initialize: true,
    });
    await writeJson(applyPath, { version: 1, operations: operations(sourcePath) });

    await expect(runMemoryWikiApplyBatch({ config, inputPath: applyPath })).rejects.toThrow(
      "target the same page",
    );
    await expect(fs.stat(path.join(rootDir, "sources", "evidence.md"))).rejects.toThrow();
  });
});
