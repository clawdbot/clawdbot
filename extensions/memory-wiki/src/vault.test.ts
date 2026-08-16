// Memory Wiki tests cover vault plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configureMemoryWikiCompiledCacheStore } from "./compiled-cache.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { activateExistingMemoryWikiVault, initializeMemoryWikiVault } from "./vault.js";

const { configureCompiledCacheStore, createVault } = createMemoryWikiTestHarness();

describe("initializeMemoryWikiVault", () => {
  it("creates the wiki layout and seed files", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-",
      config: {
        vault: {
          renderMode: "obsidian",
        },
      },
    });

    const result = await initializeMemoryWikiVault(config, {
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    expect(result.created).toBe(true);
    await Promise.all(
      ["sources", "entities", "concepts", "syntheses", "reports"].map(async (relativeDir) => {
        const dirStat = await fs.stat(path.join(rootDir, relativeDir));
        expect(dirStat.isDirectory()).toBe(true);
      }),
    );
    await expect(fs.readFile(path.join(rootDir, "AGENTS.md"), "utf8")).resolves.toContain(
      "Memory Wiki Agent Guide",
    );
    await expect(fs.readFile(path.join(rootDir, "WIKI.md"), "utf8")).resolves.toContain(
      "Render mode: `obsidian`",
    );
    await expect(fs.readFile(path.join(rootDir, "WIKI.md"), "utf8")).resolves.toContain(
      "snapshots live in OpenClaw plugin state",
    );
    await expect(fs.access(path.join(rootDir, ".openclaw-wiki", "cache"))).rejects.toThrow(
      /ENOENT/,
    );
    await expect(fs.access(path.join(rootDir, ".openclaw-wiki", "state.json"))).rejects.toThrow(
      /ENOENT/,
    );
    await expect(fs.access(path.join(rootDir, ".openclaw-wiki", "locks"))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("is idempotent when the vault already exists", async () => {
    const { config } = await createVault({
      prefix: "memory-wiki-",
    });

    await initializeMemoryWikiVault(config);
    const second = await initializeMemoryWikiVault(config);

    expect(second.created).toBe(false);
    expect(second.createdDirectories).toHaveLength(0);
    expect(second.createdFiles).toHaveLength(0);
  });

  it("reactivates an existing vault without recreating scaffold or rewriting source pages", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-",
      initialize: true,
    });
    const sourcePath = path.join(rootDir, "sources", "preserved.md");
    const source = "# Preserved\n";
    const removedScaffoldPath = path.join(rootDir, "AGENTS.md");
    await fs.writeFile(sourcePath, source, "utf8");
    await fs.rm(removedScaffoldPath);
    configureMemoryWikiCompiledCacheStore(undefined);
    configureCompiledCacheStore();

    await activateExistingMemoryWikiVault(config);

    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
    await expect(fs.access(removedScaffoldPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
