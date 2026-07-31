import fs from "node:fs";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertLegacyMigrationSourceUnchanged,
  claimAndRemoveLegacyMigrationSource,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  readLegacyMigrationSourceSnapshotSync,
  resolveLegacyMigrationRelativePath,
} from "./state-migrations.source-snapshot.js";

describe("doctor legacy migration source contract", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(cleanup);
  });

  function createSource(content = '{"version":1}\n') {
    const stateDir = tempDirs.make("openclaw-migration-source-");
    const sourcePath = path.join(stateDir, "legacy.json");
    fs.writeFileSync(sourcePath, content, "utf8");
    return { sourcePath, stateDir };
  }

  it("detects an interrupted claim without accepting absent source state", () => {
    const { sourcePath } = createSource();
    fs.renameSync(sourcePath, `${sourcePath}.doctor-importing`);
    expect(legacyMigrationSourceOrClaimMayExist(sourcePath)).toBe(true);
    fs.unlinkSync(`${sourcePath}.doctor-importing`);
    expect(legacyMigrationSourceOrClaimMayExist(sourcePath)).toBe(false);
  });

  it("rejects source paths outside the trusted migration root", () => {
    const { stateDir } = createSource();
    expect(() =>
      resolveLegacyMigrationRelativePath(stateDir, path.join(stateDir, "..", "escape"), "test"),
    ).toThrow("outside the state directory");
  });

  it("shares the same pinned source identity across root-bound and sync readers", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const bounded = await readLegacyMigrationSourceSnapshot({
      stateRoot,
      stateDir,
      sourcePath,
      maxBytes: 1024,
      label: "test",
    });
    const sync = readLegacyMigrationSourceSnapshotSync({ sourcePath, label: "test" });
    expect(legacyMigrationSourceSnapshotsMatch(bounded, sync)).toBe(true);
    fs.writeFileSync(sourcePath, '{"version":2}\n', "utf8");
    expect(() =>
      assertLegacyMigrationSourceUnchanged({ sourcePath, snapshot: sync, label: "test" }),
    ).toThrow("changed after doctor loaded it");
  });

  it("restores the original source when verified claim cleanup fails", () => {
    const { sourcePath } = createSource();
    const snapshot = readLegacyMigrationSourceSnapshotSync({ sourcePath, label: "test" });
    expect(() =>
      claimAndRemoveLegacyMigrationSource({
        sourcePath,
        snapshot,
        label: "test",
        removeSource: () => {
          throw new Error("simulated cleanup failure");
        },
      }),
    ).toThrow("simulated cleanup failure");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(snapshot.raw);
    expect(fs.readdirSync(path.dirname(sourcePath))).toEqual(["legacy.json"]);
  });
});
