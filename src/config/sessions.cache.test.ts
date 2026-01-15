import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  type SessionEntry,
  saveSessionStore,
} from "./sessions.js";

describe("Session Store Cache", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(() => {
    // Create a temporary directory for test
    testDir = path.join(os.tmpdir(), `session-cache-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    storePath = path.join(testDir, "sessions.json");

    // Clear cache before each test
    clearSessionStoreCacheForTest();

    // Reset environment variable
    delete process.env.CLAWDBOT_SESSION_CACHE_TTL_MS;
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    clearSessionStoreCacheForTest();
    delete process.env.CLAWDBOT_SESSION_CACHE_TTL_MS;
  });

  it("should load session store from disk on first call", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    // Write test data
    await saveSessionStore(storePath, testStore);

    // Load it
    const loaded = loadSessionStore(storePath);
    expect(loaded).toEqual(testStore);
  });

  it("should cache session store on first load when file is unchanged", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    await saveSessionStore(storePath, testStore);

    const readSpy = vi.spyOn(fs, "readFileSync");

    // First load - from disk
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Second load - should return cached data (no extra disk read)
    const loaded2 = loadSessionStore(storePath);
    expect(loaded2).toEqual(testStore);
    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it("should not allow cached session mutations to leak across loads", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        cliSessionIds: { openai: "sess-1" },
        skillsSnapshot: {
          prompt: "skills",
          skills: [{ name: "alpha" }],
        },
      },
    };

    await saveSessionStore(storePath, testStore);

    const loaded1 = loadSessionStore(storePath);
    loaded1["session:1"].cliSessionIds = { openai: "mutated" };
    if (loaded1["session:1"].skillsSnapshot?.skills?.length) {
      loaded1["session:1"].skillsSnapshot!.skills[0].name = "mutated";
    }

    const loaded2 = loadSessionStore(storePath);
    expect(loaded2["session:1"].cliSessionIds?.openai).toBe("sess-1");
    expect(loaded2["session:1"].skillsSnapshot?.skills?.[0]?.name).toBe("alpha");
  });

  it("should refresh cache when store file changes on disk", async () => {
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

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
    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

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

  it("should respect CLAWDBOT_SESSION_CACHE_TTL_MS=0 to disable cache", async () => {
    process.env.CLAWDBOT_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();

    const testStore: Record<string, SessionEntry> = {
      "session:1": {
        sessionId: "id-1",
        updatedAt: Date.now(),
        displayName: "Test Session 1",
      },
    };

    await saveSessionStore(storePath, testStore);

    // First load
    const loaded1 = loadSessionStore(storePath);
    expect(loaded1).toEqual(testStore);

    // Modify file on disk
    const modifiedStore: Record<string, SessionEntry> = {
      "session:2": {
        sessionId: "id-2",
        updatedAt: Date.now(),
        displayName: "Test Session 2",
      },
    };
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
});
