// Covers Doctor-only retirement of commitments/commitments.json.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  detectLegacyCommitments,
  migrateLegacyCommitments,
} from "./state-migrations.commitments.js";

const CLAIM_SUFFIX = ".doctor-discarding";

describe("retired commitments Doctor cleanup", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-commitments-cleanup-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  async function writeLegacy(stateDir: string, value: unknown): Promise<string> {
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    return sourcePath;
  }

  function readReceipt(env: NodeJS.ProcessEnv) {
    return openOpenClawStateDatabase({ env })
      .db.prepare(
        `SELECT migration_kind, target_table, source_record_count, removed_source, report_json
         FROM migration_sources
         WHERE migration_kind = 'legacy-commitments-json'`,
      )
      .get() as
      | {
          migration_kind: string;
          target_table: string;
          source_record_count: number;
          removed_source: number;
          report_json: string;
        }
      | undefined;
  }

  it("detects the exact source or deterministic claim only for explicit Doctor repair", async () => {
    const { stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, commitments: [] });

    expect((await detectLegacyCommitments({ stateDir })).hasLegacy).toBe(false);
    expect(
      (
        await detectLegacyCommitments({
          stateDir,
          doctorOnlyStateMigrations: true,
        })
      ).hasLegacy,
    ).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}${CLAIM_SUFFIX}`);
    expect(
      (
        await detectLegacyCommitments({
          stateDir,
          doctorOnlyStateMigrations: true,
        })
      ).hasLegacy,
    ).toBe(true);

    const runtimeResult = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({ stateDir }),
      stateDir,
    });
    expect(runtimeResult).toEqual({ changes: [], warnings: [] });
    expect(fs.existsSync(`${sourcePath}${CLAIM_SUFFIX}`)).toBe(true);
  });

  it("records the destructive decision before deleting recognized rows", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      commitments: [{ id: "retired-1" }, { id: "retired-2" }],
    });

    const result = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
    });

    expect(result).toEqual({
      changes: [
        "Discarded retired commitments JSON with 2 rows; no data was imported, archived, or exported.",
      ],
      warnings: [],
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}${CLAIM_SUFFIX}`)).toBe(false);
    expect(await fsp.readdir(path.dirname(sourcePath))).toEqual([]);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'")
        .get(),
    ).toBeUndefined();
    const receipt = readReceipt(env);
    expect(receipt).toMatchObject({
      migration_kind: "legacy-commitments-json",
      target_table: "commitments",
      source_record_count: 2,
      removed_source: 1,
    });
    expect(JSON.parse(receipt?.report_json ?? "null")).toMatchObject({
      decision: "retired-source-discarded",
      importedRecordCount: 0,
      archivedRecordCount: 0,
      exportedRecordCount: 0,
    });

    await writeLegacy(stateDir, {
      version: 1,
      commitments: [{ id: "recreated" }],
    });
    await expect(
      migrateLegacyCommitments({
        detected: await detectLegacyCommitments({
          stateDir,
          env,
          doctorOnlyStateMigrations: true,
        }),
        env,
        stateDir,
      }),
    ).resolves.toEqual({
      changes: [
        "Discarded recreated retired commitments JSON with 1 row; no data was imported, archived, or exported.",
      ],
      warnings: [],
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong version", { version: 2, commitments: [] }],
    ["missing commitments", { version: 1 }],
    ["non-array commitments", { version: 1, commitments: {} }],
    ["extra top-level field", { version: 1, commitments: [], archive: true }],
  ])("leaves %s unchanged with a warning", async (_label, value) => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, value);
    const before = await fsp.readFile(sourcePath);

    const result = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain("Failed reading retired commitments JSON");
    await expect(fsp.readFile(sourcePath)).resolves.toEqual(before);
    expect(readReceipt(env)).toBeUndefined();
  });

  it("rejects symlinked and hardlinked sources without mutation", async () => {
    for (const linkKind of ["symlink", "hardlink"] as const) {
      const { env, stateDir } = useStateDir();
      const outsidePath = path.join(stateDir, `${linkKind}-outside.json`);
      await fsp.writeFile(
        outsidePath,
        JSON.stringify({ version: 1, commitments: [{ id: linkKind }] }),
        "utf8",
      );
      const sourcePath = path.join(stateDir, "commitments", "commitments.json");
      await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
      if (linkKind === "symlink") {
        await fsp.symlink(outsidePath, sourcePath);
      } else {
        await fsp.link(outsidePath, sourcePath);
      }

      const result = await migrateLegacyCommitments({
        detected: await detectLegacyCommitments({
          stateDir,
          env,
          doctorOnlyStateMigrations: true,
        }),
        env,
        stateDir,
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings[0]).toContain("Failed reading retired commitments JSON");
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.existsSync(outsidePath)).toBe(true);
      expect(readReceipt(env)).toBeUndefined();
    }
  });

  it.each(["beforeVerify", "beforeClaim"] as const)(
    "leaves a source changed %s unchanged",
    async (hook) => {
      const { env, stateDir } = useStateDir();
      const sourcePath = await writeLegacy(stateDir, { version: 1, commitments: [] });

      const result = await migrateLegacyCommitments({
        detected: await detectLegacyCommitments({
          stateDir,
          env,
          doctorOnlyStateMigrations: true,
        }),
        env,
        stateDir,
        [hook]: () => fs.appendFileSync(sourcePath, "\n"),
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings[0]).toContain("changed");
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.existsSync(`${sourcePath}${CLAIM_SUFFIX}`)).toBe(false);
      expect(readReceipt(env)).toBeUndefined();
    },
  );

  it("recovers an interrupted deterministic claim and retries idempotently", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      commitments: [{ id: "retired" }],
    });
    const first = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
      removeSource: () => {
        throw new Error("simulated cleanup failure");
      },
    });

    expect(first.changes).toEqual([]);
    expect(first.warnings[0]).toContain("discard was recorded, but cleanup failed");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}${CLAIM_SUFFIX}`)).toBe(true);
    expect(readReceipt(env)?.removed_source).toBe(0);

    const retry = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
    });
    expect(retry).toEqual({
      changes: [
        "Discarded retired commitments JSON with 1 row; no data was imported, archived, or exported.",
      ],
      warnings: [],
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}${CLAIM_SUFFIX}`)).toBe(false);
    expect(readReceipt(env)?.removed_source).toBe(1);

    const idempotent = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
    });
    expect(idempotent).toEqual({ changes: [], warnings: [] });
  });

  it("finalizes a pending receipt when cleanup removed the claim before throwing", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      commitments: [{ id: "retired" }],
    });
    const first = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
      removeSource: async (claimPath) => {
        await fsp.unlink(claimPath);
        throw new Error("simulated post-delete failure");
      },
    });

    expect(first.changes).toEqual([]);
    expect(first.warnings[0]).toContain("discard was recorded, but cleanup failed");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}${CLAIM_SUFFIX}`)).toBe(false);
    expect(readReceipt(env)?.removed_source).toBe(0);

    const detected = await detectLegacyCommitments({
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.hasLegacy).toBe(true);
    await expect(migrateLegacyCommitments({ detected, env, stateDir })).resolves.toEqual({
      changes: ["Finalized the retired commitments JSON discard receipt."],
      warnings: [],
    });
    expect(readReceipt(env)?.removed_source).toBe(1);
    expect(
      (
        await detectLegacyCommitments({
          stateDir,
          env,
          doctorOnlyStateMigrations: true,
        })
      ).hasLegacy,
    ).toBe(false);
  });

  it("leaves conflicting source and interrupted claim bytes unchanged", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      commitments: [{ id: "claim" }],
    });
    const claimPath = `${sourcePath}${CLAIM_SUFFIX}`;
    await fsp.rename(sourcePath, claimPath);
    await writeLegacy(stateDir, {
      version: 1,
      commitments: [{ id: "replacement" }],
    });

    const result = await migrateLegacyCommitments({
      detected: await detectLegacyCommitments({
        stateDir,
        env,
        doctorOnlyStateMigrations: true,
      }),
      env,
      stateDir,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain("conflicts with its interrupted Doctor claim");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(readReceipt(env)).toBeUndefined();
  });
});
