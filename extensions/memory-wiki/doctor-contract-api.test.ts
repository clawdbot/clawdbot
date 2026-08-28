// Memory Wiki tests cover doctor migration of legacy source sync state.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  OpenBlobStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { rollbackChatGptImportRun } from "./src/chatgpt-import.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
} from "./src/compiled-cache.js";
import { resolveMemoryWikiConfig } from "./src/config.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
  readMemoryWikiImportRunRecord,
} from "./src/import-runs-state.js";
import { resolveUnsafeLocalPagePath } from "./src/source-path-shared.js";
import {
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  readMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
} from "./src/source-sync-state.js";
import { createCapacityCappedKeyedStore, createMemoryWikiTestHarness } from "./src/test-helpers.js";

function requireStateMigration(id: string) {
  return expectDefined(
    stateMigrations.find((migration) => migration.id === id),
    `Memory Wiki state migration ${id}`,
  );
}

const tempDirs = createMemoryWikiTestHarness();

function resolveLegacyImportRunRecordPath(vaultRoot: string, runId: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs", `${runId}.json`);
}

function migrationParams(params: {
  stateDir: string;
  vaultRoot: string;
  agentIds?: string[];
  unsafeLocalPaths?: string[];
  openKeyedStore?: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
}) {
  const env = { ...process.env, HOME: params.stateDir, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    config: {
      ...(params.agentIds ? { agents: { list: params.agentIds.map((id) => ({ id })) } } : {}),
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              vault: {
                path: params.vaultRoot,
                ...(params.agentIds ? { scope: "agent" as const } : {}),
              },
              ...(params.unsafeLocalPaths
                ? {
                    unsafeLocal: {
                      allowPrivateMemoryCoreAccess: true,
                      paths: params.unsafeLocalPaths,
                    },
                  }
                : {}),
            },
          },
        },
      },
    },
    env,
    stateDir: params.stateDir,
    oauthDir: path.join(params.stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore:
        params.openKeyedStore ??
        (<T>(options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env })),
    },
  };
}

describe("memory-wiki doctor source sync migration", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(async () => {
    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiImportRunStateStore(undefined);
    resetPluginBlobStoreForTests();
    resetPluginStateStoreForTests();
  });

  it("deletes rebuildable compiled cache files without importing them", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const cacheDir = path.join(vaultRoot, ".openclaw-wiki", "cache");
    const legacyPaths = [
      path.join(cacheDir, "agent-digest.json"),
      path.join(cacheDir, "claims.jsonl"),
    ];
    await fs.mkdir(cacheDir, { recursive: true });
    await Promise.all(legacyPaths.map((filePath) => fs.writeFile(filePath, "stale\n", "utf8")));
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: legacyPaths.map((filePath) =>
        expect.stringContaining(`Remove rebuildable Memory Wiki compiled cache: ${filePath}`),
      ),
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: legacyPaths.map(
        (filePath) => `Removed rebuildable Memory Wiki compiled cache: ${filePath}`,
      ),
      warnings: [],
    });
    await Promise.all(
      legacyPaths.map((filePath) =>
        expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
  });

  it("migrates the default state-directory vault without touching the real-home vault", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-state-");
    const homeDir = await tempDirs.createTempDir("memory-wiki-doctor-home-");
    const stateVault = path.join(stateDir, "wiki", "main");
    const homeVault = path.join(homeDir, ".openclaw", "wiki", "main");
    const cacheRelativePath = path.join(".openclaw-wiki", "cache", "agent-digest.json");
    const stateCache = path.join(stateVault, cacheRelativePath);
    const homeCache = path.join(homeVault, cacheRelativePath);
    for (const cachePath of [stateCache, homeCache]) {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, "stale\n", "utf8");
    }
    const params = {
      ...migrationParams({ stateDir, vaultRoot: stateVault }),
      config: { plugins: { entries: { "memory-wiki": { config: {} } } } },
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
    };
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining(stateCache)],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [expect.stringContaining(stateCache)],
      warnings: [],
    });
    await expect(fs.stat(stateCache)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(homeCache, "utf8")).resolves.toBe("stale\n");
  });

  it("skips configured vaults that have not been initialized", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "missing-vault");
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("does not follow a symlinked legacy cache directory", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const externalCacheDir = path.join(stateDir, "external-cache");
    const externalCachePath = path.join(externalCacheDir, "agent-digest.json");
    await fs.mkdir(path.join(vaultRoot, ".openclaw-wiki"), { recursive: true });
    await fs.mkdir(externalCacheDir, { recursive: true });
    await fs.writeFile(externalCachePath, "private\n", "utf8");
    await fs.symlink(externalCacheDir, path.join(vaultRoot, ".openclaw-wiki", "cache"));
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = requireStateMigration("memory-wiki-compiled-cache-file-cleanup");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(fs.readFile(externalCachePath, "utf8")).resolves.toBe("private\n");
  });

  it("detects and migrates legacy source-sync.json into plugin state", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const homeDir = await tempDirs.createTempDir("memory-wiki-doctor-home-");
    const vaultRoot = path.join(stateDir, "wiki", "main");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    const homeLegacyPath = resolveMemoryWikiSourceSyncStatePath(
      path.join(homeDir, ".openclaw", "wiki", "main"),
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.mkdir(path.dirname(homeLegacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          alpha: {
            group: "bridge",
            pagePath: "sources/alpha.md",
            sourcePath: "/tmp/alpha.md",
            sourceUpdatedAtMs: 100,
            sourceSize: 200,
            renderFingerprint: "alpha",
          },
        },
      })}\n`,
    );
    const homeSourceSync = await fs.readFile(legacyPath, "utf8");
    await fs.writeFile(homeLegacyPath, homeSourceSync, "utf8");
    const params = {
      ...migrationParams({ stateDir, vaultRoot }),
      config: { plugins: { entries: { "memory-wiki": { config: {} } } } },
      env: { ...process.env, HOME: homeDir, OPENCLAW_STATE_DIR: stateDir },
    };
    const migration = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki source sync:")],
    });

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        "bridge:alpha": {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/alpha.md",
          sourceUpdatedAtMs: 100,
          sourceSize: 200,
          renderFingerprint: "alpha",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
    await expect(fs.readFile(homeLegacyPath, "utf8")).resolves.toBe(homeSourceSync);
    await expect(fs.stat(`${homeLegacyPath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converges legacy source-sync state in one doctor pass", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const sourceRoot = path.join(stateDir, "private");
    const sourceFile = path.join(sourceRoot, "MEMORY.md");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(sourceFile, "# durable\n", "utf8");
    // A stale unsafe-local entry whose recorded page still holds human Notes.
    const stalePagePath = "sources/gone.md";
    const stalePageAbs = path.join(vaultRoot, stalePagePath);
    await fs.mkdir(path.dirname(stalePageAbs), { recursive: true });
    await fs.writeFile(
      stalePageAbs,
      [
        "# Unsafe Local Import: gone",
        "",
        "## Content",
        "```",
        "generated",
        "```",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "keep me",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          [sourceFile]: {
            group: "unsafe-local",
            pagePath: resolveUnsafeLocalPagePath({
              configuredPath: sourceRoot,
              absolutePath: sourceFile,
            }).pagePath,
            sourcePath: sourceFile,
            sourceUpdatedAtMs: 100,
            sourceSize: 200,
            renderFingerprint: "matched",
          },
          "/tmp/gone.md": {
            group: "unsafe-local",
            pagePath: stalePagePath,
            sourcePath: "/tmp/gone.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "stale",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot, unsafeLocalPaths: [sourceRoot] });

    await expect(
      requireStateMigration("memory-wiki-source-sync-json-to-plugin-state").migrateLegacyState(
        params,
      ),
    ).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 0 existing)",
        "Pruned 1 stale Memory Wiki source sync entries via Notes salvage",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });

    // The matched row lands already group-scoped; the stale row's page is
    // salvaged and removed instead of entering the store unscoped.
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    expect(Object.keys(state.entries)).toEqual([
      `unsafe-local:${path.resolve(sourceRoot)}\0${sourceFile}`,
    ]);
    await expect(fs.access(stalePageAbs)).rejects.toMatchObject({ code: "ENOENT" });
    const salvageFiles = await fs.readdir(path.join(vaultRoot, ".salvage"));
    expect(salvageFiles).toHaveLength(1);
    await expect(
      fs.readFile(path.join(vaultRoot, ".salvage", salvageFiles[0] ?? ""), "utf8"),
    ).resolves.toContain("keep me");

    // One pass converges: the scoped-key detector finds nothing left to do.
    await expect(
      requireStateMigration("memory-wiki-source-sync-group-scoped-keys").detectLegacyState(params),
    ).resolves.toBeNull();
  });

  it("retains legacy rows at namespace capacity and converges once capacity frees", async () => {
    // Ordering invariant: the JSON preflight only sees scoped rows until the
    // scoped-keys pass runs, so the exported migration order is part of the fix.
    const migrationIds = stateMigrations.map((migration) => migration.id);
    expect(migrationIds.indexOf("memory-wiki-source-sync-group-scoped-keys")).toBeLessThan(
      migrationIds.indexOf("memory-wiki-source-sync-json-to-plugin-state"),
    );

    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const capped = createCapacityCappedKeyedStore(MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES);
    const params = migrationParams({
      stateDir,
      vaultRoot,
      openKeyedStore: capped.openKeyedStore,
    });
    const store = createMemoryWikiSourceSyncStateStore(capped.openKeyedStore);
    // A full namespace of valid legacy bridge rows plus one residual JSON entry.
    const seedEntries = Object.fromEntries(
      Array.from({ length: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES }, (_, index) => [
        `/tmp/source-${index}.md`,
        {
          group: "bridge" as const,
          pagePath: `sources/source-${index}.md`,
          sourcePath: `/tmp/source-${index}.md`,
          sourceUpdatedAtMs: 100,
          sourceSize: 200,
          renderFingerprint: `fp-${index}`,
        },
      ]),
    );
    await store.write(vaultRoot, { version: 1, entries: seedEntries });
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          gamma: {
            group: "bridge",
            pagePath: "sources/gamma.md",
            sourcePath: "/tmp/gamma.md",
            sourceUpdatedAtMs: 100,
            sourceSize: 200,
            renderFingerprint: "gamma",
          },
        },
      })}\n`,
    );
    const scopedKeys = requireStateMigration("memory-wiki-source-sync-group-scoped-keys");
    const jsonImport = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");

    // Full namespace: the register-first replacement has no spare slot, so the
    // legacy rows stay durable behind one aggregate warning instead of entering
    // a delete-first window. The JSON preflight then counts the physical rows
    // and skips with a warning instead of crashing the write mid-import.
    // Before the fix this import threw PLUGIN_STATE_LIMIT_EXCEEDED out of
    // migrateLegacyState.
    await expect(scopedKeys.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [
        `Memory Wiki source sync namespace is full; retained ${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES} legacy ownership row(s) for ${vaultRoot} (e.g. /tmp/source-0.md). Rerun doctor after other state frees namespace capacity to finish the migration.`,
      ],
    });
    await expect(jsonImport.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [
        `Skipped Memory Wiki source-sync import for ${vaultRoot}: ${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES + 1} entries exceeds ${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES}`,
      ],
    });
    await expect(fs.stat(legacyPath)).resolves.toBeDefined();

    // Once any capacity frees (rows a later source sync prunes), the pass
    // converges: each translate consumes one spare slot and its delete frees
    // it back, so one free slot rolls the whole namespace forward. The JSON
    // import then merges cleanly.
    for (const storeKey of [...capped.values.keys()].slice(0, 2)) {
      capped.values.delete(storeKey);
    }
    await expect(scopedKeys.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        `Migrated Memory Wiki source sync ownership -> group-scoped keys (${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES - 2} translated, 0 stale pruned)`,
      ],
      warnings: [],
    });
    await expect(jsonImport.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        `Migrated Memory Wiki source sync -> plugin state (1 imported, ${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES - 2} existing)`,
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    expect(Object.keys(state.entries)).toHaveLength(MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES - 1);
    expect(state.entries["bridge:gamma"]?.renderFingerprint).toBe("gamma");
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(scopedKeys.detectLegacyState(params)).resolves.toBeNull();
  }, 30_000);

  it("detects and migrates legacy import-run records into plugin state", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-alpha");
    const snapshotPath = path.join(
      vaultRoot,
      ".openclaw-wiki",
      "import-runs",
      "chatgpt-alpha",
      "snapshots",
      "alpha.md",
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    const legacyPagePath = path.join(vaultRoot, "sources", "legacy.md");
    const legacyPageContent = "# Edited legacy import page\n";
    await fs.mkdir(path.dirname(legacyPagePath), { recursive: true });
    await fs.writeFile(legacyPagePath, legacyPageContent, "utf8");
    await fs.writeFile(snapshotPath, "previous page\n", "utf8");
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 3,
        createdCount: 2,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: [
          "sources/legacy.md",
          { path: "sources/new.md", contentHash: "new-content-hash" },
        ],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki import runs:")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki import runs -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki import-run legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiImportRunRecord(vaultRoot, "chatgpt-alpha", store)).resolves.toEqual(
      {
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 3,
        createdCount: 2,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: [
          { path: "sources/legacy.md" },
          { path: "sources/new.md", contentHash: "new-content-hash" },
        ],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      },
    );
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
    await expect(fs.readFile(snapshotPath, "utf8")).resolves.toBe("previous page\n");

    configureMemoryWikiImportRunStateStore(store);
    const blobStoreEnv = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    configureMemoryWikiCompiledCacheStore(
      createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
        createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv),
      ),
    );
    const rollback = await rollbackChatGptImportRun({
      config: resolveMemoryWikiConfig({ vault: { path: vaultRoot } }),
      runId: "chatgpt-alpha",
    });
    const preservedLegacy = rollback.preservedPaths.find(
      (entry) => entry.path === "sources/legacy.md",
    );
    expect(preservedLegacy).toBeDefined();
    await expect(
      fs.readFile(path.join(vaultRoot, preservedLegacy?.recoveryPath ?? ""), "utf8"),
    ).resolves.toBe(legacyPageContent);
  });

  it("merges legacy entries with existing plugin state before archiving", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          stale: {
            group: "bridge",
            pagePath: "sources/stale.md",
            sourcePath: "/tmp/stale.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "stale",
          },
          current: {
            group: "bridge",
            pagePath: "sources/current-old.md",
            sourcePath: "/tmp/current-old.md",
            sourceUpdatedAtMs: 30,
            sourceSize: 40,
            renderFingerprint: "old",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await store.write(vaultRoot, {
      version: 1,
      entries: {
        "bridge:current": {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });

    await expect(
      requireStateMigration("memory-wiki-source-sync-json-to-plugin-state").migrateLegacyState(
        params,
      ),
    ).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 1 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        "bridge:stale": {
          group: "bridge",
          pagePath: "sources/stale.md",
          sourcePath: "/tmp/stale.md",
          sourceUpdatedAtMs: 10,
          sourceSize: 20,
          renderFingerprint: "stale",
        },
        "bridge:current": {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy state from every configured agent vault", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-doctor-");
    const vaultRoot = path.join(stateDir, "vaults");
    const agentIds = ["support", "marketing"];
    for (const agentId of agentIds) {
      const legacyPath = resolveMemoryWikiSourceSyncStatePath(path.join(vaultRoot, agentId));
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({
          version: 1,
          entries: {
            [agentId]: {
              group: "bridge",
              pagePath: `sources/${agentId}.md`,
              sourcePath: `/tmp/${agentId}.md`,
              sourceUpdatedAtMs: 100,
              sourceSize: 200,
              renderFingerprint: agentId,
            },
          },
        })}\n`,
      );
    }

    const params = migrationParams({ stateDir, vaultRoot, agentIds });
    const migration = requireStateMigration("memory-wiki-source-sync-json-to-plugin-state");
    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        expect.stringContaining(path.join(vaultRoot, "support")),
        expect.stringContaining(path.join(vaultRoot, "marketing")),
      ],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      warnings: [],
    });

    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    for (const agentId of agentIds) {
      await expect(
        readMemoryWikiSourceSyncState(path.join(vaultRoot, agentId), store),
      ).resolves.toMatchObject({
        entries: { [`bridge:${agentId}`]: { renderFingerprint: agentId } },
      });
    }
  });
});
