import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import type { SessionEntry } from "./types.js";

// Keep integration tests deterministic: never read a real openclaw.json.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  loadConfig: vi.fn().mockReturnValue({}),
}));

import { loadConfig } from "../config.js";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";

let mockLoadConfig: ReturnType<typeof vi.fn>;

const DAY_MS = 24 * 60 * 60 * 1000;
const ENFORCED_MAINTENANCE_OVERRIDE = {
  mode: "enforce" as const,
  pruneAfterMs: 7 * DAY_MS,
  maxEntries: 500,
  rotateBytes: 10_485_760,
  resetArchiveRetentionMs: 7 * DAY_MS,
  maxDiskBytes: null,
  highWaterBytes: null,
};

const archiveTimestamp = (ms: number) => new Date(ms).toISOString().replaceAll(":", "-");

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-pruning-integ-" });

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function applyEnforcedMaintenanceConfig(mockLoadConfig: ReturnType<typeof vi.fn>) {
  mockLoadConfig.mockReturnValue({
    session: {
      maintenance: {
        mode: "enforce",
        pruneAfter: "7d",
        maxEntries: 500,
        rotateBytes: 10_485_760,
      },
    },
  });
}

function applyCappedMaintenanceConfig(mockLoadConfig: ReturnType<typeof vi.fn>) {
  mockLoadConfig.mockReturnValue({
    session: {
      maintenance: {
        mode: "enforce",
        pruneAfter: "365d",
        maxEntries: 1,
        rotateBytes: 10_485_760,
      },
    },
  });
}

async function createCaseDir(prefix: string): Promise<string> {
  return await suiteRootTracker.make(prefix);
}

function createStaleAndFreshStore(now = Date.now()): Record<string, SessionEntry> {
  return {
    stale: makeEntry(now - 30 * DAY_MS),
    fresh: makeEntry(now),
  };
}

describe("Integration: saveSessionStore with pruning", () => {
  let testDir: string;
  let storePath: string;
  let savedCacheTtl: string | undefined;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  beforeEach(async () => {
    mockLoadConfig = vi.mocked(loadConfig) as ReturnType<typeof vi.fn>;
    mockLoadConfig.mockReset();
    testDir = await createCaseDir("pruning-integ");
    storePath = path.join(testDir, "sessions.json");
    savedCacheTtl = process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    process.env.OPENCLAW_SESSION_CACHE_TTL_MS = "0";
    clearSessionStoreCacheForTest();
  });

  afterEach(() => {
    mockLoadConfig.mockReset();
    clearSessionStoreCacheForTest();
    if (savedCacheTtl === undefined) {
      delete process.env.OPENCLAW_SESSION_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SESSION_CACHE_TTL_MS = savedCacheTtl;
    }
  });

  it("saveSessionStore prunes stale entries on write", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const store = createStaleAndFreshStore();

    await saveSessionStore(storePath, store, {
      maintenanceOverride: ENFORCED_MAINTENANCE_OVERRIDE,
    });

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded.stale).toBeUndefined();
    expect(loaded.fresh).toBeDefined();
  });

  it("archives transcript files for stale sessions pruned on write", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const staleSessionId = "stale-session";
    const freshSessionId = "fresh-session";
    const store: Record<string, SessionEntry> = {
      stale: { sessionId: staleSessionId, updatedAt: now - 30 * DAY_MS },
      fresh: { sessionId: freshSessionId, updatedAt: now },
    };
    const staleTranscript = path.join(testDir, `${staleSessionId}.jsonl`);
    const freshTranscript = path.join(testDir, `${freshSessionId}.jsonl`);
    await fs.writeFile(staleTranscript, '{"type":"session"}\n', "utf-8");
    await fs.writeFile(freshTranscript, '{"type":"session"}\n', "utf-8");

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.stale).toBeUndefined();
    expect(loaded.fresh).toBeDefined();
    await expect(fs.stat(staleTranscript)).rejects.toThrow();
    await expect(fs.stat(freshTranscript)).resolves.toBeDefined();
    const dirEntries = await fs.readdir(testDir);
    const archived = dirEntries.filter((entry) =>
      entry.startsWith(`${staleSessionId}.jsonl.deleted.`),
    );
    expect(archived).toHaveLength(1);
  });

  it("cleans up archived transcripts older than the prune window", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const staleSessionId = "stale-session";
    const store: Record<string, SessionEntry> = {
      stale: { sessionId: staleSessionId, updatedAt: now - 30 * DAY_MS },
      fresh: { sessionId: "fresh-session", updatedAt: now },
    };

    const staleTranscript = path.join(testDir, `${staleSessionId}.jsonl`);
    await fs.writeFile(staleTranscript, '{"type":"session"}\n', "utf-8");

    const oldArchived = path.join(
      testDir,
      `old-session.jsonl.deleted.${archiveTimestamp(now - 9 * DAY_MS)}`,
    );
    const recentArchived = path.join(
      testDir,
      `recent-session.jsonl.deleted.${archiveTimestamp(now - 2 * DAY_MS)}`,
    );
    const bakArchived = path.join(
      testDir,
      `bak-session.jsonl.bak.${archiveTimestamp(now - 20 * DAY_MS)}`,
    );
    await fs.writeFile(oldArchived, "old", "utf-8");
    await fs.writeFile(recentArchived, "recent", "utf-8");
    await fs.writeFile(bakArchived, "bak", "utf-8");

    await saveSessionStore(storePath, store);

    await expect(fs.stat(oldArchived)).rejects.toThrow();
    await expect(fs.stat(recentArchived)).resolves.toBeDefined();
    await expect(fs.stat(bakArchived)).resolves.toBeDefined();
  });

  it("cleans up reset archives using resetArchiveRetention", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          resetArchiveRetention: "3d",
          maxEntries: 500,
          rotateBytes: 10_485_760,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      fresh: { sessionId: "fresh-session", updatedAt: now },
    };
    const oldReset = path.join(
      testDir,
      `old-reset.jsonl.reset.${archiveTimestamp(now - 10 * DAY_MS)}`,
    );
    const freshReset = path.join(
      testDir,
      `fresh-reset.jsonl.reset.${archiveTimestamp(now - 1 * DAY_MS)}`,
    );
    await fs.writeFile(oldReset, "old", "utf-8");
    await fs.writeFile(freshReset, "fresh", "utf-8");

    await saveSessionStore(storePath, store);

    await expect(fs.stat(oldReset)).rejects.toThrow();
    await expect(fs.stat(freshReset)).resolves.toBeDefined();
  });

  it("saveSessionStore skips enforcement when maintenance mode is warn", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "warn",
          pruneAfter: "7d",
          maxEntries: 1,
          rotateBytes: 10_485_760,
        },
      },
    });

    const store = createStaleAndFreshStore();

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.stale).toBeDefined();
    expect(loaded.fresh).toBeDefined();
    expect(Object.keys(loaded)).toHaveLength(2);
  });

  it("loadSessionStore prunes stale entries from oversized stores by default", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale: makeEntry(now - 31 * DAY_MS),
      recent: makeEntry(now - DAY_MS),
      newest: makeEntry(now),
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, {
      skipCache: true,
      maintenanceConfig: {
        ...ENFORCED_MAINTENANCE_OVERRIDE,
        maxEntries: 2,
        pruneAfterMs: 7 * DAY_MS,
      },
    });

    expect(loaded.stale).toBeUndefined();
    expect(loaded.recent).toBeDefined();
    expect(loaded.newest).toBeDefined();
  });

  it("loadSessionStore caps oversized stores by default", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      oldest: makeEntry(now - 3 * DAY_MS),
      recent: makeEntry(now - DAY_MS),
      newest: makeEntry(now),
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, {
      skipCache: true,
      maintenanceConfig: {
        ...ENFORCED_MAINTENANCE_OVERRIDE,
        maxEntries: 2,
        pruneAfterMs: 365 * DAY_MS,
      },
    });

    expect(Object.keys(loaded)).toHaveLength(2);
    expect(loaded.oldest).toBeUndefined();
    expect(loaded.recent).toBeDefined();
    expect(loaded.newest).toBeDefined();
  });

  it("archives transcript files for entries evicted by maxEntries capping", async () => {
    applyCappedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const oldestSessionId = "oldest-session";
    const newestSessionId = "newest-session";
    const store: Record<string, SessionEntry> = {
      oldest: { sessionId: oldestSessionId, updatedAt: now - DAY_MS },
      newest: { sessionId: newestSessionId, updatedAt: now },
    };
    const oldestTranscript = path.join(testDir, `${oldestSessionId}.jsonl`);
    const newestTranscript = path.join(testDir, `${newestSessionId}.jsonl`);
    await fs.writeFile(oldestTranscript, '{"type":"session"}\n', "utf-8");
    await fs.writeFile(newestTranscript, '{"type":"session"}\n', "utf-8");

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.oldest).toBeUndefined();
    expect(loaded.newest).toBeDefined();
    await expect(fs.stat(oldestTranscript)).rejects.toThrow();
    await expect(fs.stat(newestTranscript)).resolves.toBeDefined();
    const files = await fs.readdir(testDir);
    expect(files.some((name) => name.startsWith(`${oldestSessionId}.jsonl.deleted.`))).toBe(true);
  });

  it("does not archive external transcript paths when capping entries", async () => {
    applyCappedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const externalDir = await createCaseDir("external-cap");
    const externalTranscript = path.join(externalDir, "outside.jsonl");
    await fs.writeFile(externalTranscript, "external", "utf-8");
    const store: Record<string, SessionEntry> = {
      oldest: {
        sessionId: "outside",
        sessionFile: externalTranscript,
        updatedAt: now - DAY_MS,
      },
      newest: { sessionId: "inside", updatedAt: now },
    };
    await fs.writeFile(path.join(testDir, "inside.jsonl"), '{"type":"session"}\n', "utf-8");

    try {
      await saveSessionStore(storePath, store);
      const loaded = loadSessionStore(storePath);
      expect(loaded.oldest).toBeUndefined();
      expect(loaded.newest).toBeDefined();
      await expect(fs.stat(externalTranscript)).resolves.toBeDefined();
    } finally {
      await expect(fs.stat(externalTranscript)).resolves.toBeDefined();
    }
  });

  it("enforces maxDiskBytes with oldest-first session eviction", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 100,
          rotateBytes: 10_485_760,
          maxDiskBytes: 900,
          highWaterBytes: 700,
        },
      },
    });

    const now = Date.now();
    const oldSessionId = "old-disk-session";
    const newSessionId = "new-disk-session";
    const store: Record<string, SessionEntry> = {
      old: { sessionId: oldSessionId, updatedAt: now - DAY_MS },
      recent: { sessionId: newSessionId, updatedAt: now },
    };
    await fs.writeFile(path.join(testDir, `${oldSessionId}.jsonl`), "x".repeat(500), "utf-8");
    await fs.writeFile(path.join(testDir, `${newSessionId}.jsonl`), "y".repeat(500), "utf-8");

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(Object.keys(loaded).length).toBe(1);
    expect(loaded.recent).toBeDefined();
    await expect(fs.stat(path.join(testDir, `${oldSessionId}.jsonl`))).rejects.toThrow();
    await expect(fs.stat(path.join(testDir, `${newSessionId}.jsonl`))).resolves.toBeDefined();
  });

  it("uses projected sessions.json size to avoid over-eviction", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 100,
          rotateBytes: 10_485_760,
          maxDiskBytes: 900,
          highWaterBytes: 700,
        },
      },
    });

    // Simulate a stale oversized on-disk sessions.json from a previous write.
    await fs.writeFile(storePath, JSON.stringify({ noisy: "x".repeat(10_000) }), "utf-8");

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      older: { sessionId: "older", updatedAt: now - DAY_MS },
      newer: { sessionId: "newer", updatedAt: now },
    };
    await fs.writeFile(path.join(testDir, "older.jsonl"), "x".repeat(80), "utf-8");
    await fs.writeFile(path.join(testDir, "newer.jsonl"), "y".repeat(80), "utf-8");

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded.older).toBeDefined();
    expect(loaded.newer).toBeDefined();
  });

  it("never deletes transcripts outside the agent sessions directory during budget cleanup", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 100,
          rotateBytes: 10_485_760,
          maxDiskBytes: 500,
          highWaterBytes: 300,
        },
      },
    });

    const now = Date.now();
    const externalDir = await createCaseDir("external-session");
    const externalTranscript = path.join(externalDir, "outside.jsonl");
    await fs.writeFile(externalTranscript, "z".repeat(400), "utf-8");

    const store: Record<string, SessionEntry> = {
      older: {
        sessionId: "outside",
        sessionFile: externalTranscript,
        updatedAt: now - DAY_MS,
      },
      newer: {
        sessionId: "inside",
        updatedAt: now,
      },
    };
    await fs.writeFile(path.join(testDir, "inside.jsonl"), "i".repeat(400), "utf-8");

    try {
      await saveSessionStore(storePath, store);
      await expect(fs.stat(externalTranscript)).resolves.toBeDefined();
    } finally {
      await expect(fs.stat(externalTranscript)).resolves.toBeDefined();
    }
  });
});
