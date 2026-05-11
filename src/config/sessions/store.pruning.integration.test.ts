import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import type { SessionEntry } from "./types.js";

// Keep integration tests deterministic: never read a real openclaw.json.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

import { getRuntimeConfig } from "../config.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  runQuotaSuspensionMaintenance,
  saveSessionStore,
  updateSessionStore,
} from "./store.js";

let mockLoadConfig: ReturnType<typeof vi.fn>;

const DAY_MS = 24 * 60 * 60 * 1000;
const ENFORCED_MAINTENANCE_OVERRIDE = {
  mode: "enforce" as const,
  pruneAfterMs: 7 * DAY_MS,
  maxEntries: 500,
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
      },
    },
  });
}

async function createCaseDir(prefix: string): Promise<string> {
  return await suiteRootTracker.make(prefix);
}

async function expectPathExists(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).resolves.toBeUndefined();
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path: ${targetPath}`);
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
    mockLoadConfig = vi.mocked(getRuntimeConfig) as ReturnType<typeof vi.fn>;
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
    expect(loaded).toHaveProperty("fresh");
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
    expect(loaded).toHaveProperty("fresh");
    await expectPathMissing(staleTranscript);
    await expectPathExists(freshTranscript);
    const dirEntries = await fs.readdir(testDir);
    const archived = dirEntries.filter((entry) =>
      entry.startsWith(`${staleSessionId}.jsonl.deleted.`),
    );
    expect(archived).toHaveLength(1);
  });

  it("removes trajectory sidecars for stale sessions pruned on write", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const staleSessionId = "stale-trajectory-session";
    const freshSessionId = "fresh-trajectory-session";
    const store: Record<string, SessionEntry> = {
      stale: { sessionId: staleSessionId, updatedAt: now - 30 * DAY_MS },
      fresh: { sessionId: freshSessionId, updatedAt: now },
    };
    const staleTranscript = path.join(testDir, `${staleSessionId}.jsonl`);
    const freshTranscript = path.join(testDir, `${freshSessionId}.jsonl`);
    const staleRuntime = resolveTrajectoryFilePath({
      env: {},
      sessionFile: staleTranscript,
      sessionId: staleSessionId,
    });
    const freshRuntime = resolveTrajectoryFilePath({
      env: {},
      sessionFile: freshTranscript,
      sessionId: freshSessionId,
    });
    const stalePointer = resolveTrajectoryPointerFilePath(staleTranscript);
    const freshPointer = resolveTrajectoryPointerFilePath(freshTranscript);
    await fs.writeFile(staleTranscript, '{"type":"session"}\n', "utf-8");
    await fs.writeFile(freshTranscript, '{"type":"session"}\n', "utf-8");
    await fs.writeFile(staleRuntime, '{"traceSchema":"openclaw-trajectory"}\n', "utf-8");
    await fs.writeFile(freshRuntime, '{"traceSchema":"openclaw-trajectory"}\n', "utf-8");
    await fs.writeFile(
      stalePointer,
      JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: staleSessionId,
        runtimeFile: staleRuntime,
      }),
      "utf-8",
    );
    await fs.writeFile(
      freshPointer,
      JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: freshSessionId,
        runtimeFile: freshRuntime,
      }),
      "utf-8",
    );

    await saveSessionStore(storePath, store);

    await expectPathMissing(staleRuntime);
    await expectPathMissing(stalePointer);
    await expectPathExists(freshRuntime);
    await expectPathExists(freshPointer);
  });

  it("sessions cleanup prunes old unreferenced session artifacts without touching referenced files", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const oldDate = new Date(now - 10 * DAY_MS);
    const freshDate = new Date(now);
    const referencedCheckpointPath = path.join(
      testDir,
      "fresh-session.checkpoint.22222222-2222-4222-8222-222222222222.jsonl",
    );
    const store: Record<string, SessionEntry> = {
      fresh: {
        sessionId: "fresh-session",
        updatedAt: now,
        compactionCheckpoints: [
          {
            checkpointId: "referenced",
            sessionKey: "fresh",
            sessionId: "fresh-session",
            createdAt: now,
            reason: "manual",
            preCompaction: {
              sessionId: "fresh-session",
              sessionFile: referencedCheckpointPath,
              leafId: "leaf",
            },
            postCompaction: { sessionId: "fresh-session" },
          },
        ],
      },
    };
    const referencedTranscript = path.join(testDir, "fresh-session.jsonl");
    const oldOrphanTranscript = path.join(testDir, "orphan-session.jsonl");
    const freshOrphanTranscript = path.join(testDir, "fresh-orphan.jsonl");
    const orphanRuntime = path.join(testDir, "orphan-session.trajectory.jsonl");
    const orphanPointer = path.join(testDir, "orphan-session.trajectory-path.json");
    const orphanCheckpoint = path.join(
      testDir,
      "orphan-session.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
    );
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    await fs.writeFile(referencedTranscript, "referenced", "utf-8");
    await fs.writeFile(referencedCheckpointPath, "referenced checkpoint", "utf-8");
    await fs.writeFile(oldOrphanTranscript, "orphan transcript", "utf-8");
    await fs.writeFile(freshOrphanTranscript, "fresh orphan", "utf-8");
    await fs.writeFile(orphanRuntime, "orphan runtime", "utf-8");
    await fs.writeFile(orphanPointer, "orphan pointer", "utf-8");
    await fs.writeFile(orphanCheckpoint, "orphan checkpoint", "utf-8");
    for (const file of [
      referencedTranscript,
      referencedCheckpointPath,
      oldOrphanTranscript,
      orphanRuntime,
      orphanPointer,
      orphanCheckpoint,
    ]) {
      await fs.utimes(file, oldDate, oldDate);
    }
    await fs.utimes(freshOrphanTranscript, freshDate, freshDate);

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });
    expect(dryRun.previewResults[0]?.summary.unreferencedArtifacts.removedFiles).toBe(4);
    await expectPathExists(oldOrphanTranscript);
    await expectPathExists(orphanRuntime);
    await expectPathExists(orphanPointer);
    await expectPathExists(orphanCheckpoint);

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.unreferencedArtifacts.removedFiles).toBe(4);
    await expectPathMissing(oldOrphanTranscript);
    await expectPathMissing(orphanRuntime);
    await expectPathMissing(orphanPointer);
    await expectPathMissing(orphanCheckpoint);
    await expectPathExists(referencedTranscript);
    await expectPathExists(referencedCheckpointPath);
    await expectPathExists(freshOrphanTranscript);
  });

  it("sessions cleanup previews stale direct DM rows after dmScope returns to main", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const directTranscript = path.join(testDir, "direct-session.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: now,
          },
          "agent:main:telegram:direct:6101296751": {
            sessionId: "direct-session",
            updatedAt: now,
            lastChannel: "telegram",
            lastTo: "6101296751",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(path.join(testDir, "main-session.jsonl"), "main", "utf-8");
    await fs.writeFile(directTranscript, "direct", "utf-8");

    const dryRun = await runSessionsCleanup({
      cfg: { session: { dmScope: "main" } },
      opts: { store: storePath, dryRun: true, enforce: true, fixDmScope: true },
      targets: [{ agentId: "main", storePath }],
    });

    const preview = dryRun.previewResults[0];
    expect(preview?.summary.dmScopeRetired).toBe(1);
    expect(preview?.summary.afterCount).toBe(1);
    expect(preview?.dmScopeRetiredKeys.has("agent:main:telegram:direct:6101296751")).toBe(true);
    expect(preview?.summary.unreferencedArtifacts.removedFiles).toBe(0);
    await expectPathExists(directTranscript);
  });

  it("sessions cleanup retires stale direct DM rows and archives their transcripts", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const directTranscript = path.join(testDir, "direct-session.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: now,
          },
          "agent:main:telegram:direct:6101296751": {
            sessionId: "direct-session",
            updatedAt: now,
            sessionFile: directTranscript,
            lastChannel: "telegram",
            lastTo: "6101296751",
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(path.join(testDir, "main-session.jsonl"), "main", "utf-8");
    await fs.writeFile(directTranscript, "direct", "utf-8");

    const applied = await runSessionsCleanup({
      cfg: { session: { dmScope: "main" } },
      opts: { store: storePath, enforce: true, fixDmScope: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.dmScopeRetired).toBe(1);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted).toHaveProperty("agent:main:main");
    expect(persisted["agent:main:telegram:direct:6101296751"]).toBeUndefined();
    await expectPathMissing(directTranscript);
    const files = await fs.readdir(testDir);
    const archivedDirectTranscripts = files.filter((name) =>
      name.startsWith("direct-session.jsonl.deleted."),
    );
    expect(archivedDirectTranscripts.length).toBeGreaterThan(0);
  });

  it("sessions cleanup dry-run does not double-count artifacts already covered by disk budget", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "7d",
          maxEntries: 500,
          maxDiskBytes: 1000,
          highWaterBytes: 900,
        },
      },
    });

    const store: Record<string, SessionEntry> = {
      fresh: { sessionId: "fresh-session", updatedAt: Date.now() },
    };
    const oldOrphanTranscript = path.join(testDir, "orphan-session.jsonl");
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    await fs.writeFile(oldOrphanTranscript, "x".repeat(2000), "utf-8");
    const oldDate = new Date(Date.now() - 10 * DAY_MS);
    await fs.utimes(oldOrphanTranscript, oldDate, oldDate);

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    const diskBudgetSummary = dryRun.previewResults[0]?.summary.diskBudget;
    if (diskBudgetSummary === null || diskBudgetSummary === undefined) {
      throw new Error("expected disk budget cleanup summary");
    }
    expect(diskBudgetSummary.removedFiles).toBe(1);
    expect(dryRun.previewResults[0]?.summary.unreferencedArtifacts.removedFiles).toBe(0);
    await expectPathExists(oldOrphanTranscript);
  });

  it("sessions cleanup dry-run excludes stale and capped entry transcripts from orphan counts", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "7d",
          maxEntries: 1,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale: { sessionId: "stale-session", updatedAt: now - 30 * DAY_MS },
      capped: { sessionId: "capped-session", updatedAt: now - DAY_MS },
      fresh: { sessionId: "fresh-session", updatedAt: now },
    };
    const staleTranscript = path.join(testDir, "stale-session.jsonl");
    const cappedTranscript = path.join(testDir, "capped-session.jsonl");
    const freshTranscript = path.join(testDir, "fresh-session.jsonl");
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
    await fs.writeFile(staleTranscript, "stale", "utf-8");
    await fs.writeFile(cappedTranscript, "capped", "utf-8");
    await fs.writeFile(freshTranscript, "fresh", "utf-8");
    const oldDate = new Date(now - 10 * DAY_MS);
    await fs.utimes(staleTranscript, oldDate, oldDate);
    await fs.utimes(cappedTranscript, oldDate, oldDate);

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(dryRun.previewResults[0]?.summary.pruned).toBe(1);
    expect(dryRun.previewResults[0]?.summary.capped).toBe(1);
    expect(dryRun.previewResults[0]?.summary.unreferencedArtifacts.removedFiles).toBe(0);
    await expectPathExists(staleTranscript);
    await expectPathExists(cappedTranscript);
    await expectPathExists(freshTranscript);
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

    await expectPathMissing(oldArchived);
    await expectPathExists(recentArchived);
    await expectPathExists(bakArchived);
  });

  it("cleans up reset archives using resetArchiveRetention", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          resetArchiveRetention: "3d",
          maxEntries: 500,
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

    await expectPathMissing(oldReset);
    await expectPathExists(freshReset);
  });

  it("saveSessionStore skips enforcement when maintenance mode is warn", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "warn",
          pruneAfter: "7d",
          maxEntries: 1,
        },
      },
    });

    const store = createStaleAndFreshStore();

    await saveSessionStore(storePath, store);

    const loaded = loadSessionStore(storePath);
    expect(loaded).toHaveProperty("stale");
    expect(loaded).toHaveProperty("fresh");
    expect(Object.keys(loaded)).toHaveLength(2);
  });

  it("loadSessionStore leaves oversized stores untouched during normal reads", async () => {
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

    expect(Object.keys(loaded)).toHaveLength(3);
    expect(loaded).toHaveProperty("stale");
    expect(loaded).toHaveProperty("recent");
    expect(loaded).toHaveProperty("newest");
  });

  it("loadSessionStore applies maintenance only when explicitly requested", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      stale: makeEntry(now - 31 * DAY_MS),
      recent: makeEntry(now - DAY_MS),
      newest: makeEntry(now),
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, {
      skipCache: true,
      runMaintenance: true,
      maintenanceConfig: {
        ...ENFORCED_MAINTENANCE_OVERRIDE,
        maxEntries: 1,
        pruneAfterMs: 7 * DAY_MS,
      },
    });

    expect(loaded.stale).toBeUndefined();
    expect(loaded.recent).toBeUndefined();
    expect(loaded).toHaveProperty("newest");
  });

  it("loadSessionStore does not cap oversized stores during normal reads", async () => {
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

    expect(Object.keys(loaded)).toHaveLength(3);
    expect(loaded).toHaveProperty("oldest");
    expect(loaded).toHaveProperty("recent");
    expect(loaded).toHaveProperty("newest");
  });

  it("explicit loadSessionStore maintenance batches entry-count cleanup until the high-water mark", async () => {
    const now = Date.now();
    const store = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`session-${index}`, makeEntry(now - index)]),
    );
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, {
      skipCache: true,
      runMaintenance: true,
      maintenanceConfig: {
        ...ENFORCED_MAINTENANCE_OVERRIDE,
        maxEntries: 50,
        pruneAfterMs: 365 * DAY_MS,
      },
    });

    expect(Object.keys(loaded)).toHaveLength(51);
  });

  it("explicit loadSessionStore maintenance caps production-sized stores once they reach the high-water mark", async () => {
    const now = Date.now();
    const store = Object.fromEntries(
      Array.from({ length: 75 }, (_, index) => [`session-${index}`, makeEntry(now - index)]),
    );
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, {
      skipCache: true,
      runMaintenance: true,
      maintenanceConfig: {
        ...ENFORCED_MAINTENANCE_OVERRIDE,
        maxEntries: 50,
        pruneAfterMs: 365 * DAY_MS,
      },
    });

    expect(Object.keys(loaded)).toHaveLength(50);
    expect(loaded).toHaveProperty("session-0");
    expect(loaded["session-74"]).toBeUndefined();
  });

  it("explicit loadSessionStore maintenance preserves channel, thread, and topic session pointers", async () => {
    const now = Date.now();
    const channelKey = "agent:main:slack:channel:C123";
    const threadKey = "agent:main:discord:channel:123456:thread:987654";
    const topicKey = "agent:main:telegram:group:-100123:topic:77";
    const store = Object.fromEntries(
      Array.from({ length: 75 }, (_, index) => [`session-${index}`, makeEntry(now - index)]),
    );
    store[channelKey] = makeEntry(now - 99 * DAY_MS);
    store[threadKey] = makeEntry(now - 100 * DAY_MS);
    store[topicKey] = makeEntry(now - 101 * DAY_MS);
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, {
      skipCache: true,
      runMaintenance: true,
      maintenanceConfig: {
        ...ENFORCED_MAINTENANCE_OVERRIDE,
        maxEntries: 50,
        pruneAfterMs: 365 * DAY_MS,
      },
    });

    expect(Object.keys(loaded)).toHaveLength(50);
    expect(loaded).toHaveProperty(channelKey);
    expect(loaded).toHaveProperty(threadKey);
    expect(loaded).toHaveProperty(topicKey);
    expect(loaded["session-74"]).toBeUndefined();
  });

  it("persists quota suspension TTL transitions through writer maintenance", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      suspended: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 30_000,
          expectedResumeBy: now - 1,
          state: "suspended",
          reason: "quota_exhausted",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
      active: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 61_000,
          expectedResumeBy: now - 31_000,
          state: "active",
          reason: "circuit_open",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
          laneId: "main",
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const result = await runQuotaSuspensionMaintenance({
      storePath,
      now,
      ttlMs: 30_000,
      log: false,
    });

    expect(result).toEqual({ resumed: [{ sessionKey: "suspended", laneId: "main" }], cleared: 1 });
    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded.suspended?.quotaSuspension?.state).toBe("resuming");
    expect(loaded.active?.quotaSuspension).toBeUndefined();
    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted.suspended?.quotaSuspension?.state).toBe("resuming");
    expect(persisted.active?.quotaSuspension).toBeUndefined();
  });

  it("updateSessionStore batches cap-hit maintenance instead of pruning every new session", async () => {
    const now = Date.now();
    const store = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`session-${index}`, makeEntry(now - index)]),
    );
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 50,
        },
      },
    });

    await updateSessionStore(storePath, (next) => {
      next["session-50"] = makeEntry(now + 1);
    });

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(loaded)).toHaveLength(51);
    expect(loaded).toHaveProperty("session-50");
  });

  it("loadSessionStore honors configured maxEntries without an explicit override", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 1000,
        },
      },
    });

    const now = Date.now();
    const store = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`session-${index}`, makeEntry(now - index)]),
    );
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, { skipCache: true });

    expect(Object.keys(loaded)).toHaveLength(501);
  });

  it("loadSessionStore honors configured warn mode without an explicit override", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "warn",
          pruneAfter: "365d",
          maxEntries: 1,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      oldest: makeEntry(now - DAY_MS),
      newest: makeEntry(now),
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const loaded = loadSessionStore(storePath, { skipCache: true });

    expect(Object.keys(loaded)).toHaveLength(2);
    expect(loaded).toHaveProperty("oldest");
    expect(loaded).toHaveProperty("newest");
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
    expect(loaded).toHaveProperty("newest");
    await expectPathMissing(oldestTranscript);
    await expectPathExists(newestTranscript);
    const files = await fs.readdir(testDir);
    const archivedOldestTranscripts = files.filter((name) =>
      name.startsWith(`${oldestSessionId}.jsonl.deleted.`),
    );
    expect(archivedOldestTranscripts.length).toBeGreaterThan(0);
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
      expect(loaded).toHaveProperty("newest");
      await expectPathExists(externalTranscript);
    } finally {
      await expectPathExists(externalTranscript);
    }
  });

  it("enforces maxDiskBytes with oldest-first session eviction", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 100,
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
    expect(loaded).toHaveProperty("recent");
    await expectPathMissing(path.join(testDir, `${oldSessionId}.jsonl`));
    await expectPathExists(path.join(testDir, `${newSessionId}.jsonl`));
  });

  it("uses projected sessions.json size to avoid over-eviction", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 100,
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
    expect(loaded).toHaveProperty("older");
    expect(loaded).toHaveProperty("newer");
  });

  it("does not create rotation backups for hot oversized store writes", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 100,
          rotateBytes: 200,
        },
      },
    });

    let now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    try {
      const store: Record<string, SessionEntry> = {
        hot: {
          sessionId: "hot-session",
          updatedAt: Date.now(),
          pluginExtensions: { test: { payload: "x".repeat(1000) } },
        },
      };

      for (let i = 0; i < 5; i++) {
        store.hot.updatedAt = Date.now();
        store.hot.pluginExtensions = { test: { payload: "x".repeat(1000), write: i } };
        await saveSessionStore(storePath, store);
      }
    } finally {
      nowSpy.mockRestore();
    }

    const files = await fs.readdir(testDir);
    const backups = files.filter((file) => file.startsWith("sessions.json.bak."));
    expect(backups).toHaveLength(0);
  });

  it("does not create rotation backups for destructive maintenance rewrites", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 1,
          rotateBytes: 200,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      old: {
        sessionId: "old-session",
        updatedAt: now - DAY_MS,
        pluginExtensions: { test: { payload: "x".repeat(1000) } },
      },
      fresh: {
        sessionId: "fresh-session",
        updatedAt: now,
        pluginExtensions: { test: { payload: "y".repeat(1000) } },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

    await saveSessionStore(
      storePath,
      JSON.parse(JSON.stringify(store)) as Record<string, SessionEntry>,
    );

    const files = await fs.readdir(testDir);
    const backups = files.filter((file) => file.startsWith("sessions.json.bak."));
    expect(backups).toHaveLength(0);
    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded.old).toBeUndefined();
    expect(loaded).toHaveProperty("fresh");
  });

  it("never deletes transcripts outside the agent sessions directory during budget cleanup", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 100,
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
      await expectPathExists(externalTranscript);
    } finally {
      await expectPathExists(externalTranscript);
    }
  });
});
