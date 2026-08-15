import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertLegacyMigrationSourceUnchanged,
  claimAndRemoveLegacyMigrationSource,
  claimLegacyMigrationSourceClaims,
  LegacyMigrationSourceClaim,
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

  function createClaim(stateRoot: Root, stateDir: string, sourcePath: string) {
    return new LegacyMigrationSourceClaim({
      stateRoot,
      stateDir,
      sourcePath,
      label: "test",
      readSnapshot: (candidatePath) =>
        readLegacyMigrationSourceSnapshot({
          stateRoot,
          stateDir,
          sourcePath: candidatePath,
          maxBytes: 1024,
          label: "test",
        }),
    });
  }

  it("detects an interrupted claim without accepting absent source state", () => {
    const { sourcePath } = createSource();
    fs.renameSync(sourcePath, `${sourcePath}.doctor-importing`);
    expect(legacyMigrationSourceOrClaimMayExist(sourcePath)).toBe(true);
    fs.unlinkSync(`${sourcePath}.doctor-importing`);
    expect(legacyMigrationSourceOrClaimMayExist(sourcePath)).toBe(false);
  });

  it("rejects source paths outside the trusted migration root without exposing redacted paths", async () => {
    const { stateDir } = createSource();
    const outsidePath = path.join(stateDir, "..", "private-marker");
    expect(() => resolveLegacyMigrationRelativePath(stateDir, outsidePath, "test")).toThrow(
      "outside the state directory",
    );
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    expect(
      () =>
        new LegacyMigrationSourceClaim({
          stateRoot,
          stateDir,
          sourcePath: outsidePath,
          label: "test",
          includeFilePath: false,
          readSnapshot: () => Promise.reject(new Error("unreachable")),
        }),
    ).toThrowError(/^legacy test path is outside the state directory$/u);
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

  it("recovers interrupted claims without discarding a matching active source", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    fs.copyFileSync(sourcePath, claim.claimPath);

    await claim.recover("interrupted source conflicts with its replacement");

    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"version":1}\n');
    expect(fs.existsSync(claim.claimPath)).toBe(false);

    fs.renameSync(sourcePath, claim.claimPath);
    await claim.recover("interrupted source conflicts with its replacement");

    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"version":1}\n');
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it("rejects an inode replacement with matching bytes and restores its source", async () => {
    const { sourcePath, stateDir } = createSource();
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const claim = createClaim(stateRoot, stateDir, sourcePath);
    const snapshot = await claim.read();
    const replacementPath = path.join(stateDir, "replacement.json");
    fs.writeFileSync(replacementPath, snapshot.buffer);
    const replacementInode = fs.statSync(replacementPath).ino;

    await expect(
      claim.claim({
        snapshot,
        mismatchMessage: "source inode changed before claim",
        beforeClaim: () => fs.renameSync(replacementPath, sourcePath),
      }),
    ).rejects.toThrow("source inode changed before claim");
    expect(await claim.restore()).toBeNull();

    expect(fs.statSync(sourcePath).ino).toBe(replacementInode);
    expect(fs.statSync(sourcePath).ino).not.toBe(snapshot.ino);
    expect(fs.readFileSync(sourcePath)).toEqual(snapshot.buffer);
    expect(fs.existsSync(claim.claimPath)).toBe(false);
  });

  it("restores every claimed source when a later multi-file claim changes", async () => {
    const { sourcePath, stateDir } = createSource();
    const secondPath = path.join(stateDir, "second.json");
    fs.writeFileSync(secondPath, '{"version":2}\n', "utf8");
    const stateRoot = await root(stateDir, { hardlinks: "reject", symlinks: "reject" });
    const firstClaim = createClaim(stateRoot, stateDir, sourcePath);
    const secondClaim = createClaim(stateRoot, stateDir, secondPath);
    const firstSnapshot = await firstClaim.read();
    const secondSnapshot = await secondClaim.read();
    const replacementPath = path.join(stateDir, "replacement.json");
    fs.writeFileSync(replacementPath, secondSnapshot.buffer);

    await expect(
      claimLegacyMigrationSourceClaims(
        [
          { claim: firstClaim, snapshot: firstSnapshot },
          { claim: secondClaim, snapshot: secondSnapshot },
        ],
        {
          beforeClaim: () => fs.renameSync(replacementPath, secondPath),
          mismatchMessage: "batch source changed before claim",
        },
      ),
    ).rejects.toThrow("batch source changed before claim");

    expect(fs.readFileSync(sourcePath)).toEqual(firstSnapshot.buffer);
    expect(fs.readFileSync(secondPath)).toEqual(secondSnapshot.buffer);
    expect(fs.readdirSync(stateDir).toSorted()).toEqual(["legacy.json", "second.json"]);
  });
});
