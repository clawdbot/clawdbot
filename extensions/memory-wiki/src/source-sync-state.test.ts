// Memory Wiki tests cover source sync state plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
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
import {
  assertMemoryWikiSourceSyncStateCapacity,
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  pruneImportedSourceEntries,
  readLegacyMemoryWikiSourceSyncState,
  readMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
  setImportedSourceEntry,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-sync-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(env: NodeJS.ProcessEnv) {
  return createMemoryWikiSourceSyncStateStore(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
  );
}

function createCountingStore(options?: { maxEntries?: number }) {
  const values = new Map<string, unknown>();
  const calls = { register: 0, delete: 0, entries: 0 };
  let openOptions: OpenKeyedStoreOptions | undefined;
  const openKeyedStore = <T>(storeOptions: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
    openOptions = storeOptions;
    return {
      async register(key, value) {
        calls.register += 1;
        if (!values.has(key) && options?.maxEntries && values.size >= options.maxEntries) {
          const oldestKey = values.keys().next().value;
          if (oldestKey) {
            values.delete(oldestKey);
          }
        }
        values.set(key, value);
      },
      async registerIfAbsent(key, value) {
        if (values.has(key)) {
          return false;
        }
        values.set(key, value);
        return true;
      },
      async lookup(key) {
        return values.get(key) as T | undefined;
      },
      async consume(key) {
        const value = values.get(key) as T | undefined;
        values.delete(key);
        return value;
      },
      async delete(key) {
        calls.delete += 1;
        return values.delete(key);
      },
      async entries() {
        calls.entries += 1;
        return [...values.entries()].map(([key, value]) => ({
          key,
          value: value as T,
          createdAt: 0,
        }));
      },
      async clear() {
        values.clear();
      },
    };
  };
  return {
    store: createMemoryWikiSourceSyncStateStore(openKeyedStore),
    calls,
    get openOptions() {
      return openOptions;
    },
    resetCalls() {
      calls.register = 0;
      calls.delete = 0;
      calls.entries = 0;
    },
  };
}

describe("memory wiki source sync state", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    configureMemoryWikiSourceSyncStateStore(undefined);
  });

  afterEach(async () => {
    configureMemoryWikiSourceSyncStateStore(undefined);
    resetPluginStateStoreForTests();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists source sync entries in plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });

    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: {
          alpha: {
            group: "bridge",
            pagePath: "sources/alpha.md",
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 123,
            sourceSize: 456,
            renderFingerprint: "fingerprint",
          },
        },
      },
      store,
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        alpha: {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/source.md",
          sourceUpdatedAtMs: 123,
          sourceSize: 456,
          renderFingerprint: "fingerprint",
        },
      },
    });
    await expect(fs.stat(resolveMemoryWikiSourceSyncStatePath(vaultRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists only changed rows in a 1,914-entry state snapshot", async () => {
    const vaultRoot = path.join(await makeTempDir(), "vault");
    const counting = createCountingStore();
    const entries = Object.fromEntries(
      Array.from({ length: 1_914 }, (_, index) => [
        `source-${index}`,
        {
          group: "bridge" as const,
          pagePath: `sources/source-${index}.md`,
          sourcePath: `/tmp/source-${index}.md`,
          sourceUpdatedAtMs: index,
          sourceSize: index,
          renderFingerprint: `fingerprint-${index}`,
        },
      ]),
    );
    await writeMemoryWikiSourceSyncState(vaultRoot, { version: 1, entries }, counting.store);
    expect(counting.openOptions?.overflowPolicy).toBe("reject-new");

    const state = await readMemoryWikiSourceSyncState(vaultRoot, counting.store);
    counting.resetCalls();
    await writeMemoryWikiSourceSyncState(vaultRoot, state, counting.store);
    expect(counting.calls).toEqual({ register: 0, delete: 0, entries: 0 });

    const changed = state.entries["source-0"];
    expect(changed).toBeDefined();
    setImportedSourceEntry({
      state,
      syncKey: "source-0",
      entry: { ...changed!, sourceSize: changed!.sourceSize + 1 },
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, state, counting.store);
    expect(counting.calls).toEqual({ register: 1, delete: 0, entries: 0 });

    counting.resetCalls();
    await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(Object.keys(state.entries).filter((key) => key !== "source-1")),
      state,
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, state, counting.store);
    expect(counting.calls).toEqual({ register: 0, delete: 1, entries: 0 });

    const persisted = await readMemoryWikiSourceSyncState(vaultRoot, counting.store);
    expect(persisted.entries["source-0"]?.sourceSize).toBe(1);
    expect(persisted.entries["source-1"]).toBeUndefined();
    expect(Object.keys(persisted.entries)).toHaveLength(1_913);
  });

  it("deletes replaced rows before upserts at the store capacity", async () => {
    const vaultRoot = path.join(await makeTempDir(), "vault");
    const counting = createCountingStore({ maxEntries: 2 });
    const makeEntry = (index: number) => ({
      group: "bridge" as const,
      pagePath: `sources/source-${index}.md`,
      sourcePath: `/tmp/source-${index}.md`,
      sourceUpdatedAtMs: index,
      sourceSize: index,
      renderFingerprint: `fingerprint-${index}`,
    });
    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: { "source-0": makeEntry(0), "source-1": makeEntry(1) },
      },
      counting.store,
    );

    const tracked = await readMemoryWikiSourceSyncState(vaultRoot, counting.store);
    await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(["source-0"]),
      state: tracked,
    });
    setImportedSourceEntry({
      state: tracked,
      syncKey: "source-2",
      entry: makeEntry(2),
    });
    await writeMemoryWikiSourceSyncState(vaultRoot, tracked, counting.store);
    await expect(readMemoryWikiSourceSyncState(vaultRoot, counting.store)).resolves.toMatchObject({
      entries: { "source-0": makeEntry(0), "source-2": makeEntry(2) },
    });

    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: { "source-0": makeEntry(0), "source-3": makeEntry(3) },
      },
      counting.store,
    );
    await expect(readMemoryWikiSourceSyncState(vaultRoot, counting.store)).resolves.toMatchObject({
      entries: { "source-0": makeEntry(0), "source-3": makeEntry(3) },
    });
  });

  it("keeps legacy file reads separate for doctor migration", async () => {
    const vaultRoot = await makeTempDir();
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          beta: {
            group: "unsafe-local",
            pagePath: "sources/beta.md",
            sourcePath: "/tmp/beta.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "beta",
          },
        },
      })}\n`,
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {},
    });
    await expect(readLegacyMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {
        beta: {
          group: "unsafe-local",
          pagePath: "sources/beta.md",
          sourcePath: "/tmp/beta.md",
          sourceUpdatedAtMs: 10,
          sourceSize: 20,
          renderFingerprint: "beta",
        },
      },
    });
  });

  it("rejects writes beyond the source-sync state row cap", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    const entries = Object.fromEntries(
      Array.from({ length: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES + 1 }, (_, index) => [
        `source-${index}`,
        {
          group: "bridge" as const,
          pagePath: `sources/source-${index}.md`,
          sourcePath: `/tmp/source-${index}.md`,
          sourceUpdatedAtMs: index,
          sourceSize: index,
          renderFingerprint: `fingerprint-${index}`,
        },
      ]),
    );

    await expect(
      writeMemoryWikiSourceSyncState(vaultRoot, { version: 1, entries }, store),
    ).rejects.toThrow("Memory Wiki source sync state exceeds SQLite entry limit");
  });

  it("salvages human Notes before pruning an imported page", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/salvage-test.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(
      pageAbsPath,
      [
        "# Memory Bridge (test)",
        "## Bridge Source",
        "## Content",
        "```",
        "generated content",
        "```",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "my durable annotations",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    expect(removed).toBe(1);
    await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });

    const salvagePath = path.join(
      vaultRoot,
      ".salvage",
      `${pagePath.replace(/\//g, "_")}.notes.md`,
    );
    const salvaged = await fs.readFile(salvagePath, "utf-8");
    expect(salvaged).toContain("<!-- openclaw:human:start -->");
    expect(salvaged).toContain("my durable annotations");
    expect(salvaged).toContain("<!-- openclaw:human:end -->");
  });

  it("does not create salvage files for pages without human Notes", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/no-notes.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(pageAbsPath, "# Memory Bridge\n\n## Content\n\nNo notes here.\n", "utf-8");

    await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    const salvageDir = path.join(vaultRoot, ".salvage");
    await expect(fs.access(salvageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes pages even when the page file is already missing", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/missing.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);

    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    expect(removed).toBe(1);
    await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not salvage marker comments inside source content as Notes", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/marker-in-content.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(
      pageAbsPath,
      [
        "# Unsafe Local Import: test",
        "## Unsafe Local Source",
        "## Content",
        "```",
        "<!-- openclaw:human:start -->",
        "this is inside the source fence, not Notes",
        "<!-- openclaw:human:end -->",
        "```",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "real human annotation",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    await pruneImportedSourceEntries({
      vaultRoot,
      group: "unsafe-local",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "unsafe-local",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    const salvagePath = path.join(
      vaultRoot,
      ".salvage",
      `${pagePath.replace(/\//g, "_")}.notes.md`,
    );
    const salvaged = await fs.readFile(salvagePath, "utf-8");
    // Must contain the real Notes block, not the markers inside the fence.
    expect(salvaged).toContain("real human annotation");
    expect(salvaged).not.toContain("this is inside the source fence");
  });

  it("keeps the page when salvage write fails", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/keep-on-write-fail.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(
      pageAbsPath,
      [
        "# Memory Bridge (test)",
        "## Content",
        "```",
        "generated",
        "```",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "must survive",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    // Create a file where the salvage directory would go so mkdir fails.
    await fs.mkdir(path.join(vaultRoot, ".salvage"));
    const salvagePath = path.join(
      vaultRoot,
      ".salvage",
      `${pagePath.replace(/\//g, "_")}.notes.md`,
    );
    await fs.writeFile(salvagePath, "block", "utf-8");
    // Make the salvage path a directory so writeFile fails with EISDIR.
    await fs.rm(salvagePath);
    await fs.mkdir(salvagePath);

    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    // Salvage write failed — the page must NOT be removed.
    expect(removed).toBe(0);
    const stillThere = await fs.readFile(pageAbsPath, "utf-8");
    expect(stillThere).toContain("must survive");
  });

  it("keeps the page when read fails with a non-ENOENT error", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/keep-on-read-fail.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(
      pageAbsPath,
      [
        "# Memory Bridge (test)",
        "## Content",
        "```",
        "generated",
        "```",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "should survive read failure",
        "<!-- openclaw:human:end -->",
      ].join("\n"),
      "utf-8",
    );

    // Make the page unreadable by removing read permission.
    await fs.chmod(pageAbsPath, 0o000);

    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    // Restore permission so cleanup can proceed.
    await fs.chmod(pageAbsPath, 0o644);

    // Read failed with EACCES — the page and state entry must survive.
    expect(removed).toBe(0);
    const stillThere = await fs.readFile(pageAbsPath, "utf-8");
    expect(stillThere).toContain("should survive read failure");
  });

  it("rejects projected imports that would exceed the source-sync row cap", () => {
    expect(() =>
      assertMemoryWikiSourceSyncStateCapacity({
        state: {
          version: 1,
          entries: {
            retained: {
              group: "unsafe-local",
              pagePath: "sources/retained.md",
              sourcePath: "/tmp/retained.md",
              sourceUpdatedAtMs: 1,
              sourceSize: 1,
              renderFingerprint: "retained",
            },
          },
        },
        group: "bridge",
        incomingCount: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      }),
    ).toThrow("Memory Wiki source sync state exceeds SQLite entry limit");
  });
});
