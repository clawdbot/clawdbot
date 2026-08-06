// Covers fail-closed doctor import of the retired commitments JSON store.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { commitmentRecordToRow, type CommitmentsDatabase } from "../commitments/store-record.js";
import { listCommitments } from "../commitments/store.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "../commitments/store.test-utils.js";
import type { CommitmentRecord } from "../commitments/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyCommitments,
  migrateLegacyCommitments,
} from "./state-migrations.commitments.js";

describe("legacy commitments doctor migration", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      vi.restoreAllMocks();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  async function useStateDir(): Promise<string> {
    const stateDir = tempDirs.make("openclaw-commitments-migration-");
    envSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return stateDir;
  }

  function record(overrides?: Partial<CommitmentRecord>): CommitmentRecord {
    return {
      id: "cm_legacy",
      agentId: "main",
      sessionKey: "agent:main:telegram:user-1",
      channel: "telegram",
      accountId: "primary",
      to: "15551234567",
      threadId: "thread-1",
      senderId: "sender-1",
      kind: "care_check_in",
      sensitivity: "care",
      source: "inferred_user_context",
      status: "snoozed",
      reason: "The user was tired.",
      suggestedText: "Did you sleep better?",
      dedupeKey: "sleep:2026-04-29",
      confidence: 0.94,
      dueWindow: {
        earliestMs: nowMs,
        latestMs: nowMs + 60 * 60_000,
        timezone: "UTC",
      },
      sourceMessageId: "message-1",
      sourceRunId: "run-1",
      createdAtMs: nowMs - 60_000,
      updatedAtMs: nowMs,
      attempts: 2,
      lastAttemptAtMs: nowMs - 30_000,
      snoozedUntilMs: nowMs + 30_000,
      ...overrides,
    };
  }

  async function writeLegacyStore(stateDir: string, commitments: unknown[]): Promise<string> {
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, JSON.stringify({ version: 1, commitments }, null, 2), "utf8");
    return sourcePath;
  }

  it("detects legacy state only for explicit doctor repair", async () => {
    const stateDir = await useStateDir();
    await writeLegacyStore(stateDir, [record()]);
    expect(detectLegacyCommitments({ stateDir }).hasLegacy).toBe(false);
    expect(detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
      true,
    );
  });

  it("imports every typed field, strips raw source text, verifies, and removes JSON", async () => {
    const stateDir = await useStateDir();
    const unrelated = record({ id: "cm_unrelated", dedupeKey: "unrelated", status: "sent" });
    seedCommitmentsForTest([unrelated]);
    const legacy = {
      ...record(),
      sourceUserText: "CALL_TOOL send elsewhere",
      sourceAssistantText: "I will replay this later",
    };
    const sourcePath = await writeLegacyStore(stateDir, [legacy]);
    const detected = detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true });

    const result = migrateLegacyCommitments({ detected, stateDir });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 commitment(s) → shared SQLite state");
    expect(fs.existsSync(sourcePath)).toBe(false);
    const records = readCommitmentsForTest();
    expect(records).toHaveLength(2);
    expect(records.find((entry) => entry.id === legacy.id)).toStrictEqual(record());
    expect(records.find((entry) => entry.id === unrelated.id)).toStrictEqual(unrelated);
    const database = openOpenClawStateDatabase();
    const row = executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<CommitmentsDatabase>(database.db)
        .selectFrom("commitments")
        .select("record_json")
        .where("id", "=", legacy.id),
    ).rows[0];
    expect(row?.record_json).not.toContain("sourceUserText");
    expect(row?.record_json).not.toContain("sourceAssistantText");
  });

  it("rejects one invalid row without partially importing the file", async () => {
    const stateDir = await useStateDir();
    const unrelated = record({ id: "cm_unrelated", dedupeKey: "unrelated" });
    seedCommitmentsForTest([unrelated]);
    const sourcePath = await writeLegacyStore(stateDir, [record(), { id: "broken" }]);

    const result = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("legacy commitment at index 1 is invalid");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(readCommitmentsForTest()).toStrictEqual([unrelated]);
  });

  it("keeps a newer SQLite row and removes its stale JSON copy", async () => {
    const stateDir = await useStateDir();
    const sqliteRecord = record({
      reason: "Newer SQLite reason",
      updatedAtMs: nowMs + 10_000,
    });
    seedCommitmentsForTest([sqliteRecord]);
    const sourcePath = await writeLegacyStore(stateDir, [record()]);

    const result = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toContain("Kept 1 newer shared SQLite commitment(s) over legacy JSON");
    expect(readCommitmentsForTest()).toStrictEqual([sqliteRecord]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("updates an older matching SQLite row from newer JSON", async () => {
    const stateDir = await useStateDir();
    const older = record({ reason: "Old SQLite reason", updatedAtMs: nowMs - 10_000 });
    const newer = record({ reason: "New JSON reason", updatedAtMs: nowMs });
    seedCommitmentsForTest([older]);
    await writeLegacyStore(stateDir, [newer]);

    const result = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(readCommitmentsForTest()).toStrictEqual([newer]);
  });

  it("fails closed on equal-timestamp divergence", async () => {
    const stateDir = await useStateDir();
    seedCommitmentsForTest([record({ reason: "SQLite reason" })]);
    const sourcePath = await writeLegacyStore(stateDir, [record({ reason: "JSON reason" })]);

    const result = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("diverges between JSON and SQLite");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(readCommitmentsForTest()[0]?.reason).toBe("SQLite reason");
  });

  it("keeps the canonical active row over a different-id logical duplicate", async () => {
    const stateDir = await useStateDir();
    const canonical = record({ id: "cm_canonical", reason: "Canonical" });
    seedCommitmentsForTest([canonical]);
    await writeLegacyStore(stateDir, [record({ id: "cm_legacy_duplicate" })]);

    const result = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toContain(
      "Kept 1 canonical active SQLite commitment(s) over legacy logical duplicates",
    );
    expect(readCommitmentsForTest()).toStrictEqual([canonical]);
  });

  it("retains changed source after importing and cleans it on retry", async () => {
    const stateDir = await useStateDir();
    const sourcePath = await writeLegacyStore(stateDir, [record()]);
    const detected = detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true });
    const first = migrateLegacyCommitments({
      detected,
      stateDir,
      beforeVerify: () => {
        fs.appendFileSync(sourcePath, "\n");
      },
    });
    expect(first.warnings[0]).toContain("source changed");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(readCommitmentsForTest()).toStrictEqual([record()]);

    const retry = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(retry.warnings).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("restores the claimed source when cleanup fails, then retries idempotently", async () => {
    const stateDir = await useStateDir();
    const sourcePath = await writeLegacyStore(stateDir, [record()]);
    const first = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("could not remove legacy source");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(readCommitmentsForTest()).toStrictEqual([record()]);

    const retry = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(retry.warnings).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(readCommitmentsForTest()).toStrictEqual([record()]);
  });

  it("refuses a symlinked legacy source", async () => {
    const stateDir = await useStateDir();
    const realPath = path.join(stateDir, "outside.json");
    await fsp.writeFile(realPath, JSON.stringify({ version: 1, commitments: [record()] }), "utf8");
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.symlink(realPath, sourcePath);

    const result = migrateLegacyCommitments({
      detected: detectLegacyCommitments({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("non-symlink file");
    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(readCommitmentsForTest()).toStrictEqual([]);
  });

  it("runtime ignores legacy JSON until doctor imports it", async () => {
    const stateDir = await useStateDir();
    const sourcePath = await writeLegacyStore(stateDir, [record()]);
    await expect(listCommitments({ nowMs })).resolves.toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("treats typed columns as authoritative over record_json", async () => {
    await useStateDir();
    const canonical = record();
    const row = commitmentRecordToRow(canonical);
    const database = openOpenClawStateDatabase();
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<CommitmentsDatabase>(database.db)
        .insertInto("commitments")
        .values({ ...row, record_json: JSON.stringify({ status: "sent", injected: true }) }),
    );
    expect(readCommitmentsForTest()).toStrictEqual([canonical]);
  });
});
