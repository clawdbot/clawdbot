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
import {
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
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

  it("keeps aliased bridge workspace bindings distinct for one physical source", async () => {
    const realWorkspace = nextCaseRoot("workspace-real");
    await fs.mkdir(realWorkspace, { recursive: true });
    const realSourcePath = path.join(realWorkspace, "MEMORY.md");
    await fs.writeFile(realSourcePath, "# Durable Memory\n", "utf8");
    // A symlinked workspace alias imports the same physical file under a
    // second page binding.
    const aliasWorkspace = nextCaseRoot("workspace-alias");
    await fs.symlink(realWorkspace, aliasWorkspace, "dir");
    const aliasSourcePath = path.join(aliasWorkspace, "MEMORY.md");
    const vaultDir = nextCaseRoot("vault");

    const bridgeConfig = {
      vaultMode: "bridge" as const,
      bridge: { enabled: true, readMemoryArtifacts: true, indexMemoryRoot: true },
    };
    const bridgeVault = await createVault({ rootDir: vaultDir, config: bridgeConfig });
    const artifactFor = (workspaceDir: string, absolutePath: string) => ({
      kind: "memory-root" as const,
      workspaceDir,
      relativePath: "MEMORY.md",
      absolutePath,
      agentIds: ["main"],
      contentType: "markdown" as const,
    });
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            artifactFor(realWorkspace, realSourcePath),
            artifactFor(aliasWorkspace, aliasSourcePath),
          ];
        },
      },
    });
    const appConfig: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true, workspace: realWorkspace }] },
    };
    const first = await syncMemoryWikiBridgeSources({ config: bridgeVault.config, appConfig });
    expect(first.importedCount).toBe(2);

    // Each workspace binding owns its own generated page for the same file.
    const state = await readMemoryWikiSourceSyncState(vaultDir);
    const entries = Object.values(state.entries);
    expect(entries).toHaveLength(2);
    expect(Object.keys(state.entries).every((key) => key.startsWith("bridge:"))).toBe(true);
    const pagePaths = entries.map((entry) => entry.pagePath);
    expect(new Set(pagePaths).size).toBe(2);
    const pagePathFor = (sourcePath: string) =>
      entries.find((entry) => entry.sourcePath === sourcePath)?.pagePath ?? "";
    const aliasPagePath = pagePathFor(aliasSourcePath);
    const realPagePath = pagePathFor(realSourcePath);
    for (const pagePath of pagePaths) {
      await fs.access(path.join(vaultDir, pagePath));
    }

    // Dropping one workspace alias prunes only its page and row; the surviving
    // binding keeps its page.
    clearMemoryPluginState();
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [artifactFor(realWorkspace, realSourcePath)];
        },
      },
    });
    const realOnlyVault = await createVault({ rootDir: vaultDir, config: bridgeConfig });
    const second = await syncMemoryWikiBridgeSources({
      config: realOnlyVault.config,
      appConfig,
    });
    expect(second.removedCount).toBe(1);

    const remaining = await readMemoryWikiSourceSyncState(vaultDir);
    const remainingEntries = Object.values(remaining.entries);
    expect(remainingEntries).toHaveLength(1);
    expect(remainingEntries[0]?.sourcePath).toBe(realSourcePath);
    await fs.access(path.join(vaultDir, realPagePath));
    await expect(fs.access(path.join(vaultDir, aliasPagePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retires a translated bridge row without deleting its page on the next sync", async () => {
    const workspaceDir = nextCaseRoot("workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sourcePath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(sourcePath, "# Durable Memory\n", "utf8");
    const vaultDir = nextCaseRoot("vault");

    const bridgeConfig = {
      vaultMode: "bridge" as const,
      bridge: { enabled: true, readMemoryArtifacts: true, indexMemoryRoot: true },
    };
    const bridgeVault = await createVault({ rootDir: vaultDir, config: bridgeConfig });
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
    const first = await syncMemoryWikiBridgeSources({ config: bridgeVault.config, appConfig });
    expect(first.importedCount).toBe(1);

    // Simulate the post-upgrade pass: the doctor migration's translated row
    // (canonical-path key) is the page's only owner; the binding row is
    // re-created during this next sync.
    const state = await readMemoryWikiSourceSyncState(vaultDir);
    const bindingKey = Object.keys(state.entries)[0] ?? "";
    const bindingEntry = state.entries[bindingKey];
    expect(bindingEntry).toBeDefined();
    if (!bindingEntry) {
      return;
    }
    const translatedKey = `bridge:${await fs.realpath(sourcePath)}`;
    expect(translatedKey).not.toBe(bindingKey);
    await writeMemoryWikiSourceSyncState(vaultDir, {
      version: 1,
      entries: { [translatedKey]: { ...bindingEntry } },
    });

    const secondVault = await createVault({ rootDir: vaultDir, config: bridgeConfig });
    const second = await syncMemoryWikiBridgeSources({
      config: secondVault.config,
      appConfig,
    });

    // The binding row re-owns the page mid-sync, so the shared-page guard
    // retires only the translated row; the page file survives.
    expect(second.removedCount).toBe(1);
    const remaining = await readMemoryWikiSourceSyncState(vaultDir);
    expect(Object.keys(remaining.entries)).toEqual([bindingKey]);
    await fs.access(path.join(vaultDir, bindingEntry.pagePath));
  });
});
