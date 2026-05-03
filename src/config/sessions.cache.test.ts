import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { readSessionStoreCache, writeSessionStoreCache } from "./sessions/store-cache.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
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

  it("does not parse serialized stores when writing the cache", () => {
    const testStore = createSingleSessionStore(
      createSessionEntry({
        origin: { provider: "openai" },
      }),
    );
    const serialized = JSON.stringify(testStore);
    const parseSpy = vi.spyOn(JSON, "parse");

    writeSessionStoreCache({ storePath, store: testStore, serialized });

    expect(parseSpy).not.toHaveBeenCalled();

    testStore["session:1"].origin = { provider: "mutated" };
    const cached = readSessionStoreCache({ storePath });

    expect(cached?.["session:1"].origin?.provider).toBe("openai");
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
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
    expect(loaded).toEqual({});
  });

  it("should handle invalid JSON gracefully", async () => {
    // Write invalid JSON
    fs.writeFileSync(storePath, "not valid json {");

    // Should return empty store
    const loaded = loadSessionStore(storePath);
    expect(loaded).toEqual({});
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
    expect(loaded2["session:2"]).toBeDefined();
    expect(loaded2["session:2"].displayName).toBe("Added");
  });
});
