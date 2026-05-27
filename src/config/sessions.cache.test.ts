import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  getSerializedSessionStore,
  getSerializedSessionStoreCacheStatsForTest,
  getSessionStoreSnapshotCacheStatsForTest,
  getSessionStoreStringInternStatsForTest,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./sessions/store-cache.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  readSessionEntries,
  readSessionEntry,
  readSessionStoreSnapshot,
  readSessionUpdatedAt,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./sessions/store.js";
import type { SessionEntry } from "./sessions/types.js";

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "id-1",
    updatedAt: Date.now(),
    displayName: "Test Session 1",
    ...overrides,
  };
}

function createSingleSessionStore(
  entry: SessionEntry = createSessionEntry(),
  key = "session:1",
): Record<string, SessionEntry> {
  return { [key]: entry };
}

describe("Session Store Cache", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "session-cache-test-" });
  let testDir: string;
  let storePath: string;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  beforeEach(async () => {
    testDir = await suiteRootTracker.make("case");
    storePath = path.join(testDir, "sessions.json");

    // Clear cache before each test
    clearSessionStoreCacheForTest();

    // Reset environment variable
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    delete process.env.OPENCLAW_SESSION_SERIALIZED_CACHE_MAX_BYTES;
  });

  it("bounds the serialized session store cache by total bytes", () => {
    process.env.OPENCLAW_SESSION_SERIALIZED_CACHE_MAX_BYTES = "64";
    clearSessionStoreCacheForTest();

    setSerializedSessionStore("store:1", "a".repeat(40));
    setSerializedSessionStore("store:2", "b".repeat(40));

    expect(getSerializedSessionStore("store:1")).toBeUndefined();
    expect(getSerializedSessionStore("store:2")).toBe("b".repeat(40));
    expect(getSerializedSessionStoreCacheStatsForTest().entries).toBe(1);
    expect(getSerializedSessionStoreCacheStatsForTest().totalBytes).toBe(40);
  });

  it("bounds the serialized session store cache by path count", () => {
    const maxEntries = getSerializedSessionStoreCacheStatsForTest().maxEntries;

    for (let index = 0; index < maxEntries + 2; index += 1) {
      setSerializedSessionStore(`store:${index}`, `serialized:${index}`);
    }

    expect(getSerializedSessionStore("store:0")).toBeUndefined();
    expect(getSerializedSessionStore("store:1")).toBeUndefined();
    expect(getSerializedSessionStore(`store:${maxEntries + 1}`)).toBe(
      `serialized:${maxEntries + 1}`,
    );
    expect(getSerializedSessionStoreCacheStatsForTest().entries).toBe(maxEntries);
  });

  it("should load session store from disk on first call", async () => {
    const testStore = createSingleSessionStore();

    // Write test data
    await saveSessionStore(storePath, testStore);

    // Load it
    const loaded = loadSessionStore(storePath);
    expect(loaded).toEqual(testStore);
  });

  it("should serve freshly saved session stores from cache without disk reads", async () => {
    const testStore = createSingleSessionStore();

    await saveSessionStore(storePath, testStore);

    const readSpy = vi.spyOn(fs, "readFileSync");

    // First load - served from write-through cache
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Second load - should stay cached (still no disk read)
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2).toEqual(testStore);
    expect(readSpy).toHaveBeenCalledTimes(0);
    readSpy.mockRestore();
  });

  it("should not allow cached session mutations to leak across loads", async () => {
    const testStore = createSingleSessionStore(
      createSessionEntry({
        origin: { provider: "openai" },
        skillsSnapshot: {
          prompt: "skills",
          skills: [{ name: "alpha" }],
        },
      }),
    );

    await saveSessionStore(storePath, testStore);

    const loaded1 = loadSessionStore(storePath);
    loaded1["session:1"].origin = { provider: "mutated" };
    if (loaded1["session:1"].skillsSnapshot?.skills?.length) {
      loaded1["session:1"].skillsSnapshot.skills[0].name = "mutated";
    }

    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:1"].origin?.provider).toBe("openai");
    expect(loaded2["session:1"].skillsSnapshot?.skills?.[0]?.name).toBe("alpha");
  });

  it("honors explicit clone:false on cache hits", async () => {
    const testStore = createSingleSessionStore(
      createSessionEntry({
        origin: { provider: "openai" },
      }),
    );

    await saveSessionStore(storePath, testStore);

    const parseSpy = vi.spyOn(JSON, "parse");

    const loaded1 = loadSessionStore(storePath, { clone: false });
    expect(parseSpy).not.toHaveBeenCalled();

    loaded1["session:1"].origin = { provider: "mutated" };

    const loaded2 = loadSessionStore(storePath, { clone: false });
    expect(loaded2).toBe(loaded1);
    expect(loaded2["session:1"].origin?.provider).toBe("mutated");
    expect(parseSpy).not.toHaveBeenCalled();

    parseSpy.mockRestore();
  });

  it("keeps disk-loaded clone:false cache hits by reference", () => {
    const testStore = createSingleSessionStore();
    fs.writeFileSync(storePath, JSON.stringify(testStore), "utf8");

    const loaded1 = loadSessionStore(storePath, { clone: false });
    const loaded2 = loadSessionStore(storePath, { clone: false });

    expect(loaded2["session:1"]).toBe(loaded1["session:1"]);
  });

  it("does not cache pre-migration or pre-normalization disk JSON", () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "session:1": {
          sessionId: "id-1",
          updatedAt: Date.now(),
          provider: "telegram",
          room: "room-1",
          modelProvider: " openai ",
          model: " gpt-5.4 ",
        },
      }),
    );

    const loaded1 = loadSessionStore(storePath);
    const entry1 = loaded1["session:1"] as SessionEntry & { provider?: string; room?: string };
    expect(entry1.channel).toBe("telegram");
    expect(entry1.groupChannel).toBe("room-1");
    expect(entry1.provider).toBeUndefined();
    expect(entry1.room).toBeUndefined();
    expect(entry1.modelProvider).toBe("openai");
    expect(entry1.model).toBe("gpt-5.4");

    const loaded2 = loadSessionStore(storePath);
    const entry2 = loaded2["session:1"] as SessionEntry & { provider?: string; room?: string };
    expect(entry2.channel).toBe("telegram");
    expect(entry2.groupChannel).toBe("room-1");
    expect(entry2.provider).toBeUndefined();
    expect(entry2.room).toBeUndefined();
    expect(entry2.modelProvider).toBe("openai");
    expect(entry2.model).toBe("gpt-5.4");
  });

  it("isolates cached session stores without structuredClone", async () => {
    const structuredCloneSpy = vi.spyOn(globalThis, "structuredClone");
    const testStore = createSingleSessionStore(
      createSessionEntry({
        origin: { provider: "openai" },
        skillsSnapshot: {
          prompt: "skills",
          skills: [{ name: "alpha" }],
        },
      }),
    );

    await saveSessionStore(storePath, testStore);

    const loaded1 = loadSessionStore(storePath);
    loaded1["session:1"].origin = { provider: "mutated" };
    if (loaded1["session:1"].skillsSnapshot?.skills?.length) {
      loaded1["session:1"].skillsSnapshot.skills[0].name = "mutated";
    }

    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:1"].origin?.provider).toBe("openai");
    expect(loaded2["session:1"].skillsSnapshot?.skills?.[0]?.name).toBe("alpha");
    expect(structuredCloneSpy).not.toHaveBeenCalled();

    structuredCloneSpy.mockRestore();
  });

  it("parses serialized stores only when cloning object-cache hits", () => {
    const testStore = createSingleSessionStore(
      createSessionEntry({
        origin: { provider: "openai" },
      }),
    );
    const serialized = JSON.stringify(testStore);
    const parseSpy = vi.spyOn(JSON, "parse");

    try {
      writeSessionStoreCache({ storePath, store: testStore, serialized });

      expect(parseSpy).not.toHaveBeenCalled();

      testStore["session:1"].origin = { provider: "mutated" };
      const cached = readSessionStoreCache({ storePath });

      expect(cached?.["session:1"].origin?.provider).toBe("openai");
      expect(parseSpy).toHaveBeenCalledOnce();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("clones cached session records without invoking prototype setters", () => {
    const testStore = JSON.parse(
      `{"session:1":{"sessionId":"id-1","updatedAt":${Date.now()},"displayName":"Test Session 1","__proto__":{"polluted":true}}}`,
    ) as Record<string, SessionEntry>;

    writeSessionStoreCache({ storePath, store: testStore });
    const cached = readSessionStoreCache({ storePath });
    const entry = cached?.["session:1"] as (SessionEntry & { polluted?: boolean }) | undefined;

    expect(entry).toBeDefined();
    expect(entry?.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry, "__proto__")).toBe(true);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("preserves own __proto__ plugin JSON fields without changing clone prototypes", () => {
    const pluginState: { [key: string]: unknown } = { ok: true };
    Object.defineProperty(pluginState, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const testStore = createSingleSessionStore(
      createSessionEntry({
        pluginExtensions: {
          demo: {
            pluginState: pluginState as never,
          },
        },
      }),
    );

    writeSessionStoreCache({ storePath, store: testStore });

    const cached = readSessionStoreCache({ storePath });
    const cachedState = cached?.["session:1"].pluginExtensions?.demo?.pluginState as
      | Record<string, unknown>
      | undefined;

    expect(cachedState).toBeTruthy();
    expect(Object.hasOwn(cachedState ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(cachedState, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(Object.getPrototypeOf(cachedState ?? {})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("clones disk-loaded stores from the raw serialized JSON", () => {
    const testStore = createSingleSessionStore(
      createSessionEntry({
        origin: { provider: "openai" },
        skillsSnapshot: {
          prompt: "skills",
          skills: [{ name: "alpha" }],
        },
      }),
    );
    const serialized = JSON.stringify(testStore);
    fs.writeFileSync(storePath, serialized);

    const stringifySpy = vi.spyOn(JSON, "stringify");
    const loaded = loadSessionStore(storePath, { skipCache: true });

    expect(loaded).toEqual(testStore);
    expect(stringifySpy).not.toHaveBeenCalled();

    loaded["session:1"].origin = { provider: "mutated" };
    if (loaded["session:1"].skillsSnapshot?.skills?.length) {
      loaded["session:1"].skillsSnapshot.skills[0].name = "mutated";
    }

    const reloaded = loadSessionStore(storePath, { skipCache: true });
    expect(reloaded["session:1"].origin?.provider).toBe("openai");
    expect(reloaded["session:1"].skillsSnapshot?.skills?.[0]?.name).toBe("alpha");

    stringifySpy.mockRestore();
  });

  it("interns duplicate large skillsSnapshot prompts across cached loads", async () => {
    const largePrompt = "skill prompt ".repeat(200);
    const testStore = {
      "session:1": createSessionEntry({
        skillsSnapshot: {
          prompt: largePrompt,
          skills: [{ name: "alpha" }],
        },
      }),
      "session:2": createSessionEntry({
        sessionId: "id-2",
        displayName: "Test Session 2",
        skillsSnapshot: {
          prompt: largePrompt,
          skills: [{ name: "beta" }],
        },
      }),
    };

    await saveSessionStore(storePath, testStore);
    clearSessionStoreCacheForTest();

    const loaded1 = loadSessionStore(storePath);
    const afterFirstLoad = getSessionStoreStringInternStatsForTest();
    expect(afterFirstLoad.poolSize).toBe(1);
    expect(afterFirstLoad.stored).toBe(1);
    expect(afterFirstLoad.reused).toBeGreaterThanOrEqual(1);

    if (loaded1["session:1"].skillsSnapshot?.skills?.length) {
      loaded1["session:1"].skillsSnapshot.skills[0].name = "mutated";
    }

    const loaded2 = loadSessionStore(storePath);
    const afterSecondLoad = getSessionStoreStringInternStatsForTest();
    expect(afterSecondLoad.poolSize).toBe(1);
    expect(afterSecondLoad.reused).toBeGreaterThanOrEqual(afterFirstLoad.reused + 2);
    expect(loaded2["session:1"].skillsSnapshot?.skills?.[0]?.name).toBe("alpha");
  });

  it("does not intern short skillsSnapshot prompts", async () => {
    const testStore = {
      "session:1": createSessionEntry({
        skillsSnapshot: {
          prompt: "short prompt",
          skills: [{ name: "alpha" }],
        },
      }),
      "session:2": createSessionEntry({
        sessionId: "id-2",
        displayName: "Test Session 2",
        skillsSnapshot: {
          prompt: "short prompt",
          skills: [{ name: "beta" }],
        },
      }),
    };

    await saveSessionStore(storePath, testStore);
    clearSessionStoreCacheForTest();

    loadSessionStore(storePath);

    const stats = getSessionStoreStringInternStatsForTest();
    expect(stats.poolSize).toBe(0);
    expect(stats.skippedSmall).toBeGreaterThanOrEqual(2);
  });

  it("reads updatedAt from immutable session snapshots without cloning cached stores", async () => {
    const updatedAt = Date.now();
    const testStore = createSingleSessionStore(
      createSessionEntry({
        updatedAt,
      }),
      "agent:main:main",
    );

    await saveSessionStore(storePath, testStore);
    clearSessionStoreCacheForTest();
    readSessionStoreSnapshot(storePath);
    expect(readSessionEntry(storePath, "agent:main:main")?.updatedAt).toBe(updatedAt);

    const parseSpy = vi.spyOn(JSON, "parse");

    expect(readSessionUpdatedAt({ storePath, sessionKey: "agent:main:main" })).toBe(updatedAt);
    expect(parseSpy).not.toHaveBeenCalled();

    parseSpy.mockRestore();
  });

  it("builds a snapshot from disk without reparsing the mutable clone", async () => {
    const testStore = createSingleSessionStore(
      createSessionEntry({
        skillsSnapshot: {
          prompt: "snapshot skill prompt ".repeat(200),
          skills: [{ name: "alpha" }],
        },
      }),
    );

    await saveSessionStore(storePath, testStore);
    clearSessionStoreCacheForTest();

    const parseSpy = vi.spyOn(JSON, "parse");

    const snapshot = readSessionStoreSnapshot(storePath);

    expect(snapshot["session:1"].sessionId).toBe("id-1");
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
  });

  it("serves immutable session snapshots without cloning cache hits", async () => {
    const testStore = createSingleSessionStore(
      createSessionEntry({
        origin: { provider: "openai" },
        skillsSnapshot: {
          prompt: "snapshot skill prompt ".repeat(200),
          skills: [{ name: "alpha" }],
        },
      }),
    );

    await saveSessionStore(storePath, testStore);
    clearSessionStoreCacheForTest();

    const snapshot1 = readSessionStoreSnapshot(storePath);
    const snapshot2 = readSessionStoreSnapshot(storePath);

    expect(snapshot2).toBe(snapshot1);
    expect(Object.isFrozen(snapshot1)).toBe(true);
    expect(Object.isFrozen(snapshot1["session:1"])).toBe(true);
    expect(Object.isFrozen(snapshot1["session:1"].skillsSnapshot?.skills)).toBe(true);
    expect(readSessionEntry(storePath, "session:1")?.sessionId).toBe("id-1");
    expect(readSessionEntries(storePath).map(([key]) => key)).toEqual(["session:1"]);

    expect(() => {
      (snapshot1 as Record<string, SessionEntry>)["session:2"] = createSessionEntry({
        sessionId: "id-2",
      });
    }).toThrow(TypeError);

    const mutable = loadSessionStore(storePath);
    mutable["session:1"].origin = { provider: "mutated" };

    expect(readSessionStoreSnapshot(storePath)["session:1"].origin?.provider).toBe("openai");
  });

  it("does not tag snapshots with stats from writes racing after a disk read", async () => {
    await saveSessionStore(
      storePath,
      createSingleSessionStore(createSessionEntry({ displayName: "Before race" })),
    );
    clearSessionStoreCacheForTest();

    const afterRaceStore = createSingleSessionStore(
      createSessionEntry({ displayName: "After cross-process race" }),
    );
    const originalReadFileSync = fs.readFileSync.bind(fs);
    let wroteAfterRead = false;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
      const result = originalReadFileSync(
        file,
        ...(args as [Parameters<typeof fs.readFileSync>[1]]),
      );
      if (file === storePath && !wroteAfterRead) {
        wroteAfterRead = true;
        fs.writeFileSync(storePath, JSON.stringify(afterRaceStore, null, 2));
        const bumped = new Date(Date.now() + 2_000);
        fs.utimesSync(storePath, bumped, bumped);
      }
      return result;
    });

    const first = readSessionStoreSnapshot(storePath);
    expect(first["session:1"].displayName).toBe("Before race");

    readSpy.mockRestore();

    const second = readSessionStoreSnapshot(storePath);
    expect(second["session:1"].displayName).toBe("After cross-process race");
  });

  it("publishes a new immutable snapshot after session store writes", async () => {
    await saveSessionStore(storePath, createSingleSessionStore());

    const before = readSessionStoreSnapshot(storePath);

    await updateSessionStore(
      storePath,
      (store) => {
        store["session:1"] = {
          ...store["session:1"],
          displayName: "Updated Session",
          updatedAt: Date.now() + 1,
        };
      },
      { skipMaintenance: true },
    );

    const after = readSessionStoreSnapshot(storePath);

    expect(after).not.toBe(before);
    expect(before["session:1"].displayName).toBe("Test Session 1");
    expect(after["session:1"].displayName).toBe("Updated Session");
  });

  it("can publish writer-owned session updates directly into the object cache", async () => {
    await saveSessionStore(storePath, createSingleSessionStore());

    const persisted = await updateSessionStore(
      storePath,
      (store) => {
        const next = {
          ...store["session:1"],
          displayName: "Writer owned",
          updatedAt: Date.now() + 1,
        };
        store["session:1"] = next;
        return next;
      },
      { takeCacheOwnership: true },
    );

    const cached = loadSessionStore(storePath, { clone: false });
    expect(cached["session:1"]).toBe(persisted);
    expect(cached["session:1"].displayName).toBe("Writer owned");
  });

  it("can publish writer-owned entry patches directly into the object cache", async () => {
    await saveSessionStore(storePath, createSingleSessionStore());

    const persisted = await updateSessionStoreEntry({
      storePath,
      sessionKey: "session:1",
      takeCacheOwnership: true,
      update: async () => ({
        displayName: "Entry writer owned",
        updatedAt: Date.now() + 1,
      }),
    });

    const cached = loadSessionStore(storePath, { clone: false });
    expect(cached["session:1"]).toBe(persisted);
    expect(cached["session:1"].displayName).toBe("Entry writer owned");
  });

  it("builds immutable session snapshots lazily after writes", async () => {
    await saveSessionStore(storePath, createSingleSessionStore());

    expect(getSessionStoreSnapshotCacheStatsForTest().entries).toBe(0);

    const first = readSessionStoreSnapshot(storePath);
    const statsAfterRead = getSessionStoreSnapshotCacheStatsForTest();
    const second = readSessionStoreSnapshot(storePath);

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(statsAfterRead.entries).toBe(1);

    await updateSessionStore(
      storePath,
      (store) => {
        store["session:1"] = {
          ...store["session:1"],
          displayName: "Updated lazily",
          updatedAt: Date.now() + 1,
        };
      },
      { skipMaintenance: true },
    );

    expect(getSessionStoreSnapshotCacheStatsForTest().entries).toBe(0);
    expect(readSessionStoreSnapshot(storePath)["session:1"].displayName).toBe("Updated lazily");
  });

  it("should refresh cache when store file changes on disk", async () => {
    const testStore = createSingleSessionStore();

    await saveSessionStore(storePath, testStore);

    // First load - from disk
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Modify file on disk while cache is valid
    const modifiedStore: Record<string, SessionEntry> = {
      "session:99": { sessionId: "id-99", updatedAt: Date.now() },
    };
    fs.writeFileSync(storePath, JSON.stringify(modifiedStore, null, 2));
    const bump = new Date(Date.now() + 2000);
    fs.utimesSync(storePath, bump, bump);

    // Second load - should return the updated store
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2).toEqual(modifiedStore);
  });

  it("should invalidate cache on write", async () => {
    const testStore = createSingleSessionStore();

    await saveSessionStore(storePath, testStore);

    // Load - should cache
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Update store
    const updatedStore: Record<string, SessionEntry> = {
      "session:1": {
        ...testStore["session:1"],
        displayName: "Updated Session 1",
      },
    };

    // Save - should invalidate cache
    await saveSessionStore(storePath, updatedStore);

    // Load again - should get new data from disk
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:1"].displayName).toBe("Updated Session 1");
  });

  it("should respect OPENCLAW_SESSION_CACHE_TTL_MS=0 to disable cache", async () => {
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();

    const testStore = createSingleSessionStore();

    await saveSessionStore(storePath, testStore);

    // First load
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Modify file on disk
    const modifiedStore = createSingleSessionStore(
      createSessionEntry({ sessionId: "id-2", displayName: "Test Session 2" }),
      "session:2",
    );
    fs.writeFileSync(storePath, JSON.stringify(modifiedStore, null, 2));

    // Second load - should read from disk (cache disabled)
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2).toEqual(modifiedStore); // Should be modified, not cached
  });

  it("should handle non-existent store gracefully", () => {
    const nonExistentPath = path.join(testDir, "non-existent.json");

    // Should return empty store
    const loaded = loadSessionStore(nonExistentPath);
    expect(loaded).toStrictEqual({});
  });

  it("should handle invalid JSON gracefully", () => {
    // Write invalid JSON
    fs.writeFileSync(storePath, "not valid json {");

    // Should return empty store
    const loaded = loadSessionStore(storePath);
    expect(loaded).toStrictEqual({});
  });

  it("should refresh cache when file is rewritten within the same mtime tick", async () => {
    // This reproduces the CI flake where fast test writes complete within the
    // same mtime granularity (typically 1s on HFS+/ext4), so mtime-only
    // invalidation returns stale cached data.
    const store1: Record<string, SessionEntry> = {
      "session:1": createSessionEntry({ sessionId: "id-1", displayName: "Original" }),
    };

    await saveSessionStore(storePath, store1);

    // Warm the cache
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1["session:1"].displayName).toBe("Original");

    // Rewrite the file directly (bypassing saveSessionStore's write-through
    // cache) with different content but preserve the same mtime so only size
    // changes.
    const store2: Record<string, SessionEntry> = {
      "session:1": createSessionEntry({ sessionId: "id-1", displayName: "Original" }),
      "session:2": createSessionEntry({ sessionId: "id-2", displayName: "Added" }),
    };
    const preWriteStat = fs.statSync(storePath);
    const json2 = JSON.stringify(store2, null, 2);
    fs.writeFileSync(storePath, json2);

    // Force mtime to match the cached value so only size differs
    fs.utimesSync(storePath, preWriteStat.atime, preWriteStat.mtime);

    // The cache should detect the size change and reload from disk
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:2"]?.displayName).toBe("Added");
  });
});
