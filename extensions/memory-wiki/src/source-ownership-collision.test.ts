// Memory Wiki tests cover cross-mode imported source ownership (#118370).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import { readMemoryWikiSourceSyncState } from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { syncMemoryWikiUnsafeLocalSources } from "./unsafe-local.js";

const { createVault } = createMemoryWikiTestHarness();

describe("memory wiki source ownership across import modes", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-ownership-suite-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    clearMemoryPluginState();
  });

  function nextCaseRoot(name: string): string {
    return path.join(fixtureRoot, `case-${caseId++}-${name}`);
  }

  it("keeps bridge and unsafe-local ownership of one physical source distinct", async () => {
    const workspaceDir = nextCaseRoot("workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sourcePath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(sourcePath, "# Durable Memory\n", "utf8");
    const vaultDir = nextCaseRoot("vault");

    const bridgeVault = await createVault({
      rootDir: vaultDir,
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "memory-root",
              workspaceDir,
              relativePath: "MEMORY.md",
              absolutePath: sourcePath,
              agentIds: ["main"],
              contentType: "markdown",
            },
          ];
        },
      },
    });
    const appConfig: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    const bridgeResult = await syncMemoryWikiBridgeSources({
      config: bridgeVault.config,
      appConfig,
    });
    expect(bridgeResult.importedCount).toBe(1);

    const localVault = await createVault({
      rootDir: vaultDir,
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [sourcePath],
        },
      },
    });
    const localResult = await syncMemoryWikiUnsafeLocalSources(localVault.config);
    expect(localResult.importedCount).toBe(1);

    // Both modes own their generated page for the same physical source.
    const state = await readMemoryWikiSourceSyncState(vaultDir);
    const keys = Object.keys(state.entries);
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.startsWith("bridge:"))).toBe(true);
    expect(keys.some((key) => key.startsWith("unsafe-local:"))).toBe(true);
    const pagePaths = Object.values(state.entries).map((entry) => entry.pagePath);
    expect(new Set(pagePaths).size).toBe(2);
    for (const pagePath of pagePaths) {
      await fs.access(path.join(vaultDir, pagePath));
    }

    // Pruning one mode's import must leave the other mode's page and row intact.
    const emptyDir = nextCaseRoot("empty");
    await fs.mkdir(emptyDir, { recursive: true });
    const emptiedVault = await createVault({
      rootDir: vaultDir,
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [emptyDir],
        },
      },
    });
    const pruneResult = await syncMemoryWikiUnsafeLocalSources(emptiedVault.config);
    expect(pruneResult.removedCount).toBe(1);

    const remaining = await readMemoryWikiSourceSyncState(vaultDir);
    const remainingKeys = Object.keys(remaining.entries);
    expect(remainingKeys).toHaveLength(1);
    expect(remainingKeys[0]).toMatch(/^bridge:/);
    await fs.access(path.join(vaultDir, remaining.entries[remainingKeys[0] ?? ""]?.pagePath ?? ""));
  });

  it("re-keys an unsafe-local import instead of orphaning the page when its root moves", async () => {
    const realDir = nextCaseRoot("real");
    await fs.mkdir(realDir, { recursive: true });
    const realFile = path.join(realDir, "notes.md");
    await fs.writeFile(realFile, "# shared notes\n", "utf8");
    const linkDir = nextCaseRoot("link");
    await fs.mkdir(linkDir, { recursive: true });
    const linkFile = path.join(linkDir, "notes.md");
    await fs.symlink(realFile, linkFile);
    const vaultDir = nextCaseRoot("vault");

    // Both configured paths resolve to the same physical file.
    const linkedVault = await createVault({
      rootDir: vaultDir,
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: { allowPrivateMemoryCoreAccess: true, paths: [linkFile] },
      },
    });
    const first = await syncMemoryWikiUnsafeLocalSources(linkedVault.config);
    expect(first.importedCount).toBe(1);
    const firstPagePath = first.pagePaths[0] ?? "";

    const directVault = await createVault({
      rootDir: vaultDir,
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: { allowPrivateMemoryCoreAccess: true, paths: [realFile] },
      },
    });
    const second = await syncMemoryWikiUnsafeLocalSources(directVault.config);
    expect(second.importedCount).toBe(1);

    // The moved binding prunes the previous page instead of leaking it.
    expect(second.removedCount).toBe(1);
    await expect(fs.access(path.join(vaultDir, firstPagePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const remaining = await readMemoryWikiSourceSyncState(vaultDir);
    const remainingKeys = Object.keys(remaining.entries);
    expect(remainingKeys).toHaveLength(1);
    expect(remainingKeys[0]).toMatch(/^unsafe-local:/);
    await fs.access(path.join(vaultDir, remaining.entries[remainingKeys[0] ?? ""]?.pagePath ?? ""));
  });
});
