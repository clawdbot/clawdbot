// Covers Doctor-only retirement of subagents/runs.json.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  detectLegacySubagentRegistry,
  migrateLegacySubagentRegistry,
} from "./state-migrations.subagent-registry.js";

type MigrationDatabase = Pick<OpenClawStateKyselyDatabase, "migration_sources" | "subagent_runs">;

describe("legacy subagent registry Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-subagent-migration-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  function createRun(runId: string): SubagentRunRecord {
    return {
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: `task ${runId}`,
      cleanup: "keep",
      createdAt: 100,
    };
  }

  async function writeLegacy(params: { stateDir: string; value?: unknown }): Promise<string> {
    const sourcePath = path.join(params.stateDir, "subagents", "runs.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      typeof params.value === "string"
        ? params.value
        : `${JSON.stringify(params.value ?? { version: 2, runs: {} }, null, 2)}\n`,
      "utf8",
    );
    return sourcePath;
  }

  function database(env: NodeJS.ProcessEnv) {
    return openOpenClawStateDatabase({ env }).db;
  }

  function seedCanonical(env: NodeJS.ProcessEnv, run: SubagentRunRecord): void {
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .insertInto("subagent_runs")
        .values({
          run_id: run.runId,
          child_session_key: run.childSessionKey,
          requester_session_key: run.requesterSessionKey,
          requester_display_key: run.requesterDisplayKey,
          task: run.task,
          cleanup: run.cleanup,
          created_at: run.createdAt,
          payload_json: JSON.stringify(run),
        }),
    );
  }

  function canonicalRunIds(env: NodeJS.ProcessEnv): string[] {
    const db = database(env);
    return executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("subagent_runs")
        .select("run_id")
        .orderBy("run_id", "asc"),
    ).rows.map((row) => row.run_id);
  }

  function clearCanonical(env: NodeJS.ProcessEnv): void {
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db).deleteFrom("subagent_runs"),
    );
  }

  function receipt(env: NodeJS.ProcessEnv) {
    const db = database(env);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_sources")
        .selectAll()
        .where("migration_kind", "=", "legacy-subagent-registry-json"),
    );
  }

  it("detects the source or interrupted claim only for explicit Doctor repair", async () => {
    const { stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    expect(detectLegacySubagentRegistry({ stateDir }).hasLegacy).toBe(false);
    expect(
      detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(
      detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
  });

  it("discards a well-formed snapshot instead of importing transient runs", async () => {
    const { env, stateDir } = useStateDir();
    const legacy = createRun("legacy-run");
    const sourcePath = await writeLegacy({
      stateDir,
      value: { version: 2, runs: { [legacy.runId]: legacy } },
    });

    const result = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Discarded retired subagent JSON without importing transient run state.",
    );
    expect(canonicalRunIds(env)).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt(env)).toMatchObject({ removed_source: 1, status: "completed" });
    expect(JSON.parse(receipt(env)?.report_json ?? "null")).toMatchObject({
      decision: "retired-source-discarded",
      importedRecordCount: 0,
    });
  });

  it("never parses malformed or blank-ID retired JSON into SQLite", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({
      stateDir,
      value: '{"version":2,"runs":{"   ":{"runId":"   "}}}',
    });

    const result = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(canonicalRunIds(env)).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("records the digest of the exact source bytes", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = path.join(stateDir, "subagents", "runs.json");
    const sourceBytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, sourceBytes);

    await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(receipt(env)).toMatchObject({
      source_sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("preserves canonical SQLite rows while discarding stale JSON", async () => {
    const { env, stateDir } = useStateDir();
    seedCanonical(env, createRun("canonical"));
    const sourcePath = await writeLegacy({
      stateDir,
      value: { version: 2, runs: { stale: createRun("stale") } },
    });

    const result = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(canonicalRunIds(env)).toEqual(["canonical"]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("cannot resurrect stale JSON after canonical SQLite rows are pruned", async () => {
    const { env, stateDir } = useStateDir();
    seedCanonical(env, createRun("completed"));
    clearCanonical(env);
    const sourcePath = await writeLegacy({
      stateDir,
      value: { version: 2, runs: { stale: createRun("stale") } },
    });

    await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(canonicalRunIds(env)).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("uses the receipt when cleanup fails and Doctor retries", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({
      stateDir,
      value: { version: 2, runs: { stale: createRun("stale") } },
    });
    const first = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("retirement cleanup failed");
    expect(canonicalRunIds(env)).toEqual([]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);

    const retry = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(retry.warnings).toEqual([]);
    expect(retry.changes).toContain(
      "Discarded recreated retired subagent JSON without importing it.",
    );
    expect(canonicalRunIds(env)).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("records an interrupted claim before processing a recreated source", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir, value: "original claim" });
    const claimPath = `${sourcePath}.doctor-importing`;
    await fsp.rename(sourcePath, claimPath);
    await writeLegacy({ stateDir, value: "recreated source" });

    const result = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      beforeClaim: () => fs.appendFileSync(sourcePath, " changed"),
    });

    expect(result.warnings[0]).toContain("changed before Doctor could claim it");
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env)).toMatchObject({
      removed_source: 1,
      source_sha256: createHash("sha256").update("original claim").digest("hex"),
    });
  });

  it("fails before recording a decision when the source changes before claim", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const result = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      beforeClaim: () => fs.appendFileSync(sourcePath, "\n"),
    });

    expect(result.warnings[0]).toContain("changed before Doctor could claim it");
    expect(receipt(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("requires exclusive state ownership", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_790,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let result: Awaited<ReturnType<typeof migrateLegacySubagentRegistry>>;
    try {
      result = await migrateLegacySubagentRegistry({
        detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("rejects symlinked, hardlinked, and oversized sources without mutation", async () => {
    const cases: Array<{ env: NodeJS.ProcessEnv; sourcePath: string; stateDir: string }> = [];

    const symlink = useStateDir();
    const symlinkOutside = path.join(symlink.stateDir, "outside.json");
    await fsp.writeFile(symlinkOutside, "{}", "utf8");
    const symlinkPath = path.join(symlink.stateDir, "subagents", "runs.json");
    await fsp.mkdir(path.dirname(symlinkPath), { recursive: true });
    await fsp.symlink(symlinkOutside, symlinkPath);
    cases.push({ ...symlink, sourcePath: symlinkPath });

    const hardlink = useStateDir();
    const hardlinkOutside = path.join(hardlink.stateDir, "outside.json");
    await fsp.writeFile(hardlinkOutside, "{}", "utf8");
    const hardlinkPath = path.join(hardlink.stateDir, "subagents", "runs.json");
    await fsp.mkdir(path.dirname(hardlinkPath), { recursive: true });
    await fsp.link(hardlinkOutside, hardlinkPath);
    cases.push({ ...hardlink, sourcePath: hardlinkPath });

    const oversized = useStateDir();
    const oversizedPath = await writeLegacy({
      stateDir: oversized.stateDir,
      value: "x".repeat(16 * 1024 * 1024 + 1),
    });
    cases.push({ ...oversized, sourcePath: oversizedPath });

    for (const testCase of cases) {
      const result = await migrateLegacySubagentRegistry({
        detected: detectLegacySubagentRegistry({
          stateDir: testCase.stateDir,
          doctorOnlyStateMigrations: true,
        }),
        env: testCase.env,
        stateDir: testCase.stateDir,
      });
      expect(result.warnings[0]).toContain("Failed reading legacy subagent registry");
      expect(receipt(testCase.env)).toBeUndefined();
      expect(fs.existsSync(testCase.sourcePath)).toBe(true);
    }
  });

  it("discards a file recreated by an old writer on the next Doctor run", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy({ stateDir });
    const first = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      removeSource: async (claimPath) => {
        await fsp.rm(claimPath);
        await writeLegacy({ stateDir, value: "recreated" });
      },
    });
    expect(first.warnings[0]).toContain("reappeared during cleanup");

    const retry = await migrateLegacySubagentRegistry({
      detected: detectLegacySubagentRegistry({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(canonicalRunIds(env)).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });
});
