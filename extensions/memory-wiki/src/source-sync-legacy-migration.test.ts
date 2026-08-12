// Memory Wiki tests cover legacy source-sync key migration behavior (#118370).
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
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
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
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

  it("retains a legacy row at namespace capacity and migrates once capacity frees", async () => {
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

    // register-before-delete would need a third row and throw reject-new. The
    // migration must retain the legacy row rather than free its slot first:
    // deleting the only durable ownership row ahead of the replacement would
    // lose it for good if the process dies between the two writes.
    await expect(migrate()).resolves.toEqual({
      translatedCount: 0,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: ["/tmp/legacy-at-capacity.md"],
    });

    expect(capped.values.size).toBe(2);
    const legacySyncKeys = [...capped.values.values()].map(
      (value) => (value as { syncKey: string }).syncKey,
    );
    expect(legacySyncKeys.toSorted()).toEqual([
      "/tmp/legacy-at-capacity.md",
      "bridge:/tmp/full.md",
    ]);

    // Once capacity frees, a rerun finishes the migration idempotently.
    capped.setCap(3);
    await expect(migrate()).resolves.toEqual({
      translatedCount: 1,
      prunedCount: 0,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });

    expect(capped.values.size).toBe(2);
    const syncKeys = [...capped.values.values()].map(
      (value) => (value as { syncKey: string }).syncKey,
    );
    expect(syncKeys.toSorted()).toEqual([
      "bridge:/tmp/full.md",
      "bridge:/tmp/legacy-at-capacity.md",
    ]);
  });

  it("completes a capacity-blocked translation in the same run after stale pruning frees a slot", async () => {
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

    // The bridge row cannot register its scoped replacement until stale
    // pruning frees the slot; the migration must complete it in the same run.
    await expect(
      migrateLegacyImportedSourceSyncKeys({
        vaultRoot,
        openKeyedStore: capped.openKeyedStore,
        unsafeLocalConfiguredPaths: [],
      }),
    ).resolves.toEqual({
      translatedCount: 1,
      prunedCount: 1,
      retainedKeys: [],
      capacityRetainedKeys: [],
    });

    const syncKeys = [...capped.values.values()].map(
      (value) => (value as { syncKey: string }).syncKey,
    );
    expect(syncKeys).toEqual(["bridge:/tmp/legacy-bridge-at-capacity.md"]);
    await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
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
