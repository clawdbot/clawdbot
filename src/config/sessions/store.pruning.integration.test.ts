// Session store pruning integration tests cover filesystem-backed pruning.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
} from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import type { SessionEntry } from "./types.js";

// Keep integration tests deterministic: never read a real openclaw.json.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

import { getRuntimeConfig } from "../config.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import {
  appendTranscriptMessage,
  listSessionEntries,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntry,
  replaceSessionEntry,
} from "./session-accessor.js";
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

async function seedSqliteSessionStore(
  targetStorePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(store)) {
    await patchSessionEntry({ storePath: targetStorePath, sessionKey }, () => entry, {
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
    });
  }
}

function loadSqliteSessionStore(targetStorePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ storePath: targetStorePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

async function seedSqliteTranscriptMessage(params: {
  content: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await appendTranscriptMessage(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      cwd: path.dirname(params.storePath),
      message: { role: "user", content: params.content },
    },
  );
}

async function seedSqliteTrajectoryEvent(params: {
  content: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const event: TrajectoryEvent = {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: params.sessionId,
    source: "runtime",
    type: "budget.test",
    ts: "2026-07-03T00:00:00.000Z",
    seq: 1,
    sourceSeq: 1,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: "budget-test",
    data: { content: params.content },
  };
  appendSqliteTrajectoryRuntimeEvents(
    { sessionId: params.sessionId, storePath: params.storePath },
    [event],
  );
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
    closeOpenClawAgentDatabasesForTest();
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
    await seedSqliteSessionStore(storePath, store);

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
    expect(loadSessionEntry({ storePath, sessionKey: staleModelRun })).toBeDefined();

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
    expect(loadSessionEntry({ storePath, sessionKey: staleModelRun })).toBeDefined();

    const applied = await runSessionsCleanup({
      cfg,
      opts: { dryRun: false, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.modelRunPruned).toBe(1);
    const loaded = loadSqliteSessionStore(storePath);
    expect(loaded[staleModelRun]).toBeUndefined();
    expect(loaded).toHaveProperty(recentModelRun);
  });

  it("sessions cleanup dry-run does not create a missing SQLite store", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);
    const sqlitePath = path.join(testDir, "openclaw-agent.sqlite");

    await expectPathMissing(sqlitePath);

    const dryRun = await runSessionsCleanup({
      cfg: { session: { store: storePath } },
      opts: { dryRun: true, enforce: true, store: storePath },
      targets: [{ agentId: "main", storePath }],
    });

    expect(dryRun.previewResults[0]?.summary.beforeCount).toBe(0);
    expect(dryRun.previewResults[0]?.summary.afterCount).toBe(0);
    await expectPathMissing(sqlitePath);
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
    await seedSqliteSessionStore(storePath, store);
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
    await seedSqliteSessionStore(storePath, {
      "invalid-no-file": { sessionId: "invalid-no-file", updatedAt: now },
      "invalid-bad-file": {
        sessionId: "invalid-bad-file",
        sessionFile: "../outside.jsonl",
        updatedAt: now,
      },
      "invalid-missing-relative-file": {
        sessionId: "invalid-missing-relative-file",
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
    } satisfies Record<string, SessionEntry>);
    await seedSqliteTranscriptMessage({
      content: "valid",
      sessionId: "valid-present",
      sessionKey: "valid-present",
      storePath,
    });
    await seedSqliteTranscriptMessage({
      content: "legacy",
      sessionId: "agent:main:main",
      sessionKey: "legacy-present-invalid-id",
      storePath,
    });
    await seedSqliteTranscriptMessage({
      content: "hello",
      sessionId: "user-only-present",
      sessionKey: "user-only-present",
      storePath,
    });
    await seedSqliteTranscriptMessage({
      content: "legacy transcript row",
      sessionId: "legacy-role-present",
      sessionKey: "legacy-role-present",
      storePath,
    });
    await seedSqliteTranscriptMessage({
      content: "legacy nested transcript row",
      sessionId: "legacy-nested-role-present",
      sessionKey: "legacy-nested-role-present",
      storePath,
    });

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
    expect(loadSessionEntry({ storePath, sessionKey: "invalid-no-file" })).toBeDefined();

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.missing).toBe(5);
    expect(applied.appliedSummaries[0]?.afterCount).toBe(6);
    const persisted = loadSqliteSessionStore(storePath);
    expect(Object.keys(persisted).toSorted()).toEqual(
      [
        "agent:main:metadata",
        "legacy-nested-role-present",
        "legacy-present-invalid-id",
        "legacy-role-present",
        "user-only-present",
        "valid-present",
      ].toSorted(),
    );
    expect(persisted["agent:main:metadata"]).toMatchObject({ groupActivation: "always" });
    expect(persisted["agent:main:metadata"]?.sessionId).toBe("agent:main:metadata");
    expect(persisted["legacy-present-invalid-id"]?.sessionId).toBe("agent:main:main");
    expect(
      loadTranscriptEventsSync({
        sessionId: "valid-present",
        sessionKey: "valid-present",
        storePath,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      loadTranscriptEventsSync({
        sessionId: "agent:main:main",
        sessionKey: "legacy-present-invalid-id",
        storePath,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      loadTranscriptEventsSync({
        sessionId: "legacy-role-present",
        sessionKey: "legacy-role-present",
        storePath,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      loadTranscriptEventsSync({
        sessionId: "legacy-nested-role-present",
        sessionKey: "legacy-nested-role-present",
        storePath,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      loadTranscriptEventsSync({
        sessionId: "user-only-present",
        sessionKey: "user-only-present",
        storePath,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("sessions cleanup fix-missing preserves locked harness sessions", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);
    const lockedKey = "agent:main:harness-owned:locked";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: lockedKey, storePath },
      {
        sessionId: "locked-header-only",
        updatedAt: Date.now(),
        agentHarnessId: "fixture-harness",
        modelSelectionLocked: true,
      },
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "removable-header-only", storePath },
      { sessionId: "removable-header-only", updatedAt: Date.now() },
    );

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.missing).toBe(1);
    expect(loadSessionEntry({ agentId: "main", sessionKey: lockedKey, storePath })).toMatchObject({
      agentHarnessId: "fixture-harness",
      modelSelectionLocked: true,
      sessionId: "locked-header-only",
    });
    expect(
      loadSessionEntry({
        agentId: "main",
        sessionKey: "removable-header-only",
        storePath,
      }),
    ).toBeUndefined();
  });

  it("sessions cleanup previews stale direct DM rows after dmScope returns to main", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    await seedSqliteSessionStore(storePath, {
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
    } satisfies Record<string, SessionEntry>);
    await fs.writeFile(path.join(testDir, "main-session.jsonl"), "main", "utf-8");
    await seedSqliteTranscriptMessage({
      content: "direct",
      sessionId: "direct-session",
      sessionKey: "agent:main:telegram:direct:6101296751",
      storePath,
    });

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
    expect(
      loadTranscriptEventsSync({
        sessionId: "direct-session",
        sessionKey: "agent:main:telegram:direct:6101296751",
        storePath,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("sessions cleanup retires stale direct DM rows and archives their transcripts", async () => {
    applyEnforcedMaintenanceConfig(mockLoadConfig);

    const now = Date.now();
    const directTranscript = path.join(testDir, "direct-session.jsonl");
    const nestedTranscript = path.join(testDir, "nested-agent-session.jsonl");
    await seedSqliteSessionStore(storePath, {
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
    } satisfies Record<string, SessionEntry>);
    await fs.writeFile(path.join(testDir, "main-session.jsonl"), "main", "utf-8");
    await seedSqliteTranscriptMessage({
      content: "direct",
      sessionId: "direct-session",
      sessionKey: "agent:main:telegram:direct:6101296751",
      storePath,
    });
    await fs.writeFile(nestedTranscript, "nested", "utf-8");

    const applied = await runSessionsCleanup({
      cfg: { session: { dmScope: "main" } },
      opts: { store: storePath, enforce: true, fixDmScope: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(applied.appliedSummaries[0]?.dmScopeRetired).toBe(1);
    const persisted = loadSqliteSessionStore(storePath);
    expect(persisted).toHaveProperty("agent:main:main");
    expect(persisted).toHaveProperty("agent:main:agent:direct:customer");
    expect(persisted["agent:main:telegram:direct:6101296751"]).toBeUndefined();
    expect(
      loadTranscriptEventsSync({
        sessionId: "direct-session",
        sessionKey: "agent:main:telegram:direct:6101296751",
        storePath,
      }),
    ).toEqual([]);
    await expectPathMissing(directTranscript);
    await expectPathExists(nestedTranscript);
    const files = await fs.readdir(testDir);
    const archivedDirectTranscripts = files.filter((name) =>
      name.startsWith("direct-session.jsonl.deleted."),
    );
    expect(archivedDirectTranscripts.length).toBeGreaterThan(0);
  });

  it("sessions cleanup dry-run reports unreferenced artifacts outside SQLite row budget", async () => {
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
    await seedSqliteSessionStore(storePath, store);
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
    expect(diskBudgetSummary.removedFiles).toBe(0);
    expect(dryRun.previewResults[0]?.summary.unreferencedArtifacts.removedFiles).toBe(1);
    await expectPathExists(oldOrphanTranscript);
  });

  it("sessions cleanup dry-run reports SQLite transcript row bytes for disk budget", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 500,
          maxDiskBytes: 1_600,
          highWaterBytes: 900,
        },
      },
    });

    const now = Date.now();
    const oldKey = "agent:main:explicit:old-budget";
    const freshKey = "agent:main:explicit:fresh-budget";
    await seedSqliteSessionStore(storePath, {
      [oldKey]: { sessionId: "old-budget-session", updatedAt: now - DAY_MS },
      [freshKey]: { sessionId: "fresh-budget-session", updatedAt: now },
    });
    await seedSqliteTranscriptMessage({
      content: "old-" + "x".repeat(1_200),
      sessionId: "old-budget-session",
      sessionKey: oldKey,
      storePath,
    });
    await seedSqliteTranscriptMessage({
      content: "fresh-" + "y".repeat(1_200),
      sessionId: "fresh-budget-session",
      sessionKey: freshKey,
      storePath,
    });

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true, activeKey: freshKey },
      targets: [{ agentId: "main", storePath }],
    });

    const preview = dryRun.previewResults[0];
    const diskBudgetSummary = preview?.summary.diskBudget;
    if (diskBudgetSummary === null || diskBudgetSummary === undefined) {
      throw new Error("expected SQLite row-byte disk budget summary");
    }
    expect(diskBudgetSummary.totalBytesBefore).toBeGreaterThan(2_400);
    expect(diskBudgetSummary.totalBytesAfter).toBeLessThan(diskBudgetSummary.totalBytesBefore);
    expect(diskBudgetSummary.removedEntries).toBe(1);
    expect(diskBudgetSummary.removedFiles).toBe(0);
    expect(preview?.summary.afterCount).toBe(1);
    expect(preview?.budgetEvictedKeys.has(oldKey)).toBe(true);
    expect(preview?.budgetEvictedKeys.has(freshKey)).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey: oldKey })).toBeDefined();
    expect(
      loadTranscriptEventsSync({
        sessionId: "old-budget-session",
        sessionKey: oldKey,
        storePath,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("sessions cleanup apply reports SQLite disk-budget row eviction", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 500,
          maxDiskBytes: 1_600,
          highWaterBytes: 900,
        },
      },
    });

    const now = Date.now();
    const oldKey = "agent:main:explicit:old-apply-budget";
    const freshKey = "agent:main:explicit:fresh-apply-budget";
    await seedSqliteSessionStore(storePath, {
      [oldKey]: { sessionId: "old-apply-budget-session", updatedAt: now - DAY_MS },
      [freshKey]: { sessionId: "fresh-apply-budget-session", updatedAt: now },
    });
    await seedSqliteTranscriptMessage({
      content: "old-" + "x".repeat(1_200),
      sessionId: "old-apply-budget-session",
      sessionKey: oldKey,
      storePath,
    });
    await seedSqliteTranscriptMessage({
      content: "fresh-" + "y".repeat(1_200),
      sessionId: "fresh-apply-budget-session",
      sessionKey: freshKey,
      storePath,
    });

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, activeKey: freshKey },
      targets: [{ agentId: "main", storePath }],
    });

    const summary = applied.appliedSummaries[0];
    const diskBudgetSummary = summary?.diskBudget;
    if (diskBudgetSummary === null || diskBudgetSummary === undefined) {
      throw new Error("expected applied SQLite row-byte disk budget summary");
    }
    expect(diskBudgetSummary.removedEntries).toBe(1);
    expect(diskBudgetSummary.removedFiles).toBe(0);
    expect(summary?.appliedCount).toBe(1);
    expect(loadSessionEntry({ storePath, sessionKey: oldKey })).toBeUndefined();
    expect(loadSessionEntry({ storePath, sessionKey: freshKey })).toBeDefined();
    expect(
      loadTranscriptEventsSync({
        sessionId: "old-apply-budget-session",
        sessionKey: oldKey,
        storePath,
      }),
    ).toEqual([]);
    expect(
      loadTranscriptEventsSync({
        sessionId: "fresh-apply-budget-session",
        sessionKey: freshKey,
        storePath,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("sessions cleanup dry-run accounts SQLite trajectory rows in disk budget", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 500,
          maxDiskBytes: 1_200,
          highWaterBytes: 700,
        },
      },
    });

    const now = Date.now();
    const oldKey = "agent:main:explicit:old-trajectory-budget";
    const freshKey = "agent:main:explicit:fresh-trajectory-budget";
    await seedSqliteSessionStore(storePath, {
      [oldKey]: { sessionId: "old-trajectory-budget-session", updatedAt: now - DAY_MS },
      [freshKey]: { sessionId: "fresh-trajectory-budget-session", updatedAt: now },
    });
    await seedSqliteTrajectoryEvent({
      content: "old-" + "x".repeat(1_400),
      sessionId: "old-trajectory-budget-session",
      sessionKey: oldKey,
      storePath,
    });

    const dryRun = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, dryRun: true, enforce: true, activeKey: freshKey },
      targets: [{ agentId: "main", storePath }],
    });

    const diskBudgetSummary = dryRun.previewResults[0]?.summary.diskBudget;
    if (diskBudgetSummary === null || diskBudgetSummary === undefined) {
      throw new Error("expected SQLite trajectory row-byte disk budget summary");
    }
    expect(diskBudgetSummary.totalBytesBefore).toBeGreaterThan(1_200);
    expect(diskBudgetSummary.totalBytesAfter).toBeLessThan(diskBudgetSummary.totalBytesBefore);
    expect(diskBudgetSummary.removedEntries).toBe(1);
    expect(dryRun.previewResults[0]?.budgetEvictedKeys.has(oldKey)).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey: oldKey })).toBeDefined();
    await expect(
      loadSqliteTrajectoryRuntimeEvents({
        sessionId: "old-trajectory-budget-session",
        storePath,
      }),
    ).resolves.toHaveLength(1);
  });

  it("sessions cleanup apply removes budget-evicted SQLite trajectory rows", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 500,
          maxDiskBytes: 1_200,
          highWaterBytes: 700,
        },
      },
    });

    const now = Date.now();
    const oldKey = "agent:main:explicit:old-trajectory-apply-budget";
    const freshKey = "agent:main:explicit:fresh-trajectory-apply-budget";
    await seedSqliteSessionStore(storePath, {
      [oldKey]: { sessionId: "old-trajectory-apply-budget-session", updatedAt: now - DAY_MS },
      [freshKey]: { sessionId: "fresh-trajectory-apply-budget-session", updatedAt: now },
    });
    await seedSqliteTrajectoryEvent({
      content: "old-" + "x".repeat(1_400),
      sessionId: "old-trajectory-apply-budget-session",
      sessionKey: oldKey,
      storePath,
    });
    await seedSqliteTrajectoryEvent({
      content: "fresh",
      sessionId: "fresh-trajectory-apply-budget-session",
      sessionKey: freshKey,
      storePath,
    });

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { store: storePath, enforce: true, activeKey: freshKey },
      targets: [{ agentId: "main", storePath }],
    });

    const diskBudgetSummary = applied.appliedSummaries[0]?.diskBudget;
    if (diskBudgetSummary === null || diskBudgetSummary === undefined) {
      throw new Error("expected applied SQLite trajectory row-byte disk budget summary");
    }
    expect(diskBudgetSummary.removedEntries).toBe(1);
    expect(loadSessionEntry({ storePath, sessionKey: oldKey })).toBeUndefined();
    expect(loadSessionEntry({ storePath, sessionKey: freshKey })).toBeDefined();
    await expect(
      loadSqliteTrajectoryRuntimeEvents({
        sessionId: "old-trajectory-apply-budget-session",
        storePath,
      }),
    ).resolves.toEqual([]);
    await expect(
      loadSqliteTrajectoryRuntimeEvents({
        sessionId: "fresh-trajectory-apply-budget-session",
        storePath,
      }),
    ).resolves.toHaveLength(1);
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
      "agent:main:explicit:stale": { sessionId: "stale-session", updatedAt: now - 30 * DAY_MS },
      "agent:main:explicit:capped": { sessionId: "capped-session", updatedAt: now - DAY_MS },
      "agent:main:explicit:fresh": { sessionId: "fresh-session", updatedAt: now },
    };
    const staleTranscript = path.join(testDir, "stale-session.jsonl");
    const cappedTranscript = path.join(testDir, "capped-session.jsonl");
    const freshTranscript = path.join(testDir, "fresh-session.jsonl");
    await seedSqliteSessionStore(storePath, store);
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

  it("keeps archived transcripts by default", async () => {
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
    const bakArchived = path.join(
      testDir,
      `bak-session.jsonl.bak.${archiveTimestamp(now - 20 * DAY_MS)}`,
    );
    await fs.writeFile(oldArchived, "old", "utf-8");
    await fs.writeFile(bakArchived, "bak", "utf-8");

    await saveSessionStore(storePath, store);

    // Archives are conversation history: without an explicit retention
    // duration only the disk budget may evict them.
    await expectPathExists(oldArchived);
    await expectPathExists(bakArchived);
  });

  it("cleans up deleted archives when resetArchiveRetention is configured", async () => {
    mockLoadConfig.mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "7d",
          resetArchiveRetention: "7d",
          maxEntries: 500,
        },
      },
    });

    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      fresh: { sessionId: "fresh-session", updatedAt: now },
    };
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
