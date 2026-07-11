// Session store pruning integration tests cover filesystem-backed pruning.
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
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
  updateSessionStore,
} from "./store.js";

let mockLoadConfig: ReturnType<typeof vi.fn>;

const DAY_MS = 24 * 60 * 60 * 1000;
const ENFORCED_MAINTENANCE_OVERRIDE = {
  mode: "enforce" as const,
  pruneAfterMs: 7 * DAY_MS,
  maxEntries: 500,
  modelRunPruneAfterMs: DAY_MS,
  resetArchiveRetentionMs: 7 * DAY_MS,
  maxDiskBytes: null,
  highWaterBytes: null,
};

function jsonRoundTrip<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

const archiveTimestamp = (ms: number) => new Date(ms).toISOString().replaceAll(":", "-");

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-pruning-integ-" });

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function applyEnforcedMaintenanceConfig(mockLoadConfigValue: ReturnType<typeof vi.fn>) {
  mockLoadConfigValue.mockReturnValue({
    session: {
      maintenance: {
        mode: "enforce",
        pruneAfter: "7d",
        maxEntries: 500,
      },
    },
  });
}

function applyCappedMaintenanceConfig(mockLoadConfigLocal: ReturnType<typeof vi.fn>) {
  mockLoadConfigLocal.mockReturnValue({
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

  it("saveSessionStore prunes stale model-run probes before capping real sessions", async () => {
    const now = Date.now();
    const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const recentModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174001";
    const normalRecent = "agent:main:explicit:normal-recent";
    const store: Record<string, SessionEntry> = {
      [staleModelRun]: makeEntry(now - 2 * DAY_MS),
      [recentModelRun]: makeEntry(now),
      [normalRecent]: makeEntry(now - 2 * DAY_MS),
    };

    await saveSessionStore(storePath, store, {
      maintenanceOverride: {
        ...ENFORCED_MAINTENANCE_OVERRIDE,
        pruneAfterMs: 30 * DAY_MS,
        maxEntries: 2,
      },
    });

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded[staleModelRun]).toBeUndefined();
    expect(loaded).toHaveProperty(recentModelRun);
    expect(loaded).toHaveProperty(normalRecent);
  });

  it("sessions cleanup dry-run and apply report stale model-run probe pruning", async () => {
    const now = Date.now();
    const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174010";
    const recentModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174011";
    const store: Record<string, SessionEntry> = {
      [staleModelRun]: makeEntry(now - 2 * DAY_MS),
      [recentModelRun]: makeEntry(now),
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");

    const cfg = { session: { store: storePath } };
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 500,
        },
      },
    });
    const defaultDryRun = await runSessionsCleanup({
      cfg,
      opts: { dryRun: true, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(defaultDryRun.previewResults[0]?.summary.modelRunPruned).toBe(0);
    expect(loadSessionStore(storePath, { skipCache: true })).toHaveProperty(staleModelRun);

    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 1,
        },
      },
    });
    const dryRun = await runSessionsCleanup({
      cfg,
      opts: { dryRun: true, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(dryRun.previewResults[0]?.summary.modelRunPruned).toBe(1);
    expect(loadSessionStore(storePath, { skipCache: true })).toHaveProperty(staleModelRun);

    const applied = await runSessionsCleanup({
      cfg,
      opts: { dryRun: false, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.modelRunPruned).toBe(1);
    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded[staleModelRun]).toBeUndefined();
    expect(loaded).toHaveProperty(recentModelRun);
  });

  it("saveSessionStore pressure-gates unset default model-run pruning", async () => {
    const now = Date.now();
    const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174020";
    const recentModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174021";

    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 500,
        },
      },
    });
    await saveSessionStore(storePath, {
      [staleModelRun]: makeEntry(now - 2 * DAY_MS),
      [recentModelRun]: makeEntry(now),
    });
    expect(loadSessionStore(storePath, { skipCache: true })).toHaveProperty(staleModelRun);

    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "30d",
          maxEntries: 1,
        },
      },
    });
    await saveSessionStore(storePath, loadSessionStore(storePath, { skipCache: true }));

    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded[staleModelRun]).toBeUndefined();
    expect(loaded).toHaveProperty(recentModelRun);
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
    const referencedPostCompactionPath = path.join(testDir, "fresh-session-compacted.jsonl");
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
            postCompaction: {
              sessionId: "fresh-session",
              sessionFile: referencedPostCompactionPath,
            },
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
    await fs.writeFile(referencedPostCompactionPath, "referenced post-compaction", "utf-8");
    await fs.writeFile(oldOrphanTranscript, "orphan transcript", "utf-8");
    await fs.writeFile(freshOrphanTranscript, "fresh orphan", "utf-8");
    await fs.writeFile(orphanRuntime, "orphan runtime", "utf-8");
    await fs.writeFile(orphanPointer, "orphan pointer", "utf-8");
    await fs.writeFile(orphanCheckpoint, "orphan checkpoint", "utf-8");
    for (const file of [
      referencedTranscript,
      referencedCheckpointPath,
      referencedPostCompactionPath,
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
    await expectPathExists(referencedPostCompactionPath);
    await expectPathExists(freshOrphanTranscript);
  });

  it("sessions cleanup fix-missing prunes malformed stored session rows", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const validTranscript = path.join(testDir, "valid-present.jsonl");
    const legacyPresentTranscript = path.join(testDir, "legacy-present.jsonl");
    const emptyPresentTranscript = path.join(testDir, "empty-present.jsonl");
    const headerOnlyPresentTranscript = path.join(testDir, "header-only-present.jsonl");
    const userOnlyPresentTranscript = path.join(testDir, "user-only-present.jsonl");
    const legacyRolePresentTranscript = path.join(testDir, "legacy-role-present.jsonl");
    const legacyNestedRolePresentTranscript = path.join(
      testDir,
      "legacy-nested-role-present.jsonl",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "invalid-no-file": { sessionId: "agent:main:main", updatedAt: now },
          "invalid-bad-file": {
            sessionId: "agent:main:main",
            sessionFile: "../outside.jsonl",
            updatedAt: now,
          },
          "invalid-missing-relative-file": {
            sessionId: "agent:main:main",
            sessionFile: "missing.jsonl",
            updatedAt: now,
          },
          "agent:main:metadata": {
            sessionId: "agent:main:metadata",
            updatedAt: now,
            groupActivation: "always",
          },
          "legacy-present-invalid-id": {
            sessionId: "agent:main:main",
            sessionFile: "legacy-present.jsonl",
            updatedAt: now,
          },
          "valid-present": { sessionId: "valid-present", updatedAt: now },
          "empty-present": { sessionId: "empty-present", updatedAt: now },
          "header-only-present": { sessionId: "header-only-present", updatedAt: now },
          "user-only-present": { sessionId: "user-only-present", updatedAt: now },
          "legacy-role-present": { sessionId: "legacy-role-present", updatedAt: now },
          "legacy-nested-role-present": {
            sessionId: "legacy-nested-role-present",
            updatedAt: now,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(validTranscript, "valid", "utf-8");
    await fs.writeFile(legacyPresentTranscript, "legacy", "utf-8");
    await fs.writeFile(emptyPresentTranscript, "", "utf-8");
    await fs.writeFile(
      headerOnlyPresentTranscript,
      '{"type":"session","id":"header-only-present","cwd":"/tmp"}\n',
      "utf-8",
    );
    await fs.writeFile(
      userOnlyPresentTranscript,
      '{"type":"session","id":"user-only-present"}\n{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );
    await fs.writeFile(
      legacyRolePresentTranscript,
      '{"role":"user","content":"legacy transcript row"}\n',
      "utf-8",
    );
    await fs.writeFile(
      legacyNestedRolePresentTranscript,
      '{"message":{"role":"user","content":"legacy nested transcript row"}}\n',
      "utf-8",
    );

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });
    const preview = dryRun.previewResults[0];
    expect(preview?.summary.missing).toBe(5);
    expect(preview?.summary.beforeCount).toBe(11);
    expect(preview?.summary.afterCount).toBe(6);
    expect(preview?.missingKeys.has("invalid-no-file")).toBe(true);
    expect(preview?.missingKeys.has("invalid-bad-file")).toBe(true);
    expect(preview?.missingKeys.has("invalid-missing-relative-file")).toBe(true);
    expect(preview?.missingKeys.has("empty-present")).toBe(true);
    expect(preview?.missingKeys.has("header-only-present")).toBe(true);
    expect(preview?.missingKeys.has("agent:main:metadata")).toBe(false);
    expect(preview?.missingKeys.has("legacy-present-invalid-id")).toBe(false);
    expect(preview?.missingKeys.has("user-only-present")).toBe(false);
    expect(preview?.missingKeys.has("legacy-role-present")).toBe(false);
    expect(preview?.missingKeys.has("legacy-nested-role-present")).toBe(false);
    const rawAfterDryRun = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(rawAfterDryRun).toHaveProperty("invalid-no-file");

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.missing).toBe(5);
    expect(applied.appliedSummaries[0]?.afterCount).toBe(6);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(persisted)).toEqual([
      "agent:main:metadata",
      "legacy-present-invalid-id",
      "valid-present",
      "user-only-present",
      "legacy-role-present",
      "legacy-nested-role-present",
    ]);
    expect(persisted["agent:main:metadata"]).toMatchObject({ groupActivation: "always" });
    expect(persisted["agent:main:metadata"]?.sessionId).toBeUndefined();
    expect(persisted["legacy-present-invalid-id"]?.sessionId).toBe("agent:main:main");
    await expectPathExists(validTranscript);
    await expectPathExists(legacyPresentTranscript);
    await expectPathExists(legacyRolePresentTranscript);
    await expectPathExists(legacyNestedRolePresentTranscript);
    await expectPathExists(userOnlyPresentTranscript);
  });

  it("sessions cleanup fix-missing preserves locked header-only harness sessions", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const lockedKey = "agent:main:harness-owned:locked";
    const lockedTranscript = path.join(testDir, "locked-header-only.jsonl");
    const removableTranscript = path.join(testDir, "removable-header-only.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [lockedKey]: {
            sessionId: "locked-header-only",
            updatedAt: now,
            agentHarnessId: "fixture-harness",
            modelSelectionLocked: true,
          },
          "removable-header-only": {
            sessionId: "removable-header-only",
            updatedAt: now,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      lockedTranscript,
      '{"type":"session","id":"locked-header-only","cwd":"/tmp"}\n',
      "utf-8",
    );
    await fs.writeFile(
      removableTranscript,
      '{"type":"session","id":"removable-header-only","cwd":"/tmp"}\n',
      "utf-8",
    );

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    const preview = dryRun.previewResults[0];
    expect(preview?.summary.missing).toBe(1);
    expect(preview?.summary.beforeCount).toBe(2);
    expect(preview?.summary.afterCount).toBe(1);
    expect(preview?.missingKeys.has(lockedKey)).toBe(false);
    expect(preview?.missingKeys.has("removable-header-only")).toBe(true);
    expect(loadSessionStore(storePath, { skipCache: true })).toHaveProperty(lockedKey);

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.missing).toBe(1);
    expect(applied.appliedSummaries[0]?.afterCount).toBe(1);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted[lockedKey]).toMatchObject({
      sessionId: "locked-header-only",
      agentHarnessId: "fixture-harness",
      modelSelectionLocked: true,
    });
    expect(persisted["removable-header-only"]).toBeUndefined();
    await expectPathExists(lockedTranscript);
  });

  it("sessions cleanup repairs stale generated sessionFile metadata before pruning", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const staleTranscript = path.join(testDir, "22222222-2222-4222-8222-222222222222.jsonl");
    const canonicalTranscript = path.join(testDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:cron:job:run:fresh": {
            sessionId,
            updatedAt: now,
            sessionFile: staleTranscript,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      canonicalTranscript,
      '{"type":"session","id":"11111111-1111-4111-8111-111111111111","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"still valid"}}\n',
      "utf-8",
    );

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    const preview = dryRun.previewResults[0];
    expect(preview?.summary.repaired).toBe(1);
    expect(preview?.summary.missing).toBe(0);
    expect(preview?.summary.beforeCount).toBe(1);
    expect(preview?.summary.afterCount).toBe(1);
    expect(preview?.summary.wouldMutate).toBe(true);
    expect(preview?.repairedKeys.has("agent:main:cron:job:run:fresh")).toBe(true);
    expect(preview?.missingKeys.size).toBe(0);
    expect(
      loadSessionStore(storePath, { skipCache: true })["agent:main:cron:job:run:fresh"]
        ?.sessionFile,
    ).toBe(staleTranscript);

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.repaired).toBe(1);
    expect(applied.appliedSummaries[0]?.missing).toBe(0);
    expect(applied.appliedSummaries[0]?.afterCount).toBe(1);
    expect(applied.appliedSummaries[0]?.wouldMutate).toBe(true);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted["agent:main:cron:job:run:fresh"]?.sessionFile).toBe(canonicalTranscript);
    await expectPathExists(canonicalTranscript);
  });

  it("sessions cleanup repairs stale generated metadata even when the stale transcript exists", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const oldDate = new Date(now - 10 * DAY_MS);
    const sessionKey = "agent:main:cron:job:run:fresh";
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const staleTranscript = path.join(testDir, "66666666-6666-4666-8666-666666666666.jsonl");
    const canonicalTranscript = path.join(testDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: now,
            sessionFile: staleTranscript,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      staleTranscript,
      '{"type":"session","id":"66666666-6666-4666-8666-666666666666","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"old transcript"}}\n',
      "utf-8",
    );
    await fs.writeFile(
      canonicalTranscript,
      '{"type":"session","id":"55555555-5555-4555-8555-555555555555","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"current transcript"}}\n',
      "utf-8",
    );
    await fs.utimes(staleTranscript, oldDate, oldDate);
    await fs.utimes(canonicalTranscript, oldDate, oldDate);

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.repaired).toBe(1);
    expect(applied.appliedSummaries[0]?.missing).toBe(0);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted[sessionKey]?.sessionFile).toBe(canonicalTranscript);
    await expectPathExists(canonicalTranscript);
  });

  it("sessions cleanup does not clobber concurrent sessionFile updates while repairing", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const sessionKey = "agent:main:cron:job:run:fresh";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const staleTranscript = path.join(testDir, "44444444-4444-4444-8444-444444444444.jsonl");
    const canonicalTranscript = path.join(testDir, `${sessionId}.jsonl`);
    const concurrentTranscript = path.join(testDir, "concurrent-cron-session.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: now,
            sessionFile: staleTranscript,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      canonicalTranscript,
      '{"type":"session","id":"33333333-3333-4333-8333-333333333333","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"still valid"}}\n',
      "utf-8",
    );
    await fs.writeFile(
      concurrentTranscript,
      '{"type":"session","id":"33333333-3333-4333-8333-333333333333","cwd":"/tmp"}\n{"type":"message","message":{"role":"assistant","content":"newer write"}}\n',
      "utf-8",
    );

    const staleEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(staleEntry?.sessionFile).toBe(staleTranscript);
    await updateSessionStore(storePath, (store) => {
      const current = store[sessionKey];
      if (!current) {
        throw new Error("expected session entry");
      }
      store[sessionKey] = {
        ...current,
        sessionFile: concurrentTranscript,
        updatedAt: now + 1,
      };
    });

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.repaired).toBe(0);
    expect(applied.appliedSummaries[0]?.missing).toBe(0);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted[sessionKey]?.sessionFile).toBe(concurrentTranscript);
    expect(persisted[sessionKey]?.updatedAt).toBe(now + 1);
  });

  it("sessions cleanup does not repair missing topic transcripts to the base transcript", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const sessionKey = "agent:main:telegram:thread:topic";
    const sessionId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const missingTopicTranscript = path.join(testDir, `${sessionId}-topic-456.jsonl`);
    const baseTranscript = path.join(testDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            updatedAt: now,
            sessionFile: missingTopicTranscript,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      baseTranscript,
      '{"type":"session","id":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa","cwd":"/tmp"}\n{"type":"message","message":{"role":"user","content":"base conversation"}}\n',
      "utf-8",
    );

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.missing).toBe(1);
    expect(applied.appliedSummaries[0]?.afterCount).toBe(0);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted[sessionKey]).toBeUndefined();
    await expectPathExists(baseTranscript);
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
          "agent:main:telegram::direct:malformed": {
            sessionId: "malformed-session",
            updatedAt: now,
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
    expect(preview?.summary.afterCount).toBe(2);
    expect(preview?.dmScopeRetiredKeys.has("agent:main:telegram:direct:6101296751")).toBe(true);
    expect(preview?.dmScopeRetiredKeys.has("agent:main:telegram::direct:malformed")).toBe(false);
    expect(preview?.summary.unreferencedArtifacts.removedFiles).toBe(0);
    await expectPathExists(directTranscript);
  });

  it("sessions cleanup retires stale direct DM rows and archives their transcripts", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const directTranscript = path.join(testDir, "direct-session.jsonl");
    const nestedTranscript = path.join(testDir, "nested-agent-session.jsonl");
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
          "agent:main:agent:direct:customer": {
            sessionId: "nested-agent-session",
            updatedAt: now,
            sessionFile: nestedTranscript,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(path.join(testDir, "main-session.jsonl"), "main", "utf-8");
    await fs.writeFile(directTranscript, "direct", "utf-8");
    await fs.writeFile(nestedTranscript, "nested", "utf-8");

    const applied = await runSessionsCleanup({
      cfg: { session: { dmScope: "main" } },
      opts: { store: storePath, enforce: true, fixDmScope: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.dmScopeRetired).toBe(1);
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted).toHaveProperty("agent:main:main");
    expect(persisted).toHaveProperty("agent:main:agent:direct:customer");
    expect(persisted["agent:main:telegram:direct:6101296751"]).toBeUndefined();
    await expectPathMissing(directTranscript);
    await expectPathExists(nestedTranscript);
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
      `fresh-reset.jsonl.reset.${archiveTimestamp(now - DAY_MS)}`,
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

  it("explicit loadSessionStore maintenance preserves runtime-provided subagent sessions", async () => {
    const now = Date.now();
    const childKey = "agent:main:subagent:pending-delivery";
    const store = Object.fromEntries(
      Array.from({ length: 75 }, (_, index) => [`session-${index}`, makeEntry(now - index)]),
    );
    store[childKey] = {
      ...makeEntry(now - 100 * DAY_MS),
      spawnedBy: "agent:main:slack:direct:U1",
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
    const unregister = registerSessionMaintenancePreserveKeysProvider(() => [childKey]);

    try {
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
      expect(loaded).toHaveProperty(childKey);
      expect(loaded["session-74"]).toBeUndefined();
    } finally {
      unregister();
    }
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

    await saveSessionStore(storePath, jsonRoundTrip(store));

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
