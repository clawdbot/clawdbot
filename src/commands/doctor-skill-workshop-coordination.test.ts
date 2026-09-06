import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/node-sqlite.js";
import {
  acquireStateDatabaseCoordinator,
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";

it("respects another migration owner even when the state database is already open", async () => {
  await withOpenClawTestState({ label: "workshop-migration-owner" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const coordinatorPath = resolveStateDatabaseCoordinatorPath({
      databasePath: database.path,
      runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
      uid: process.getuid?.(),
    });
    const otherOwner = tryAcquireExclusiveSqliteCoordinator(coordinatorPath);
    expect(otherOwner).not.toBeNull();
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
      ).rejects.toThrow("another OpenClaw process owns state-lifecycle");
    } finally {
      otherOwner?.release();
    }
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });
});

it("preserves Doctor's outer ownership and releases migration ownership after failure", async () => {
  await withOpenClawTestState({ label: "workshop-migration-release" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const outer = acquireStateDatabaseCoordinator({ databasePath: database.path });
    const backupRoot = path.join(state.stateDir, "skill-workshop", "collection-backups");
    await fs.mkdir(backupRoot, { recursive: true });
    const readDirectory = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(new Error("backup directory unavailable"));
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: state.env }),
      ).rejects.toThrow("backup directory unavailable");
      expect(tryAcquireExclusiveSqliteCoordinator(outer.path)).toBeNull();
    } finally {
      readDirectory.mockRestore();
      outer.release();
    }
    const nextOwner = tryAcquireExclusiveSqliteCoordinator(outer.path);
    expect(nextOwner).not.toBeNull();
    nextOwner?.release();
  });
});
