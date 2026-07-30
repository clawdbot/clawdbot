// Plugin blob store tests cover persistence, quotas, expiry, and copied bytes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
  type OpenBlobStoreOptions,
} from "./plugin-blob-store.js";
import { PluginBlobStoreError } from "./plugin-blob-store.types.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginBlobStoreForTests();
});

type TestBlobStoreOptions = OpenBlobStoreOptions & { env: NodeJS.ProcessEnv };

function options(
  env: NodeJS.ProcessEnv,
  overrides: Partial<OpenBlobStoreOptions> = {},
): TestBlobStoreOptions {
  return {
    namespace: "artifacts",
    maxEntries: 3,
    maxBytesPerEntry: 16,
    maxBytesPerNamespace: 32,
    env,
    ...overrides,
  };
}

function createPluginBlobStore<TMetadata>(pluginId: string, testOptions: TestBlobStoreOptions) {
  const { env, ...storeOptions } = testOptions;
  return createPluginBlobStoreForTests<TMetadata>(pluginId, storeOptions, env);
}

describe("plugin blob store", () => {
  it("round-trips metadata and copies bytes on both sides", async () => {
    await withOpenClawTestState({ label: "plugin-blob-roundtrip" }, async (state) => {
      const store = createPluginBlobStore<{ kind: string }>("diffs", options(state.env));
      const source = new Uint8Array([1, 2, 3]);
      await store.register("viewer", source, { kind: "viewer" });
      source[0] = 9;

      const first = await store.lookup("viewer");
      expect(first).toMatchObject({
        key: "viewer",
        metadata: { kind: "viewer" },
        sizeBytes: 3,
      });
      expect(first?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      first!.bytes[0] = 8;
      expect((await store.lookup("viewer"))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      const entries = await store.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ key: "viewer", metadata: { kind: "viewer" } });
      expect("bytes" in entries[0]!).toBe(false);
    });
  });

  it("rejects quota overflow without disturbing existing rows", async () => {
    await withOpenClawTestState({ label: "plugin-blob-reject" }, async (state) => {
      const store = createPluginBlobStore<{ order: number }>(
        "diffs",
        options(state.env, {
          maxEntries: 1,
          maxBytesPerEntry: 4,
          maxBytesPerNamespace: 4,
          overflowPolicy: "reject-new",
        }),
      );
      await store.register("one", new Uint8Array([1, 2]), { order: 1 });
      await expect(store.register("two", new Uint8Array([3]), { order: 2 })).rejects.toMatchObject({
        code: "PLUGIN_BLOB_LIMIT_EXCEEDED",
      });
      expect((await store.entries()).map((entry) => entry.key)).toEqual(["one"]);
    });
  });

  it("evicts the oldest namespace row while protecting the current write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await withOpenClawTestState({ label: "plugin-blob-evict" }, async (state) => {
      const store = createPluginBlobStore<{ order: number }>(
        "diffs",
        options(state.env, { maxEntries: 2 }),
      );
      await store.register("one", new Uint8Array([1]), { order: 1 });
      vi.setSystemTime(1_001);
      await store.register("two", new Uint8Array([2]), { order: 2 });
      vi.setSystemTime(1_002);
      await store.register("three", new Uint8Array([3]), { order: 3 });
      expect((await store.entries()).map((entry) => entry.key)).toEqual(["two", "three"]);
    });
  });

  it("keeps expired metadata owner-managed across later writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    await withOpenClawTestState({ label: "plugin-blob-expiry" }, async (state) => {
      const store = createPluginBlobStore<{ order: number }>("diffs", options(state.env));
      await store.register("one", new Uint8Array([1]), { order: 1 }, { ttlMs: 10 });
      vi.setSystemTime(2_011);
      await store.register("two", new Uint8Array([2]), { order: 2 }, { ttlMs: 10 });
      await expect(store.deleteExpiredKey("one")).resolves.toEqual(
        expect.objectContaining({ key: "one", metadata: { order: 1 } }),
      );
      await expect(store.deleteExpiredKey("two")).resolves.toBeUndefined();
      await expect(store.deleteExpired()).resolves.toEqual([]);
      await expect(store.lookup("two")).resolves.toMatchObject({ metadata: { order: 2 } });
    });
  });

  it("counts expired rows toward physical limits without evicting cleanup metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_500);
    await withOpenClawTestState({ label: "plugin-blob-expired-quota" }, async (state) => {
      const rejectingStore = createPluginBlobStore<{ path: string }>(
        "diffs",
        options(state.env, { maxEntries: 1, overflowPolicy: "reject-new" }),
      );
      await rejectingStore.register(
        "expired",
        new Uint8Array([1]),
        { path: "reject-old" },
        { ttlMs: 10 },
      );
      vi.setSystemTime(2_511);

      await expect(
        rejectingStore.register("fresh", new Uint8Array([2]), { path: "reject-new" }),
      ).rejects.toMatchObject({ code: "PLUGIN_BLOB_LIMIT_EXCEEDED" });
      await expect(rejectingStore.deleteExpiredKey("expired")).resolves.toMatchObject({
        metadata: { path: "reject-old" },
      });
      await expect(
        rejectingStore.register("fresh", new Uint8Array([2]), { path: "reject-new" }),
      ).resolves.toBeUndefined();

      const evictingStore = createPluginBlobStore<{ path: string }>(
        "diffs",
        options(state.env, {
          namespace: "evicting",
          maxEntries: 1,
          overflowPolicy: "evict-oldest",
        }),
      );
      await evictingStore.register(
        "expired",
        new Uint8Array([3]),
        { path: "evict-old" },
        { ttlMs: 10 },
      );
      vi.setSystemTime(2_522);

      await expect(
        evictingStore.register("fresh", new Uint8Array([4]), { path: "evict-new" }),
      ).rejects.toMatchObject({ code: "PLUGIN_BLOB_LIMIT_EXCEEDED" });
      await expect(evictingStore.deleteExpiredKey("expired")).resolves.toMatchObject({
        metadata: { path: "evict-old" },
      });

      const replacingStore = createPluginBlobStore<{ path: string }>(
        "diffs",
        options(state.env, {
          namespace: "replacing",
          maxBytesPerEntry: 10,
          maxBytesPerNamespace: 10,
          overflowPolicy: "evict-oldest",
        }),
      );
      await replacingStore.register(
        "expired",
        new Uint8Array(5),
        { path: "replace-old" },
        { ttlMs: 10 },
      );
      await replacingStore.register("target", new Uint8Array(4), { path: "target-old" });
      vi.setSystemTime(2_533);

      await expect(
        replacingStore.register("target", new Uint8Array(6), { path: "target-new" }),
      ).rejects.toMatchObject({ code: "PLUGIN_BLOB_LIMIT_EXCEEDED" });
      await expect(replacingStore.lookup("target")).resolves.toMatchObject({
        metadata: { path: "target-old" },
        sizeBytes: 4,
      });
      await expect(replacingStore.deleteExpiredKey("expired")).resolves.toMatchObject({
        metadata: { path: "replace-old" },
      });
    });
  });

  it("validates hard limits and consistent namespace options", async () => {
    await withOpenClawTestState({ label: "plugin-blob-validation" }, async (state) => {
      const store = createPluginBlobStore("diffs", options(state.env, { maxBytesPerEntry: 2 }));
      await expect(store.register("big", new Uint8Array([1, 2, 3]), {})).rejects.toBeInstanceOf(
        PluginBlobStoreError,
      );
      expect(() =>
        createPluginBlobStore("diffs", options(state.env, { maxBytesPerEntry: 3 })),
      ).toThrow(/incompatible options/);
    });
  });

  it("isolates plugin ids and namespaces and persists across reopen", async () => {
    await withOpenClawTestState({ label: "plugin-blob-isolation" }, async (state) => {
      const diffs = createPluginBlobStore<{ owner: string }>("diffs", options(state.env));
      const otherPlugin = createPluginBlobStore<{ owner: string }>("other", options(state.env));
      const otherNamespace = createPluginBlobStore<{ owner: string }>(
        "diffs",
        options(state.env, { namespace: "other-artifacts" }),
      );
      await diffs.register("same", new Uint8Array([1]), { owner: "diffs" });

      await expect(otherPlugin.lookup("same")).resolves.toBeUndefined();
      await expect(otherNamespace.lookup("same")).resolves.toBeUndefined();
      resetPluginBlobStoreForTests();

      const reopened = createPluginBlobStore<{ owner: string }>("diffs", options(state.env));
      await expect(reopened.lookup("same")).resolves.toMatchObject({
        metadata: { owner: "diffs" },
        bytes: new Uint8Array([1]),
      });
    });
  });

  it("keeps the first row when registerIfAbsent loses a collision", async () => {
    await withOpenClawTestState({ label: "plugin-blob-if-absent" }, async (state) => {
      const store = createPluginBlobStore<{ order: number }>("diffs", options(state.env));
      await expect(store.registerIfAbsent("same", new Uint8Array([1]), { order: 1 })).resolves.toBe(
        true,
      );
      await expect(store.registerIfAbsent("same", new Uint8Array([2]), { order: 2 })).resolves.toBe(
        false,
      );
      await expect(store.lookup("same")).resolves.toMatchObject({
        metadata: { order: 1 },
        bytes: new Uint8Array([1]),
      });
    });
  });

  it("keeps an expired stable key occupied until the owner claims its metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    await withOpenClawTestState({ label: "plugin-blob-expired-if-absent" }, async (state) => {
      const store = createPluginBlobStore<{ path: string }>("diffs", options(state.env));
      await expect(
        store.registerIfAbsent("stable", new Uint8Array([1]), { path: "old" }, { ttlMs: 10 }),
      ).resolves.toBe(true);

      vi.setSystemTime(4_011);
      await expect(
        store.registerIfAbsent("stable", new Uint8Array([2]), { path: "new" }),
      ).resolves.toBe(false);
      await expect(store.deleteExpiredKey("stable")).resolves.toMatchObject({
        key: "stable",
        metadata: { path: "old" },
      });
      await expect(
        store.registerIfAbsent("stable", new Uint8Array([2]), { path: "new" }),
      ).resolves.toBe(true);
      await expect(store.lookup("stable")).resolves.toMatchObject({
        metadata: { path: "new" },
        bytes: new Uint8Array([2]),
      });
    });
  });

  it("lets explicit register overwrite an expired key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_500);
    await withOpenClawTestState({ label: "plugin-blob-expired-overwrite" }, async (state) => {
      const store = createPluginBlobStore<{ version: string }>("diffs", options(state.env));
      await store.register("stable", new Uint8Array([1]), { version: "old" }, { ttlMs: 10 });

      vi.setSystemTime(4_511);
      await store.register("stable", new Uint8Array([2]), { version: "new" });

      await expect(store.lookup("stable")).resolves.toMatchObject({
        metadata: { version: "new" },
        bytes: new Uint8Array([2]),
      });
      await expect(store.deleteExpiredKey("stable")).resolves.toBeUndefined();
    });
  });

  it("evicts by namespace bytes without touching sibling namespaces", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    await withOpenClawTestState({ label: "plugin-blob-byte-evict" }, async (state) => {
      const store = createPluginBlobStore<{ order: number }>(
        "diffs",
        options(state.env, { maxBytesPerEntry: 3, maxBytesPerNamespace: 3 }),
      );
      const sibling = createPluginBlobStore<{ order: number }>(
        "diffs",
        options(state.env, {
          namespace: "sibling",
          maxBytesPerEntry: 3,
          maxBytesPerNamespace: 3,
        }),
      );
      await sibling.register("keep", new Uint8Array([9]), { order: 0 });
      await store.register("one", new Uint8Array([1, 1]), { order: 1 });
      vi.setSystemTime(3_001);
      await store.register("two", new Uint8Array([2]), { order: 2 });
      vi.setSystemTime(3_002);
      await store.register("three", new Uint8Array([3, 3]), { order: 3 });

      expect((await store.entries()).map((entry) => entry.key)).toEqual(["two", "three"]);
      expect((await sibling.entries()).map((entry) => entry.key)).toEqual(["keep"]);
    });
  });

  it("rolls back a rejected replacement and rejects corrupt metadata", async () => {
    await withOpenClawTestState({ label: "plugin-blob-corrupt" }, async (state) => {
      const store = createPluginBlobStore<{ ok: boolean }>(
        "diffs",
        options(state.env, {
          maxBytesPerEntry: 3,
          maxBytesPerNamespace: 3,
          overflowPolicy: "reject-new",
        }),
      );
      await store.register("stable", new Uint8Array([1, 2]), { ok: true });
      await expect(
        store.register("stable", new Uint8Array([1, 2, 3, 4]), { ok: false }),
      ).rejects.toMatchObject({ code: "PLUGIN_BLOB_LIMIT_EXCEEDED" });
      await expect(store.lookup("stable")).resolves.toMatchObject({
        metadata: { ok: true },
        bytes: new Uint8Array([1, 2]),
      });

      const { db } = openOpenClawStateDatabase({ env: state.env });
      db.prepare(
        `INSERT INTO plugin_blob_entries
          (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("diffs", "artifacts", "corrupt", "{", Buffer.from([7]), 1, null);
      await expect(store.lookup("corrupt")).rejects.toMatchObject({
        code: "PLUGIN_BLOB_CORRUPT",
      });
    });
  });

  it("preserves expired rows when owner metadata is corrupt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    await withOpenClawTestState({ label: "plugin-blob-corrupt-expired" }, async (state) => {
      const store = createPluginBlobStore<{ path: string }>("diffs", options(state.env));
      await store.register("valid", new Uint8Array([1]), { path: "valid" }, { ttlMs: 10 });
      const { db } = openOpenClawStateDatabase({ env: state.env });
      db.prepare(
        `INSERT INTO plugin_blob_entries
          (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("diffs", "artifacts", "corrupt", "{", Buffer.from([7]), 5_000, 5_010);

      vi.setSystemTime(5_011);
      await expect(store.deleteExpired()).rejects.toMatchObject({ code: "PLUGIN_BLOB_CORRUPT" });
      expect(
        db
          .prepare(
            `SELECT entry_key FROM plugin_blob_entries
             WHERE plugin_id = ? AND namespace = ? ORDER BY entry_key`,
          )
          .all("diffs", "artifacts"),
      ).toEqual([{ entry_key: "corrupt" }, { entry_key: "valid" }]);

      await expect(store.deleteExpiredKey("corrupt")).rejects.toMatchObject({
        code: "PLUGIN_BLOB_CORRUPT",
      });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM plugin_blob_entries
             WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
          )
          .get("diffs", "artifacts", "corrupt"),
      ).toEqual({ count: 1 });
    });
  });
});
