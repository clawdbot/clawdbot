// Memory Wiki tests cover unsafe local plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readMemoryWikiSourceSyncState } from "./source-sync-state.js";
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

  afterEach(() => {
    vi.restoreAllMocks();
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

    const readFile = vi.spyOn(fs, "readFile");
    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.removedCount).toBe(0);
    expect(
      readFile.mock.calls.some(
        ([filePath]) => typeof filePath === "string" && filePath.startsWith(vaultDir),
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "prunes stale unsafe-local pages from an available configured directory",
      humanNotes: null,
    },
    {
      name: "salvages unsafe-local page Notes when configured files disappear",
      humanNotes: "Durable unsafe-local annotation",
    },
  ])("$name", async ({ humanNotes }) => {
    const privateDir = await createPrivateDir("private-prune");

    const secretPath = path.join(privateDir, "secret.md");
    await fs.writeFile(secretPath, "# private\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("prune-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const firstPagePath = first.pagePaths[0] ?? "";
    const firstPageAbsPath = path.join(vaultDir, firstPagePath);
    const firstPage = await fs.readFile(firstPageAbsPath, "utf8");
    expect(firstPage).toContain("# private");
    if (humanNotes) {
      await fs.writeFile(
        firstPageAbsPath,
        firstPage.replace(
          "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
          `<!-- openclaw:human:start -->\n${humanNotes}\n<!-- openclaw:human:end -->`,
        ),
        "utf8",
      );
    }

    await fs.rm(secretPath);
    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.artifactCount).toBe(0);
    expect(second.removedCount).toBe(1);
    await expect(fs.stat(firstPageAbsPath)).rejects.toHaveProperty("code", "ENOENT");
    const salvageDir = path.join(vaultDir, ".salvage");
    if (humanNotes) {
      await expect(
        fs.readFile(path.join(salvageDir, `${firstPagePath.replace(/\//g, "_")}.notes.md`), "utf8"),
      ).resolves.toContain(humanNotes);
    } else {
      await expect(fs.access(salvageDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves pages and human notes for unavailable configured paths", async () => {
    const unavailableDir = await createPrivateDir("temporarily-unavailable");
    const availableDir = await createPrivateDir("still-available");
    const unavailableSource = path.join(unavailableDir, "keep.md");
    const availableSource = path.join(availableDir, "delete.md");
    await fs.writeFile(unavailableSource, "# keep me\n", "utf8");
    await fs.writeFile(availableSource, "# delete me\n", "utf8");

    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("unavailable-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [unavailableDir, availableDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const pageContents = await Promise.all(
      first.pagePaths.map(async (pagePath) => ({
        pagePath,
        content: await fs.readFile(path.join(vaultDir, pagePath), "utf8"),
      })),
    );
    const unavailablePage = pageContents.find((page) => page.content.includes("# keep me"));
    const availablePage = pageContents.find((page) => page.content.includes("# delete me"));
    expect(unavailablePage).toBeDefined();
    expect(availablePage).toBeDefined();
    await fs.writeFile(
      path.join(vaultDir, unavailablePage!.pagePath),
      unavailablePage!.content.replace(
        "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
        "<!-- openclaw:human:start -->\nremember this\n<!-- openclaw:human:end -->",
      ),
      "utf8",
    );

    const offlinePath = `${unavailableDir}.offline`;
    await fs.rename(unavailableDir, offlinePath);
    await fs.rm(availableSource);
    const duringOutage = await syncMemoryWikiUnsafeLocalSources(config);

    expect(duringOutage.artifactCount).toBe(0);
    expect(duringOutage.removedCount).toBe(1);
    await expect(
      fs.readFile(path.join(vaultDir, unavailablePage!.pagePath), "utf8"),
    ).resolves.toContain("remember this");
    await expect(fs.stat(path.join(vaultDir, availablePage!.pagePath))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );

    await fs.rename(offlinePath, unavailableDir);
    const afterRecovery = await syncMemoryWikiUnsafeLocalSources(config);

    expect(afterRecovery.skippedCount).toBe(1);
    expect(afterRecovery.removedCount).toBe(0);
    await expect(
      fs.readFile(path.join(vaultDir, unavailablePage!.pagePath), "utf8"),
    ).resolves.toContain("remember this");
  });

  it("keeps prior pages, sync state, and ingest log when a source read fails", async () => {
    const privateDir = await createPrivateDir("failed-source-read");
    const previousPath = path.join(privateDir, "previous.md");
    const failingPath = path.join(privateDir, "failing.md");
    await fs.writeFile(previousPath, "# Previous source\n", "utf8");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("failed-source-read-vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: { allowPrivateMemoryCoreAccess: true, paths: [privateDir] },
      },
    });
    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const previousPage = path.join(vaultDir, first.pagePaths[0] ?? "");
    const previousContent = await fs.readFile(previousPage, "utf8");
    const previousState = await readMemoryWikiSourceSyncState(vaultDir);
    const logPath = path.join(vaultDir, ".openclaw-wiki", "log.jsonl");
    const previousLog = await fs.readFile(logPath, "utf8");
    await fs.rm(previousPath);
    await fs.writeFile(failingPath, "# Unreadable source\n", "utf8");

    const readFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(
        async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
          if (args[0] === failingPath) {
            throw new Error("source read failed");
          }
          return readFile(...args);
        },
      );
    await expect(syncMemoryWikiUnsafeLocalSources(config)).rejects.toThrow("source read failed");
    readSpy.mockRestore();

    await expect(fs.readFile(previousPage, "utf8")).resolves.toBe(previousContent);
    await expect(readMemoryWikiSourceSyncState(vaultDir)).resolves.toEqual(previousState);
    await expect(fs.readFile(logPath, "utf8")).resolves.toBe(previousLog);
  });

  it("skips generated source pages copied into a configured path", async () => {
    const privateDir = await createPrivateDir("copied-vault");
    const sourcePaths = [
      path.join(privateDir, "legitimate.md"),
      path.join(privateDir, "bridge-not-generated.md"),
      path.join(privateDir, "unsafe-local-not-generated.md"),
    ];
    await Promise.all(
      sourcePaths.map((sourcePath) => fs.writeFile(sourcePath, `# ${path.basename(sourcePath)}\n`)),
    );
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("copied-vault-target"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateDir],
        },
      },
    });

    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const generatedPage = first.pagePaths.find((pagePath) => pagePath.includes("legitimate-md"));
    expect(generatedPage).toBeDefined();
    const copiedPage = path.join(privateDir, "mirror", generatedPage!);
    await fs.mkdir(path.dirname(copiedPage), { recursive: true });
    await fs.copyFile(path.join(vaultDir, generatedPage!), copiedPage);

    const second = await syncMemoryWikiUnsafeLocalSources(config);

    expect(second.artifactCount).toBe(sourcePaths.length);
    expect(second.importedCount).toBe(0);
    expect(second.skippedCount).toBe(sourcePaths.length);
    expect(second.pagePaths).toHaveLength(sourcePaths.length);
  });

  it("skips a configured source whose canonical path is inside the active vault", async () => {
    const privateDir = await createPrivateDir("canonical-vault");
    const sourcePath = path.join(privateDir, "legitimate.md");
    await fs.writeFile(sourcePath, "# legitimate\n", "utf8");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("canonical-vault-target"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [sourcePath],
        },
      },
    });
    const first = await syncMemoryWikiUnsafeLocalSources(config);
    const generatedPage = path.join(vaultDir, first.pagePaths[0] ?? "");
    const configWithVaultPage = {
      ...config,
      unsafeLocal: {
        ...config.unsafeLocal,
        paths: [sourcePath, generatedPage],
      },
    };

    const second = await syncMemoryWikiUnsafeLocalSources(configWithVaultPage);

    expect(second.artifactCount).toBe(1);
    expect(second.importedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
    expect(second.pagePaths).toHaveLength(1);
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
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain(
      "# very private",
    );
  });
});
