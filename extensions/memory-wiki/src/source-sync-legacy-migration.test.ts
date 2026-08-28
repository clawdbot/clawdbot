// Memory Wiki tests cover legacy source-sync key migration behavior (#118370).
import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveUnsafeLocalPagePath } from "./source-path-shared.js";
import {
  countLegacyImportedSourceSyncRows,
  migrateLegacyImportedSourceSyncKeys,
  translateLegacyImportedSourceSyncKey,
} from "./source-sync-legacy-migration.js";
import {
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  resolveStateEntryKey,
  resolveVaultRootKey,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { createCapacityCappedKeyedStore, createMemoryWikiTestHarness } from "./test-helpers.js";

const tempDirs = createMemoryWikiTestHarness();

function openKeyedStoreForEnv(env: NodeJS.ProcessEnv) {
  return <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env });
}

function openStore(env: NodeJS.ProcessEnv) {
  return createMemoryWikiSourceSyncStateStore(openKeyedStoreForEnv(env));
}

describe("memory wiki source sync legacy key migration", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    configureMemoryWikiSourceSyncStateStore(undefined);
  });

  afterEach(() => {
    configureMemoryWikiSourceSyncStateStore(undefined);
  });

  it("keeps legacy unscoped rows invisible to runtime reads and full writes", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore(env);
    const legacyEntry = {
      group: "bridge" as const,
      pagePath: "sources/legacy.md",
      sourcePath: "/tmp/legacy.md",
      sourceUpdatedAtMs: 1,
      sourceSize: 2,
      renderFingerprint: "fp",
    };
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      { version: 1, entries: { "/tmp/legacy.md": legacyEntry } },
      store,
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {},
    });
    await expect(
      countLegacyImportedSourceSyncRows({ vaultRoot, openKeyedStore: openKeyedStoreForEnv(env) }),
    ).resolves.toBe(1);

    // A full write of scoped state must not delete the legacy row either.
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      { version: 1, entries: { "bridge:/tmp/other.md": { ...legacyEntry } } },
      store,
    );
    await expect(
      countLegacyImportedSourceSyncRows({ vaultRoot, openKeyedStore: openKeyedStoreForEnv(env) }),
    ).resolves.toBe(1);
  });

  it("migrates legacy rows to group-scoped keys idempotently", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore(env);
    const sourceRoot = path.join(stateDir, "private");
    const sourceFile = path.join(sourceRoot, "MEMORY.md");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(sourceFile, "# durable\n", "utf8");
    const bridgeEntry = {
      group: "bridge" as const,
      pagePath: "sources/bridge-legacy.md",
      sourcePath: "/tmp/legacy-bridge.md",
      sourceUpdatedAtMs: 1,
      sourceSize: 2,
      renderFingerprint: "fp-a",
    };
    const localEntry = {
      group: "unsafe-local" as const,
      pagePath: resolveUnsafeLocalPagePath({
        configuredPath: sourceRoot,
        absolutePath: sourceFile,
      }).pagePath,
      sourcePath: sourceFile,
      sourceUpdatedAtMs: 3,
      sourceSize: 4,
      renderFingerprint: "fp-b",
    };
    const localKey = localEntry.sourcePath;
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: { "/tmp/legacy-bridge.md": bridgeEntry, [localKey]: localEntry },
      },
      store,
    );

    const migrate = () =>
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: openKeyedStoreForEnv(env),
        unsafeLocalConfiguredPaths: [sourceRoot],
      });
    await expect(migrate()).resolves.toEqual({
      translatedCount: 2,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });

    const state = await readMemoryWikiSourceSyncState(vaultRoot, store);
    const rootKey = path.resolve(sourceRoot);
    expect(Object.keys(state.entries).toSorted()).toEqual(
      [`bridge:/tmp/legacy-bridge.md`, `unsafe-local:${rootKey}\0${localKey}`].toSorted(),
    );
    expect(state.entries[`unsafe-local:${rootKey}\0${localKey}`]).toMatchObject({
      pagePath: localEntry.pagePath,
    });

    // Reruns are no-ops once every row is scoped.
    await expect(migrate()).resolves.toEqual({
      translatedCount: 0,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });
  });

  it("prunes stale legacy unsafe-local rows through the canonical salvage path", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore(env);
    const pagePath = "sources/orphan.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(
      pageAbsPath,
      [
        "# Unsafe Local Import: orphan",
        "",
        "## Content",
        "```",
        "generated",
        "```",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "durable handwritten note",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: {
          "/tmp/gone/source.md": {
            group: "unsafe-local" as const,
            pagePath,
            sourcePath: "/tmp/gone/source.md",
            sourceUpdatedAtMs: 1,
            sourceSize: 2,
            renderFingerprint: "fp",
          },
        },
      },
      store,
    );

    await expect(
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: openKeyedStoreForEnv(env),
        unsafeLocalConfiguredPaths: [],
      }),
    ).resolves.toEqual({
      translatedCount: 0,
      prunedCount: 1,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });

    // The orphaned page is removed, its Notes salvaged, and the row deleted.
    await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
    const salvageDir = path.join(vaultRoot, ".salvage");
    const salvageFiles = await fs.readdir(salvageDir);
    expect(salvageFiles).toHaveLength(1);
    await expect(
      fs.readFile(path.join(salvageDir, salvageFiles[0] ?? ""), "utf8"),
    ).resolves.toContain("durable handwritten note");
    await expect(
      countLegacyImportedSourceSyncRows({ vaultRoot, openKeyedStore: openKeyedStoreForEnv(env) }),
    ).resolves.toBe(0);

    // The migration converges: a rerun finds no legacy rows and does nothing.
    await expect(
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: openKeyedStoreForEnv(env),
        unsafeLocalConfiguredPaths: [],
      }),
    ).resolves.toEqual({
      translatedCount: 0,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });
  });

  it("matches legacy unsafe-local rows to the root that produced the recorded page", () => {
    const nestedRoot = path.resolve("/data/sub");
    const sourcePath = "/data/sub/x.md";
    const entry = {
      group: "unsafe-local" as const,
      pagePath: resolveUnsafeLocalPagePath({
        configuredPath: nestedRoot,
        absolutePath: sourcePath,
      }).pagePath,
      sourcePath,
      sourceUpdatedAtMs: 1,
      sourceSize: 2,
      renderFingerprint: "fp",
    };

    // The recorded page identity selects the nested root.
    expect(
      translateLegacyImportedSourceSyncKey({
        entry,
        syncKey: sourcePath,
        unsafeLocalConfiguredRoots: [path.resolve("/data"), nestedRoot],
      }),
    ).toBe(`unsafe-local:${nestedRoot}\0${sourcePath}`);

    // A page recorded under a former parent root does not match the nested
    // root: the root move must go stale (salvage), not re-bind.
    const movedEntry = {
      ...entry,
      pagePath: resolveUnsafeLocalPagePath({
        configuredPath: path.resolve("/data"),
        absolutePath: sourcePath,
      }).pagePath,
    };
    expect(
      translateLegacyImportedSourceSyncKey({
        entry: movedEntry,
        syncKey: sourcePath,
        unsafeLocalConfiguredRoots: [nestedRoot],
      }),
    ).toBeUndefined();
  });

  it("retains legacy rows in a full namespace for the next doctor run", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const vaultRoot = path.join(stateDir, "vault");
    const capped = createCapacityCappedKeyedStore(2);
    const store = createMemoryWikiSourceSyncStateStore(capped.openKeyedStore);
    // One scoped row plus one legacy row fill the namespace to its cap.
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: {
          "bridge:/tmp/full.md": {
            group: "bridge" as const,
            pagePath: "sources/full.md",
            sourcePath: "/tmp/full.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp-0",
          },
          "/tmp/legacy-at-capacity.md": {
            group: "bridge" as const,
            pagePath: "sources/legacy-at-capacity.md",
            sourcePath: "/tmp/legacy-at-capacity.md",
            sourceUpdatedAtMs: 1,
            sourceSize: 2,
            renderFingerprint: "fp",
          },
        },
      },
      store,
    );

    const migrate = () =>
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: capped.openKeyedStore,
        unsafeLocalConfiguredPaths: [],
      });

    // A full reject-new namespace has no spare slot for the register-first
    // replacement, so the legacy row stays durable and the migration defers
    // to the next doctor run instead of deleting the only ownership record.
    await expect(migrate()).resolves.toEqual({
      translatedCount: 0,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: ["/tmp/legacy-at-capacity.md"],
    });

    expect(capped.values.size).toBe(2);
    const syncKeys = [...capped.values.values()].map(
      (value) => (value as { syncKey: string }).syncKey,
    );
    expect(syncKeys.toSorted()).toEqual(["/tmp/legacy-at-capacity.md", "bridge:/tmp/full.md"]);

    // Reruns stay no-ops while the namespace stays full.
    await expect(migrate()).resolves.toEqual({
      translatedCount: 0,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: ["/tmp/legacy-at-capacity.md"],
    });
  });

  it("registers the scoped replacement before deleting the legacy row and retains it at capacity", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const vaultRoot = path.join(stateDir, "vault");
    const legacySyncKey = "/tmp/order.md";
    const scopedSyncKey = `bridge:${legacySyncKey}`;
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const legacyStoreKey = resolveStateEntryKey(vaultRootKey, legacySyncKey);
    const scopedStoreKey = resolveStateEntryKey(vaultRootKey, scopedSyncKey);
    const legacyEntry = {
      group: "bridge" as const,
      pagePath: "sources/order.md",
      sourcePath: legacySyncKey,
      sourceUpdatedAtMs: 1,
      sourceSize: 2,
      renderFingerprint: "fp",
    };

    const runWithCap = async (cap: number, seedScoped: boolean) => {
      const capped = createCapacityCappedKeyedStore(cap);
      const ops: string[] = [];
      const openKeyedStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
        const store = capped.openKeyedStore<T>(options);
        return {
          ...store,
          async register(key, value) {
            ops.push(`register:${key}`);
            await store.register(key, value);
          },
          async registerIfAbsent(key, value) {
            ops.push(`registerIfAbsent:${key}`);
            return store.registerIfAbsent(key, value);
          },
          async delete(key) {
            ops.push(`delete:${key}`);
            return store.delete(key);
          },
        };
      };
      const entries: Record<string, typeof legacyEntry> = { [legacySyncKey]: { ...legacyEntry } };
      if (seedScoped) {
        entries["bridge:/tmp/other.md"] = { ...legacyEntry };
      }
      await writeMemoryWikiSourceSyncState(
        vaultRoot,
        { version: 1, entries },
        createMemoryWikiSourceSyncStateStore(openKeyedStore),
      );
      ops.length = 0;
      const result = await migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore,
        unsafeLocalConfiguredPaths: [],
      });
      return { ops, result };
    };

    // Register-first when there is room: the replacement is durable before the
    // legacy row goes, so a kill mid-migration leaves a converging duplicate,
    // never a missing ownership record.
    await expect(runWithCap(4, false)).resolves.toEqual({
      ops: [`registerIfAbsent:${scopedStoreKey}`, `delete:${legacyStoreKey}`],
      result: { translatedCount: 1, prunedCount: 0, retainedKeys: [], capacityRetainedKeys: [] },
    });

    // At capacity the replacement has no slot: the legacy row stays durable
    // and the next doctor run retries it instead of opening a delete-first
    // window.
    await expect(runWithCap(2, true)).resolves.toEqual({
      ops: [`registerIfAbsent:${scopedStoreKey}`],
      result: {
        translatedCount: 0,
        prunedCount: 0,
        retainedKeys: [],
        capacityRetainedKeys: [legacySyncKey],
      },
    });
  });

  it("never overwrites a racing scoped row during migration", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const vaultRoot = path.join(stateDir, "vault");
    const legacySyncKey = "/tmp/race.md";
    const scopedSyncKey = `bridge:${legacySyncKey}`;
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const legacyStoreKey = resolveStateEntryKey(vaultRootKey, legacySyncKey);
    const scopedStoreKey = resolveStateEntryKey(vaultRootKey, scopedSyncKey);
    const legacyEntry = {
      group: "bridge" as const,
      pagePath: "sources/race.md",
      sourcePath: legacySyncKey,
      sourceUpdatedAtMs: 1,
      sourceSize: 2,
      renderFingerprint: "fp",
    };
    const capped = createCapacityCappedKeyedStore(4);
    const openKeyedStore = <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
      const store = capped.openKeyedStore<T>(options);
      return {
        ...store,
        async registerIfAbsent(key, value) {
          // A concurrent sync wins the race after the migration's lookup:
          // inject its newer scoped row before the insert-if-absent runs.
          if (key === scopedStoreKey && !capped.values.has(key)) {
            capped.values.set(key, {
              ...(value as object),
              renderFingerprint: "racing-fp",
            });
          }
          return store.registerIfAbsent(key, value);
        },
      };
    };
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      { version: 1, entries: { [legacySyncKey]: { ...legacyEntry } } },
      createMemoryWikiSourceSyncStateStore(openKeyedStore),
    );

    const result = await migrateLegacyImportedSourceSyncKeys({
      vaultRoot,
      openKeyedStore,
      unsafeLocalConfiguredPaths: [],
    });

    // The racing row keeps its newer value; only the legacy duplicate goes.
    expect(result.translatedCount).toBe(1);
    expect(capped.values.get(scopedStoreKey)).toMatchObject({
      renderFingerprint: "racing-fp",
    });
    expect(capped.values.has(legacyStoreKey)).toBe(false);
  });

  it("drops the legacy duplicate when the scoped key is already owned", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore(env);
    const legacySyncKey = "/tmp/conflict.md";
    const scopedSyncKey = `bridge:${legacySyncKey}`;
    const vaultRootKey = resolveVaultRootKey(vaultRoot);
    const legacyEntry = {
      group: "bridge" as const,
      pagePath: "sources/conflict.md",
      sourcePath: legacySyncKey,
      sourceUpdatedAtMs: 1,
      sourceSize: 2,
      renderFingerprint: "fp-legacy",
    };
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      { version: 1, entries: { [legacySyncKey]: legacyEntry } },
      store,
    );
    // A racing bridge sync re-owns the page under the scoped key before the
    // doctor pass reaches the legacy row.
    const raw = openKeyedStoreForEnv(env)<{
      syncKey: string;
      vaultRootKey: string;
      renderFingerprint: string;
    }>({
      namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await raw.register(resolveStateEntryKey(vaultRootKey, scopedSyncKey), {
      ...legacyEntry,
      vaultRootKey,
      syncKey: scopedSyncKey,
      renderFingerprint: "fp-scoped",
    });

    await expect(
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: openKeyedStoreForEnv(env),
        unsafeLocalConfiguredPaths: [],
      }),
    ).resolves.toEqual({
      translatedCount: 1,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });

    // The scoped row keeps its own value; only the legacy duplicate is gone.
    await expect(
      raw.lookup(resolveStateEntryKey(vaultRootKey, scopedSyncKey)),
    ).resolves.toMatchObject({ renderFingerprint: "fp-scoped" });
    await expect(
      countLegacyImportedSourceSyncRows({ vaultRoot, openKeyedStore: openKeyedStoreForEnv(env) }),
    ).resolves.toBe(0);
  });

  it("prunes a stale row at capacity, then translates the retained row on the next run", async () => {
    const stateDir = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const vaultRoot = path.join(stateDir, "vault");
    const capped = createCapacityCappedKeyedStore(2);
    const store = createMemoryWikiSourceSyncStateStore(capped.openKeyedStore);
    const pagePath = "sources/stale.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(pageAbsPath, "# stale page\n", "utf8");
    // A stale unsafe-local row plus a translatable bridge row fill the cap.
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: {
          "/tmp/gone/stale.md": {
            group: "unsafe-local" as const,
            pagePath,
            sourcePath: "/tmp/gone/stale.md",
            sourceUpdatedAtMs: 1,
            sourceSize: 2,
            renderFingerprint: "fp",
          },
          "/tmp/legacy-bridge-at-capacity.md": {
            group: "bridge" as const,
            pagePath: "sources/legacy-bridge-at-capacity.md",
            sourcePath: "/tmp/legacy-bridge-at-capacity.md",
            sourceUpdatedAtMs: 1,
            sourceSize: 2,
            renderFingerprint: "fp",
          },
        },
      },
      store,
    );

    // At capacity the bridge row's register-first replacement has no spare
    // slot, so the run retains it while the stale row still prunes through
    // the canonical salvage path.
    await expect(
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: capped.openKeyedStore,
        unsafeLocalConfiguredPaths: [],
      }),
    ).resolves.toEqual({
      translatedCount: 0,
      prunedCount: 1,
      retainedKeys: [],
      capacityRetainedKeys: ["/tmp/legacy-bridge-at-capacity.md"],
    });
    await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });

    // The slot the prune freed lets the next run translate the retained row.
    await expect(
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: capped.openKeyedStore,
        unsafeLocalConfiguredPaths: [],
      }),
    ).resolves.toEqual({
      translatedCount: 1,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });

    const syncKeys = [...capped.values.values()].map(
      (value) => (value as { syncKey: string }).syncKey,
    );
    expect(syncKeys).toEqual(["bridge:/tmp/legacy-bridge-at-capacity.md"]);
  });

  it("keeps a page that another live row still owns when pruning", async () => {
    const vaultRoot = await tempDirs.createTempDir("memory-wiki-source-sync-");
    const pagePath = "sources/shared.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(pageAbsPath, "# shared page\n", "utf8");
    const entry = {
      group: "bridge" as const,
      pagePath,
      sourcePath: "/tmp/source.md",
      sourceUpdatedAtMs: 0,
      sourceSize: 0,
      renderFingerprint: "fp",
    };
    const state: Parameters<typeof pruneImportedSourceEntries>[0]["state"] = {
      version: 1,
      entries: {
        "bridge:/tmp/aliased-a.md": entry,
        "bridge:/tmp/aliased-b.md": entry,
      },
    };

    await expect(
      pruneImportedSourceEntries({
        vaultRoot,
        group: "bridge",
        activeKeys: new Set(["bridge:/tmp/aliased-b.md"]),
        state,
      }),
    ).resolves.toBe(1);

    // The stale row is gone but the shared page and its content survive.
    expect(Object.keys(state.entries)).toEqual(["bridge:/tmp/aliased-b.md"]);
    await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toBe("# shared page\n");
  });
});
