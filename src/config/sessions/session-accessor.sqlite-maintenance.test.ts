// A plugin-supplied `pruneAfterMs` of 0 disables age pruning end-to-end: the
// SQLite preflight must not treat every row as a stale candidate (which would
// force a full-store load on every session update), and the maintenance plan
// must come back empty even when rows are older than any positive window.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { applySqliteSessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { normalizeResolvedMaintenanceConfigInput } from "./store-maintenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("applySqliteSessionEntryMaintenance with non-positive retention", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-sqlite-maint-zero-retention-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  async function seedStore(now: number): Promise<void> {
    await replaceSessionEntry(
      { sessionKey: "agent:main:plugin-active", storePath },
      { sessionId: "plugin-active", updatedAt: now },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:plugin-stale-1", storePath },
      { sessionId: "plugin-stale-1", updatedAt: now - 10_000 },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:main:plugin-stale-2", storePath },
      { sessionId: "plugin-stale-2", updatedAt: now - 20_000 },
    );
  }

  function maintenanceConfigWith(pruneAfterMs: number) {
    return normalizeResolvedMaintenanceConfigInput({
      mode: "enforce",
      pruneAfterMs,
      maxEntries: 500,
      resetArchiveRetentionMs: null,
      maxDiskBytes: null,
      highWaterBytes: null,
    });
  }

  function runMaintenance(pruneAfterMs: number) {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected an agent database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    return applySqliteSessionEntryMaintenance(database, {
      activeSessionKey: "agent:main:plugin-active",
      archiveDirectory: path.join(tempDir, "archive"),
      maintenanceConfig: maintenanceConfigWith(pruneAfterMs),
      storePath,
    });
  }

  it("plans no removals for stale rows when pruneAfterMs is 0", async () => {
    await seedStore(Date.now());

    const plan = runMaintenance(0);

    expect(plan.entryRemovals).toEqual([]);
    expect(plan.stateDeletePlans).toEqual([]);
  });

  it("still plans the stale rows for removal under a positive retention", async () => {
    await seedStore(Date.now());

    const plan = runMaintenance(1_000);

    // Positive control: the same rows are prunable, so the zero-retention
    // no-op above comes from the disabled guard, not from a harness mistake.
    expect(plan.entryRemovals).toHaveLength(2);
  });
});
