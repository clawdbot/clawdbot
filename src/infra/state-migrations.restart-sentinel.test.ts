// Covers safe startup/Doctor import of the retired restart-sentinel JSON file.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  clearRestartSentinel,
  readRestartSentinel,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel.js";
import {
  detectLegacyRestartSentinel,
  migrateLegacyRestartSentinel,
} from "./state-migrations.restart-sentinel.js";

type MigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "gateway_restart_sentinel" | "migration_sources"
>;

describe("legacy restart sentinel migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-restart-sentinel-migration-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  function payload(ts = 123): RestartSentinelPayload {
    return {
      kind: "update",
      status: "ok",
      ts,
      sessionKey: "agent:main:main",
      deliveryContext: { channel: "test", to: "target", accountId: "default" },
      threadId: "thread-1",
      message: "Update completed",
      continuation: { kind: "agentTurn", message: "Continue after restart" },
      doctorHint: "Run Doctor",
      stats: {
        mode: "managed",
        handoffId: "handoff-1",
        requiresRestart: true,
        before: { version: "old" },
        after: { version: "new" },
        steps: [
          {
            name: "install",
            command: "package-manager update",
            durationMs: 10,
            log: { stdoutTail: "done", stderrTail: null, exitCode: 0 },
          },
        ],
      },
    };
  }

  async function writeLegacy(stateDir: string, value: unknown): Promise<string> {
    const sourcePath = path.join(stateDir, "restart-sentinel.json");
    await fsp.writeFile(sourcePath, `${JSON.stringify(value)}\n`, "utf8");
    return sourcePath;
  }

  async function migrate(params: {
    env: NodeJS.ProcessEnv;
    stateDir: string;
    beforeVerify?: () => void;
    removeSource?: (sourcePath: string) => Promise<void> | void;
  }) {
    return await migrateLegacyRestartSentinel({
      detected: detectLegacyRestartSentinel({ stateDir: params.stateDir }),
      ...params,
    });
  }

  function database(env: NodeJS.ProcessEnv) {
    return openOpenClawStateDatabase({ env }).db;
  }

  function receipt(env: NodeJS.ProcessEnv) {
    const db = database(env);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_sources")
        .selectAll()
        .where("migration_kind", "=", "legacy-restart-sentinel-json"),
    );
  }

  it("detects both the retired source and an interrupted fixed claim", async () => {
    const { stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    expect(detectLegacyRestartSentinel({ stateDir }).hasLegacy).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(detectLegacyRestartSentinel({ stateDir }).hasLegacy).toBe(true);
  });

  it("imports and verifies the complete legacy payload before removing the source", async () => {
    const { env, stateDir } = useStateDir();
    const expected = payload();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: expected });

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Imported the legacy restart sentinel into shared SQLite state.",
    ]);
    await expect(readRestartSentinel(env)).resolves.toMatchObject({
      version: 1,
      payload: expected,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt(env)).toMatchObject({
      removed_source: 1,
      source_record_count: 1,
      status: "completed",
      target_table: "gateway_restart_sentinel",
    });
  });

  it("canonicalizes legacy null fields and an empty delivery context before verification", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 123,
        deliveryContext: {},
        message: null,
        continuation: null,
        doctorHint: null,
        stats: null,
      },
    });

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Imported the legacy restart sentinel into shared SQLite state.",
    ]);
    const migrated = await readRestartSentinel(env);
    expect(migrated?.payload).toEqual({ kind: "restart", status: "ok", ts: 123 });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt(env)).toMatchObject({
      removed_source: 1,
      source_record_count: 1,
      status: "completed",
    });
  });

  it("preserves a valid canonical row when legacy JSON conflicts", async () => {
    const { env, stateDir } = useStateDir();
    const canonical = payload(999);
    await writeRestartSentinel(canonical, env);
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload(1) });

    const result = await migrate({ env, stateDir });

    expect(result.changes).toEqual([
      "Preserved the canonical SQLite restart sentinel and discarded conflicting legacy JSON.",
    ]);
    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: canonical });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("repairs an invalid canonical row from a validated legacy envelope", async () => {
    const { env, stateDir } = useStateDir();
    const db = database(env);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db).insertInto("gateway_restart_sentinel").values({
        sentinel_key: "current",
        version: 99,
        kind: "update",
        status: "ok",
        ts: 1,
        session_key: null,
        thread_id: null,
        delivery_channel: null,
        delivery_to: null,
        delivery_account_id: null,
        message: null,
        continuation_json: null,
        doctor_hint: null,
        stats_json: null,
        payload_json: "{}",
        updated_at_ms: 1,
      }),
    );
    const expected = payload(456);
    await writeLegacy(stateDir, { version: 1, payload: expected });

    const result = await migrate({ env, stateDir });

    expect(result.changes).toEqual([
      "Replaced an invalid SQLite restart sentinel with validated legacy state.",
    ]);
    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: expected });
  });

  it("records and removes malformed transient state without disclosing its contents", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, {
      version: 1,
      payload: { ...payload(), ts: "invalid", message: "secret-marker" },
    });

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Discarded malformed retired restart sentinel JSON without importing it.",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-marker");
    expect(receipt(env)?.report_json).not.toContain("secret-marker");
    await expect(readRestartSentinel(env)).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("treats a completed receipt as authoritative if the retired file reappears", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy(stateDir, { version: 1, payload: payload(1) });
    await migrate({ env, stateDir });
    await clearRestartSentinel(env);
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload(2) });

    const result = await migrate({ env, stateDir });

    expect(result.changes).toEqual([
      "Discarded recreated retired restart sentinel JSON using its migration receipt.",
    ]);
    await expect(readRestartSentinel(env)).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("recovers an interrupted claim and finishes the same migration owner", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: payload() });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("preserves changed source bytes and records no receipt", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload(1) });

    const result = await migrate({
      env,
      stateDir,
      beforeVerify: () => {
        fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, payload: payload(2) }));
      },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("changed after migration loaded it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env)).toBeUndefined();
  });

  it("retains a claimed source after cleanup failure and converges on retry", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    const first = await migrate({
      env,
      stateDir,
      removeSource: () => {
        throw new Error("forced cleanup failure");
      },
    });

    expect(first.warnings).toHaveLength(1);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(receipt(env)).toMatchObject({ removed_source: 0 });

    const second = await migrate({ env, stateDir });
    expect(second.warnings).toEqual([]);
    expect(second.changes).toEqual([
      "Discarded recreated retired restart sentinel JSON using its migration receipt.",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt(env)).toMatchObject({ removed_source: 1 });
  });

  it("requires exclusive state ownership before claiming the retired file", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeLegacy(stateDir, { version: 1, payload: payload() });
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_791,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let result: Awaited<ReturnType<typeof migrateLegacyRestartSentinel>>;
    try {
      result = await migrate({ env, stateDir });
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env)).toBeUndefined();
  });

  it("rejects symlinks, hardlinks, and oversized sources without deleting them", async () => {
    const cases = ["symlink", "hardlink", "oversized"] as const;
    for (const sourceKind of cases) {
      closeOpenClawStateDatabaseForTest();
      const { env, stateDir } = useStateDir();
      const sourcePath = path.join(stateDir, "restart-sentinel.json");
      if (sourceKind === "oversized") {
        await fsp.writeFile(sourcePath, Buffer.alloc(4 * 1024 * 1024 + 1));
      } else {
        const targetPath = path.join(stateDir, `${sourceKind}-target.json`);
        await fsp.writeFile(targetPath, JSON.stringify({ version: 1, payload: payload() }));
        if (sourceKind === "symlink") {
          await fsp.symlink(targetPath, sourcePath);
        } else {
          await fsp.link(targetPath, sourcePath);
        }
      }

      const result = await migrate({ env, stateDir });

      expect(result.warnings).toHaveLength(1);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(receipt(env)).toBeUndefined();
    }
  });
});
