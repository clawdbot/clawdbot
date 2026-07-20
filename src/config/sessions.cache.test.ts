// Verifies session config cache invalidation and reload behavior.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as jsonFiles from "../infra/json-files.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  getSerializedSessionStorePromptRefs,
  readSessionStoreCache,
  setSerializedSessionStore,
  setSerializedSessionStorePromptRefs,
  writeSessionStoreCache,
} from "./sessions/store-cache.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
  patchSessionEntryWithKey,
} from "./sessions/store.js";
import type { SessionEntry } from "./sessions/types.js";
import type { SessionSkillPromptRef } from "./sessions/types.js";

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

  it("keeps serialized prompt refs on the serialized cache entry lifecycle", () => {
    const promptRef: SessionSkillPromptRef = {
      version: 1,
      algorithm: "sha256",
      hash: "a".repeat(64),
      bytes: 123,
    };
    const refs = new Map([["session:1", promptRef]]);

    setSerializedSessionStore("store:refs", "{}");
    setSerializedSessionStorePromptRefs("store:refs", refs);

    expect(getSerializedSessionStorePromptRefs("store:refs")).toBe(refs);

    setSerializedSessionStore("store:refs", "{}");
    expect(getSerializedSessionStorePromptRefs("store:refs")).toBeUndefined();
  });

  it("should load session store from disk on first call", async () => {
    const testStore = createSingleSessionStore();

    // Write test data
    await saveSessionStore(storePath, testStore);

    // Load it
    const loaded = loadSessionStore(storePath);
    expect(loaded).toEqual(testStore);
  });

  it("retries transient session store read failures", async () => {
    const testStore = createSingleSessionStore();
    await saveSessionStore(storePath, testStore);
    clearSessionStoreCacheForTest();

    const originalReadFileSync = fs.readFileSync.bind(fs);
    let storeReads = 0;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) => {
      if (file === storePath) {
        storeReads += 1;
        if (storeReads === 1) {
          throw Object.assign(
            new Error("Unknown system error -11: Unknown system error -11, read"),
            { code: "EAGAIN", errno: -11 },
          );
        }
      }
      return originalReadFileSync(file, ...(args as [Parameters<typeof fs.readFileSync>[1]]));
    });

    try {
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual(testStore);
      expect(storeReads).toBe(2);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("does not retry permanent session store read failures", () => {
    clearSessionStoreCacheForTest();
    const missingPath = path.join(testDir, "missing-sessions.json");
    const readSpy = vi.spyOn(fs, "readFileSync");

    try {
      expect(loadSessionStore(missingPath, { skipCache: true })).toEqual({});
      expect(readSpy).toHaveBeenCalledOnce();
    } finally {
      readSpy.mockRestore();
    }
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
    expectDefined(loaded1["session:1"], 'loaded1["session:1"] test invariant').origin = {
      provider: "mutated",
    };
    for (const skill of expectDefined(loaded1["session:1"], "loaded session").skillsSnapshot
      ?.skills ?? []) {
      skill.name = "mutated";
      break;
    }

    const loaded2 = loadSessionStore(storePath);
    expect(
      expectDefined(loaded2["session:1"], 'loaded2["session:1"] test invariant').origin?.provider,
    ).toBe("openai");
    expect(
      expectDefined(loaded2["session:1"], 'loaded2["session:1"] test invariant').skillsSnapshot
        ?.skills?.[0]?.name,
    ).toBe("alpha");
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

    expectDefined(loaded1["session:1"], 'loaded1["session:1"] test invariant').origin = {
      provider: "mutated",
    };

    const loaded2 = loadSessionStore(storePath, { clone: false });
    expect(loaded2).toBe(loaded1);
    expect(
      expectDefined(loaded2["session:1"], 'loaded2["session:1"] test invariant').origin?.provider,
    ).toBe("mutated");
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
    expectDefined(loaded1["session:1"], 'loaded1["session:1"] test invariant').origin = {
      provider: "mutated",
    };
    for (const skill of expectDefined(loaded1["session:1"], "loaded session").skillsSnapshot
      ?.skills ?? []) {
      skill.name = "mutated";
      break;
    }

    const loaded2 = loadSessionStore(storePath);
    expect(
      expectDefined(loaded2["session:1"], 'loaded2["session:1"] test invariant').origin?.provider,
    ).toBe("openai");
    expect(
      expectDefined(loaded2["session:1"], 'loaded2["session:1"] test invariant').skillsSnapshot
        ?.skills?.[0]?.name,
    ).toBe("alpha");
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
      writeSessionStoreCache({
        storePath,
        store: testStore,
        serialized,
        cloneSerialized: serialized,
      });

      expect(parseSpy).not.toHaveBeenCalled();

      expectDefined(testStore["session:1"], 'testStore["session:1"] test invariant').origin = {
        provider: "mutated",
      };
      const cached = readSessionStoreCache({ storePath });

      expect(
        expectDefined(cached?.["session:1"], 'cached?.["session:1"] test invariant').origin
          ?.provider,
      ).toBe("openai");
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
    if (!entry) {
      throw new Error("Expected cached entry");
    }
    expect(entry?.polluted).toBeUndefined();
    expect(Object.hasOwn(entry as object, "__proto__")).toBe(true);
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
    const cachedState = expectDefined(cached?.["session:1"], 'cached?.["session:1"] test invariant')
      .pluginExtensions?.demo?.pluginState as Record<string, unknown> | undefined;

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

    expectDefined(loaded["session:1"], 'loaded["session:1"] test invariant').origin = {
      provider: "mutated",
    };
    for (const skill of expectDefined(loaded["session:1"], "loaded session").skillsSnapshot
      ?.skills ?? []) {
      skill.name = "mutated";
      break;
    }

    const reloaded = loadSessionStore(storePath, { skipCache: true });
    expect(
      expectDefined(reloaded["session:1"], 'reloaded["session:1"] test invariant').origin?.provider,
    ).toBe("openai");
    expect(
      expectDefined(reloaded["session:1"], 'reloaded["session:1"] test invariant').skillsSnapshot
        ?.skills?.[0]?.name,
    ).toBe("alpha");

    stringifySpy.mockRestore();
  });

  it("keeps whole-store update results detached from the mutable cache by default", async () => {
    await saveSessionStore(storePath, createSingleSessionStore());

    const persisted = await updateSessionStore(
      storePath,
      (store) => {
        const next = {
          ...expectDefined(store["session:1"], 'store["session:1"] test invariant'),
          displayName: "Updated Session",
          updatedAt: Date.now() + 1,
        };
        store["session:1"] = next;
        return next;
      },
      { skipMaintenance: true },
    );

    persisted.displayName = "Mutated after write";

    const cached = loadSessionStore(storePath, { clone: false });
    expect(cached["session:1"]).not.toBe(persisted);
    expect(
      expectDefined(cached["session:1"], 'cached["session:1"] test invariant').displayName,
    ).toBe("Updated Session");
  });

  it("can publish writer-owned session updates directly into the object cache", async () => {
    await saveSessionStore(storePath, createSingleSessionStore());

    const persisted = await updateSessionStore(
      storePath,
      (store) => {
        const next = {
          ...expectDefined(store["session:1"], 'store["session:1"] test invariant'),
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
    expect(
      expectDefined(cached["session:1"], 'cached["session:1"] test invariant').displayName,
    ).toBe("Writer owned");
  });

  it("can publish writer-owned entry patches directly into the object cache", async () => {
    await saveSessionStore(storePath, createSingleSessionStore());

    const persisted = await patchSessionEntryWithKey({
      storePath,
      sessionKey: "session:1",
      takeCacheOwnership: true,
      update: async () => ({
        displayName: "Entry writer owned",
        updatedAt: Date.now() + 1,
      }),
    });

    const cached = loadSessionStore(storePath, { clone: false });
    expect(cached["session:1"]).toBe(persisted?.entry);
    expect(
      expectDefined(cached["session:1"], 'cached["session:1"] test invariant').displayName,
    ).toBe("Entry writer owned");
  });

  it("publishes high-level entry patches without cloning the whole object cache", async () => {
    await saveSessionStore(storePath, {
      "session:1": createSessionEntry({ sessionId: "id-1" }),
      "session:2": createSessionEntry({ sessionId: "id-2" }),
    });
    const before = loadSessionStore(storePath, { clone: false });
    const untouched = before["session:2"];

    const persisted = await patchSessionEntryWithKey({
      storePath,
      sessionKey: "session:1",
      update: async () => ({
        displayName: "Entry writer owned by default",
        updatedAt: Date.now() + 1,
      }),
    });

    const cached = loadSessionStore(storePath, { clone: false });
    expect(cached["session:2"]).toBe(untouched);
    expect(cached["session:1"]).not.toBe(persisted?.entry);
    persisted!.entry.displayName = "Mutated returned entry";
    expect(
      expectDefined(cached["session:1"], 'cached["session:1"] test invariant').displayName,
    ).toBe("Entry writer owned by default");
  });

  it("detaches caller-owned patch objects before publishing writer-owned caches", async () => {
    await saveSessionStore(storePath, {
      "session:1": createSessionEntry({ sessionId: "id-1" }),
      "session:2": createSessionEntry({ sessionId: "id-2" }),
    });
    const before = loadSessionStore(storePath, { clone: false });
    const untouched = before["session:2"];
    const deliveryContext = { channel: "telegram", to: "chat-1" };

    await patchSessionEntryWithKey({
      storePath,
      sessionKey: "session:1",
      update: async () => ({ deliveryContext }),
    });
    deliveryContext.to = "mutated-after-persist";

    const cached = loadSessionStore(storePath, { clone: false });
    expect(cached["session:2"]).toBe(untouched);
    expect(
      expectDefined(cached["session:1"], 'cached["session:1"] test invariant').deliveryContext?.to,
    ).toBe("chat-1");
  });
  it("falls back to full projection when untouched entries need prompt blob repair", async () => {
    const prompt = "skill prompt ".repeat(80);
    await saveSessionStore(storePath, {
      "session:1": createSessionEntry({ sessionId: "id-1", displayName: "Before" }),
      "session:2": createSessionEntry({
        sessionId: "id-2",
        skillsSnapshot: {
          prompt,
          skills: [{ name: "alpha" }],
        },
      }),
    });
    const cached = loadSessionStore(storePath, { clone: false });
    expect(
      expectDefined(cached["session:2"], 'cached["session:2"] test invariant').skillsSnapshot
        ?.prompt,
    ).toBe(prompt);
    await fs.promises.rm(path.join(testDir, "skills-prompts"), {
      recursive: true,
      force: true,
    });

    await patchSessionEntryWithKey({
      storePath,
      sessionKey: "session:1",
      update: async () => ({ displayName: "After" }),
      takeCacheOwnership: true,
    });

    clearSessionStoreCacheForTest();
    const loaded = loadSessionStore(storePath);
    expect(
      expectDefined(loaded["session:1"], 'loaded["session:1"] test invariant').displayName,
    ).toBe("After");
    expect(
      expectDefined(loaded["session:2"], 'loaded["session:2"] test invariant').skillsSnapshot
        ?.prompt,
    ).toBe(prompt);
  });

  it("serializes the normalized entry when applying the one-entry fast path", async () => {
    await saveSessionStore(storePath, {
      "session:1": createSessionEntry({ sessionId: "id-1", displayName: "Before" }),
      "session:2": createSessionEntry({ sessionId: "id-2", displayName: "Untouched" }),
    });

    await patchSessionEntryWithKey({
      storePath,
      sessionKey: "session:1",
      update: async () => ({
        displayName: "After",
        skillsSnapshot: {
          prompt: "short prompt",
          skills: [{ name: "alpha" }],
          resolvedSkills: [
            createCanonicalFixtureSkill({
              name: "alpha",
              description: "alpha skill",
              filePath: "/skills/alpha/SKILL.md",
              baseDir: "/skills/alpha",
              source: "transient",
            }),
          ],
        } as SessionEntry["skillsSnapshot"],
      }),
      takeCacheOwnership: true,
    });

    const disk = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(expectDefined(disk["session:1"], 'disk["session:1"] test invariant').displayName).toBe(
      "After",
    );
    expect(
      expectDefined(disk["session:1"], 'disk["session:1"] test invariant').skillsSnapshot?.prompt,
    ).toBe("short prompt");
    expect(
      "resolvedSkills" in
        (expectDefined(disk["session:1"], 'disk["session:1"] test invariant').skillsSnapshot ?? {}),
    ).toBe(false);
  });

  it("restores the writer-owned cache when update result proves the store unchanged", async () => {
    await saveSessionStore(storePath, {
      "session:1": createSessionEntry({ sessionId: "id-1" }),
      "session:2": createSessionEntry({ sessionId: "id-2" }),
    });
    const before = loadSessionStore(storePath, { clone: false });
    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");

    const result = await updateSessionStore(storePath, () => 0, {
      skipSaveWhenResult: (cleared) => cleared === 0,
    });

    const after = loadSessionStore(storePath, { clone: false });
    expect(result).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(after).toBe(before);
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
        ...expectDefined(testStore["session:1"], 'testStore["session:1"] test invariant'),
        displayName: "Updated Session 1",
      },
    };

    // Save - should invalidate cache
    await saveSessionStore(storePath, updatedStore);

    // Load again - should get new data from disk
    const loaded2 = loadSessionStore(storePath);
    expect(
      expectDefined(loaded2["session:1"], 'loaded2["session:1"] test invariant').displayName,
    ).toBe("Updated Session 1");
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
    expect(
      expectDefined(loaded1["session:1"], 'loaded1["session:1"] test invariant').displayName,
    ).toBe("Original");

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
