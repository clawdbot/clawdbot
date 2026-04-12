import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

const { createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiUnsafeLocalSources", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-unsafe-suite-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function nextCaseRoot(name: string): string {
    return path.join(fixtureRoot, `case-${caseId++}-${name}`);
  }

  async function createPrivateDir(name: string): Promise<string> {
    const privateDir = nextCaseRoot(name);
    await fs.mkdir(privateDir, { recursive: true });
    return privateDir;
  }

  it("imports explicit private paths and preserves unsafe-local provenance", async () => {
    const privateDir = await createPrivateDir("private");

    await fs.mkdir(path.join(privateDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(privateDir, "nested", "state.md"), "# internal state\n", "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "cache.json"), '{"ok":true}\n', "utf8");
    await fs.writeFile(path.join(privateDir, "nested", "blob.bin"), "\u0000\u0001", "utf8");
    const directPath = path.join(privateDir, "events.log");
    await fs.writeFile(directPath, "private log\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [path.join(privateDir, "nested"), directPath],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);

    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.removedCount).toBe(0);

    const page = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-unsafe-local");
    expect(page).toContain("provenanceMode: unsafe-local");

    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.removedCount).toBe(0);
  });

  it("prunes stale unsafe-local pages when configured files disappear", async () => {
    const privateDir = await createPrivateDir("private-prune");

    const secretPath = path.join(privateDir, "secret.md");
    await fs.writeFile(secretPath, "# private\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("prune-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [secretPath],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const firstPagePath = first.pagePaths[0] ?? "";
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).resolves.toBeTruthy();

    await fs.rm(secretPath);
    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.artifactCount).toBe(0);
    expect(second.removedCount).toBe(1);
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("caps composed unsafe-local filenames to the filesystem component limit", async () => {
    const privateDir = await createPrivateDir(`${"漢".repeat(50)}-private`);
    const nestedDir = path.join(privateDir, `${"語".repeat(50)}-nested`);
    const secretPath = path.join(nestedDir, `${"録".repeat(50)}.md`);
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(secretPath, "# very private\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("long-unsafe-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const result = await syncMemoryWikiUnsafeLocalSources(config);
    const pagePath = result.pagePaths[0] ?? "";

    expect(result.importedCount).toBe(1);
    expect(Buffer.byteLength(path.basename(pagePath))).toBeLessThanOrEqual(255);
    await expect(fs.stat(path.join(vaultDir, pagePath))).resolves.toBeTruthy();
  });
});
