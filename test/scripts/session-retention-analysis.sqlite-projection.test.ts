import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rankRetentionGroups } from "../../scripts/session-retention-analysis/graph-aware-ranking.js";
import {
  buildRetentionOwnershipGroups,
  projectSessionRetentionGroups,
} from "../../scripts/session-retention-analysis/sqlite-projection.js";
import {
  assertDisposableOpenClawStateDir,
  assertIsolatedStateEnvironment,
  RETENTION_TEMP_PREFIX,
} from "../../scripts/session-retention-analysis/state-safety.js";
import { readSessionStoreFingerprint } from "../../scripts/session-retention-analysis/store-fingerprint.js";
import {
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "../../src/config/sessions/session-accessor.js";
import { applySessionEntryMaintenance } from "../../src/config/sessions/session-accessor.sqlite-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../src/config/sessions/session-sqlite-target.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function writeFixtureEntry(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  updatedAt: number;
  parentSessionKey?: string;
  spawnedBy?: string;
  pinnedAt?: number;
  usageFamilySessionIds?: string[];
}): void {
  replaceSessionEntrySync(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    {
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      lastActivityAt: params.updatedAt,
      ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
      ...(params.spawnedBy ? { spawnedBy: params.spawnedBy } : {}),
      ...(params.pinnedAt ? { pinnedAt: params.pinnedAt } : {}),
      ...(params.usageFamilySessionIds
        ? { usageFamilySessionIds: params.usageFamilySessionIds }
        : {}),
    },
  );
  replaceTranscriptEventsSync(
    {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: params.storePath,
    },
    [
      { type: "session", id: params.sessionId, content: "projection fixture" },
      {
        type: "message",
        id: `${params.sessionId}-message`,
        parentId: null,
        message: { role: "user", content: "bounded fixture" },
      },
    ],
  );
}

describe("read-only SQLite session retention projection", () => {
  it("consumes canonical eligibility and ownership order without mutating the store", async () => {
    const state = await createOpenClawTestState({
      prefix: RETENTION_TEMP_PREFIX,
      layout: "state-only",
    });
    try {
      assertIsolatedStateEnvironment(state.stateDir);
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const sharedSessionId = "retention-shared-owner";
      writeFixtureEntry({
        storePath,
        sessionKey: "agent:main:eligible-oldest",
        sessionId: "eligible-oldest",
        updatedAt: 1,
      });
      writeFixtureEntry({
        storePath,
        sessionKey: "agent:main:eligible-shared-a",
        sessionId: "eligible-shared-a",
        updatedAt: 2,
        usageFamilySessionIds: [sharedSessionId],
      });
      writeFixtureEntry({
        storePath,
        sessionKey: "agent:main:eligible-shared-b",
        sessionId: "eligible-shared-b",
        updatedAt: 3,
        usageFamilySessionIds: [sharedSessionId],
      });
      writeFixtureEntry({
        storePath,
        sessionKey: "agent:main:protected-pinned",
        sessionId: "protected-pinned",
        updatedAt: 1,
        pinnedAt: 1,
      });
      writeFixtureEntry({
        storePath,
        sessionKey: "agent:main:protected-recent",
        sessionId: "protected-recent",
        updatedAt: Date.now(),
      });
      const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
      if (!target.path) {
        throw new Error("expected projection fixture database path");
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
      const fingerprintBefore = readSessionStoreFingerprint(database);
      const plan = applySessionEntryMaintenance(database, {
        activeSessionKey: "agent:main:main",
        archiveDirectory: state.sessionsDir(),
        forceMaintenance: true,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 1,
          archiveDashboardAfterMs: null,
          maxEntries: Number.MAX_SAFE_INTEGER,
          modelRunPruneAfterMs: Number.MAX_SAFE_INTEGER,
          preserveRecentMs: 7 * 24 * 60 * 60 * 1_000,
          resetArchiveRetentionMs: null,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        storePath,
      });
      expect(readSessionStoreFingerprint(database)).toBe(fingerprintBefore);
      const ownershipGroups = buildRetentionOwnershipGroups([plan]);
      const removalKeys = ownershipGroups.flatMap((group) =>
        group.entryRemovals.map((removal) => removal.sessionKey),
      );
      expect(removalKeys).not.toContain("agent:main:protected-pinned");
      expect(removalKeys).not.toContain("agent:main:protected-recent");
      expect(ownershipGroups.some((group) => group.entryRemovals.length === 2)).toBe(true);
      closeOpenClawAgentDatabasesForTest();

      const projection = projectSessionRetentionGroups({
        database: { agentId: "main", path: target.path },
        ownershipGroups,
      });
      const existingOrder = rankRetentionGroups({
        groups: projection.groups,
        policy: "existing-order",
      });
      expect(existingOrder.map((ranked) => ranked.group.existingOrder)).toEqual(
        ownershipGroups.map((group) => group.order),
      );
      expect(existingOrder.map((ranked) => ranked.group.groupId)).toEqual(
        projection.groups.map((group) => group.groupId),
      );
      const fingerprintAfter = withOpenClawAgentDatabaseReadOnly(
        (readonlyDatabase) =>
          readSessionStoreFingerprint(readonlyDatabase as OpenClawAgentDatabase),
        { agentId: "main", path: target.path },
      );
      expect(fingerprintAfter).toEqual({ found: true, value: fingerprintBefore });
    } finally {
      await state.cleanup();
    }
  });

  it("preserves distinct parent and spawner links from historical session windows", async () => {
    const state = await createOpenClawTestState({
      prefix: RETENTION_TEMP_PREFIX,
      layout: "state-only",
    });
    try {
      assertIsolatedStateEnvironment(state.stateDir);
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const parentKey = "agent:main:lineage-parent";
      const spawnerKey = "agent:main:lineage-spawner";
      const childKey = "agent:main:lineage-child";
      writeFixtureEntry({
        storePath,
        sessionKey: parentKey,
        sessionId: "lineage-parent",
        updatedAt: 1,
      });
      writeFixtureEntry({
        storePath,
        sessionKey: spawnerKey,
        sessionId: "lineage-spawner",
        updatedAt: 2,
      });
      writeFixtureEntry({
        storePath,
        sessionKey: childKey,
        sessionId: "lineage-child-history",
        updatedAt: 3,
        parentSessionKey: parentKey,
        spawnedBy: spawnerKey,
      });
      // Rotate the child through the production writer so its distinct lineage survives only on
      // the historical window rather than the current node.
      writeFixtureEntry({
        storePath,
        sessionKey: childKey,
        sessionId: "lineage-child-current",
        updatedAt: 4,
      });

      const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
      if (!target.path) {
        throw new Error("expected lineage fixture database path");
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
      const fingerprintBefore = readSessionStoreFingerprint(database);
      const plan = applySessionEntryMaintenance(database, {
        activeSessionKey: "agent:main:main",
        archiveDirectory: state.sessionsDir(),
        forceMaintenance: true,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 1,
          archiveDashboardAfterMs: null,
          maxEntries: Number.MAX_SAFE_INTEGER,
          modelRunPruneAfterMs: Number.MAX_SAFE_INTEGER,
          preserveRecentMs: 0,
          resetArchiveRetentionMs: null,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        storePath,
      });
      expect(readSessionStoreFingerprint(database)).toBe(fingerprintBefore);
      const ownershipGroups = buildRetentionOwnershipGroups([plan]);
      closeOpenClawAgentDatabasesForTest();

      const projection = projectSessionRetentionGroups({
        database: { agentId: "main", path: target.path },
        ownershipGroups,
      });
      const groupByKey = new Map(
        projection.groups.flatMap((group) => group.sessionKeys.map((key) => [key, group] as const)),
      );
      const parent = groupByKey.get(parentKey);
      const spawner = groupByKey.get(spawnerKey);
      const child = groupByKey.get(childKey);
      if (!parent || !spawner || !child) {
        throw new Error("expected parent, spawner, and child retention groups");
      }
      expect(child.parentGroupIds).toEqual([parent.groupId, spawner.groupId].toSorted());
      expect(parent.childGroupIds).toEqual([child.groupId]);
      expect(spawner.childGroupIds).toEqual([child.groupId]);
      expect(parent.directChildCount).toBe(1);
      expect(spawner.directChildCount).toBe(1);
      expect(parent.descendantCount).toBe(1);
      expect(spawner.descendantCount).toBe(1);
      expect(child.directChildCount).toBe(0);
      expect(child.descendantCount).toBe(0);
      const fingerprintAfter = withOpenClawAgentDatabaseReadOnly(
        (readonlyDatabase) =>
          readSessionStoreFingerprint(readonlyDatabase as OpenClawAgentDatabase),
        { agentId: "main", path: target.path },
      );
      expect(fingerprintAfter).toEqual({ found: true, value: fingerprintBefore });
    } finally {
      await state.cleanup();
    }
  });

  it("rejects any non-temporary OpenClaw state directory", () => {
    expect(() => assertDisposableOpenClawStateDir(process.cwd())).toThrow(
      "isolated mkdtemp state directory",
    );
  });

  it("does not select archive payloads in the SQLite projection", () => {
    const sourcePath = new URL(
      "../../scripts/session-retention-analysis/sqlite-projection.ts",
      import.meta.url,
    );
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).not.toMatch(/archive_blob/u);
    expect(source).not.toMatch(/selectFrom\(["']session_transcript_archives["']\)/u);
  });
});
