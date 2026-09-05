import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createBackupResourceInventory } from "../commands/backup-resource-inventory.js";
import { createBackupSqliteSnapshotPlan } from "./backup-sqlite-snapshot.js";
import { requireNodeSqlite } from "./node-sqlite.js";

// A regression that drops the bound must fail fast instead of spinning forever.
const MOCK_BACKUP_STEP_CEILING = 100_000;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

async function createSnapshotPlanFixture(): Promise<{
  run: () => Promise<unknown>;
  sourcePath: string;
}> {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-backup-sqlite-snapshot-"));
  const stateDir = path.join(root, "state");
  const outputDir = path.join(root, "out");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const sourcePath = path.join(stateDir, "plugin-store.sqlite");
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(sourcePath);
  source.exec("CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe VALUES ('ready');");
  source.close();

  const inventory = await createBackupResourceInventory({
    stateDir,
    configPaths: [path.join(root, "openclaw.json")],
    oauthDirs: [path.join(root, "oauth")],
    workspaceDirs: [],
    excludedWorkspaceDirs: [],
    agentRoots: [],
    pluginResources: [],
    pluginRoots: [],
  });

  return {
    sourcePath,
    run: () =>
      createBackupSqliteSnapshotPlan({
        inventory,
        tempDir: outputDir,
        legacyAuditSnapshots: [],
      }),
  };
}

describe("createBackupSqliteSnapshotPlan", () => {
  it("adds the configuration-only remedy when the source never holds still", async () => {
    const sqlite = requireNodeSqlite();
    const fixture = await createSnapshotPlanFixture();
    vi.spyOn(sqlite, "backup").mockImplementation(async (_source, _destination, options) => {
      for (let step = 0; step < MOCK_BACKUP_STEP_CEILING; step += 1) {
        options?.progress?.({ remainingPages: 50, totalPages: 50 });
      }
      throw new Error(`backup progress was not bounded in ${MOCK_BACKUP_STEP_CEILING} steps`);
    });

    const error = await fixture.run().then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(fixture.sourcePath);
    expect((error as Error).message).toContain("openclaw backup create --only-config");
  });

  it("leaves an unrelated snapshot failure without a backup-command remedy", async () => {
    const sqlite = requireNodeSqlite();
    const fixture = await createSnapshotPlanFixture();
    vi.spyOn(sqlite, "backup").mockRejectedValue(new Error("destination filesystem is read-only"));

    const error = await fixture.run().then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("destination filesystem is read-only");
    expect((error as Error).message).not.toMatch(/only-config/iu);
  });
});
