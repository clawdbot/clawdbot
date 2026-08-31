// Covers Doctor-only import of the retired exec approvals JSON file.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolveExecApprovalsPath } from "./exec-approvals-config.js";
import { ExecApprovalsMigrationRequiredError } from "./exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { loadExecApprovals } from "./exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "./exec-approvals-store.test-support.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "./state-migrations.exec-approvals.js";

type MigrationDatabase = Pick<OpenClawStateKyselyDatabase, "migration_runs" | "migration_sources">;

describe("legacy exec approvals migration", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      envSnapshot.restore();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string; sourcePath: string } {
    const stateDir = tempDirs.make("openclaw-exec-approvals-migration-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    return { env, stateDir, sourcePath: resolveExecApprovalsPath(env) };
  }

  async function writeLegacy(sourcePath: string, value: unknown): Promise<string> {
    await fsp.writeFile(sourcePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return sourcePath;
  }

  async function migrate(params: {
    env: NodeJS.ProcessEnv;
    stateDir: string;
    beforeClaim?: () => void;
    beforeVerify?: () => void;
    removeSource?: (sourcePath: string) => Promise<void> | void;
  }) {
    return await migrateLegacyExecApprovals({
      detected: detectLegacyExecApprovals({
        stateDir: params.stateDir,
        doctorOnlyStateMigrations: true,
      }),
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
        .where("migration_kind", "=", "legacy-exec-approvals-json"),
    );
  }

  function runReceipt(env: NodeJS.ProcessEnv) {
    const db = database(env);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_runs")
        .selectAll()
        .where("id", "like", "exec-approvals-json:%"),
    );
  }

  it("detects source and claim only for Doctor-owned migration", async () => {
    const { stateDir, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, { version: 1, agents: {} });
    expect(detectLegacyExecApprovals({ stateDir }).hasLegacy).toBe(false);
    expect(detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
      true,
    );

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
      true,
    );
  });

  it.each([
    { name: "absent", usage: {} },
    { name: "historical null", usage: { lastUsedAt: null, lastUsedCommand: null } },
  ])("imports $name usage metadata and releases the runtime gate", async ({ usage }) => {
    const { env, stateDir, sourcePath } = useStateDir();
    const expected = {
      version: 1 as const,
      socket: { path: "/tmp/approvals.sock", token: "secret" },
      defaults: { security: "allowlist" as const, ask: "on-miss" as const },
      agents: {
        main: { allowlist: [{ pattern: "/usr/bin/rg", ...usage }] },
        "*": {
          allowlist: [
            { pattern: "/usr/bin/unused", ...usage },
            { pattern: "/usr/bin/used", lastUsedAt: 0, lastUsedCommand: "" },
          ],
        },
      },
    };
    await writeLegacy(sourcePath, expected);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    execApprovalsStoreTesting.reset();
    expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Imported legacy exec approvals into shared SQLite state."]);
    expect(result.notices).toEqual([
      "Removed retired exec approvals JSON after recording its migration decision.",
    ]);
    const imported = loadExecApprovals();
    expect(imported.defaults).toMatchObject(expected.defaults);
    expect(imported.socket).toEqual(expected.socket);
    expect(imported.agents?.main?.allowlist).toEqual([
      { id: expect.any(String), pattern: "/usr/bin/rg" },
    ]);
    expect(imported.agents?.["*"]?.allowlist).toEqual([
      { id: expect.any(String), pattern: "/usr/bin/unused" },
      { id: expect.any(String), pattern: "/usr/bin/used", lastUsedAt: 0, lastUsedCommand: "" },
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt(env)).toMatchObject({
      removed_source: 1,
      source_record_count: 1,
      status: "completed",
      target_table: "exec_approvals_config",
    });
    expect(runReceipt(env)).toMatchObject({ status: "completed" });
  });

  it("is idempotent after successful source removal", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, { version: 1, agents: {} });
    await migrate({ env, stateDir });

    await expect(migrate({ env, stateDir })).resolves.toEqual({ changes: [], warnings: [] });
    expect(receipt(env)).toMatchObject({ removed_source: 1 });
  });

  function legacyWithInvalidEntry(entry: unknown, agentKey = "private-marker-agent"): string {
    return JSON.stringify({
      version: 1,
      socket: { path: "/private-marker/socket", token: "private-marker-token" },
      agents: {
        first: { allowlist: ["/usr/bin/true"] },
        [agentKey]: { allowlist: ["/usr/bin/true", entry] },
        third: { security: "deny" },
      },
    });
  }

  it.each([
    {
      name: "metadata in the second agent's second entry",
      raw: legacyWithInvalidEntry({
        pattern: "/private-marker/pattern",
        id: "private-marker-id",
        commandText: "private-marker-command",
        lastUsedAt: "private-marker-time",
        lastUsedCommand: null,
      }),
      problem: "agents entry #2.allowlist[1].lastUsedAt: expected a finite number",
    },
    ...[
      { metadata: { lastUsedAt: null, lastUsedCommand: 42 }, field: "lastUsedCommand" },
      { metadata: { lastUsedAt: null, argPattern: null }, field: "argPattern" },
      { metadata: { lastUsedCommand: null, lastResolvedPath: null }, field: "lastResolvedPath" },
    ].map(({ metadata, field }) => ({
      name: `invalid ${field} alongside historical null usage`,
      raw: legacyWithInvalidEntry({ pattern: "private-marker-pattern", ...metadata }),
      problem: `agents entry #2.allowlist[1].${field}: expected a string`,
    })),
    {
      name: "null policy alongside historical null usage",
      raw: JSON.stringify({
        version: 1,
        defaults: { security: null },
        agents: { main: { allowlist: [{ pattern: "private-marker", lastUsedAt: null }] } },
      }),
      problem: "defaults.security: expected a supported value",
    },
    {
      name: "hostile long keys, values, and multiple failures",
      raw: legacyWithInvalidEntry(
        {
          pattern: "/private-marker/pattern",
          lastUsedAt: { ["private-marker-value".repeat(1_000)]: "private-marker" },
          lastUsedCommand: 42,
        },
        "private-marker-\n\u001b[31m".repeat(1_000),
      ),
      problem: "agents entry #2.allowlist[1].lastUsedAt: expected a finite number",
    },
    {
      name: "numeric-like agent key enumeration",
      raw: '{"version":1,"agents":{"20":{},"3":{"security":"private-marker"}}}',
      problem: "agents entry #1.security: expected a supported value",
    },
    {
      name: "policy",
      raw: JSON.stringify({ version: 1, defaults: { security: "private-marker" } }),
      problem: "defaults.security: expected a supported value",
    },
    {
      name: "socket token",
      raw: JSON.stringify({ version: 1, socket: { token: { "private-marker": true } } }),
      problem: "socket.token: expected a string",
    },
    {
      name: "whole entry shape",
      raw: legacyWithInvalidEntry(42),
      problem:
        "agents entry #2.allowlist[1]: expected a non-empty string or an object with a non-empty pattern",
    },
    {
      name: "blank string entry",
      raw: legacyWithInvalidEntry("  "),
      problem: "agents entry #2.allowlist[1]: expected a non-empty string",
    },
    {
      name: "blank object pattern without a union wrapper",
      raw: legacyWithInvalidEntry({ pattern: "  " }),
      problem: "agents entry #2.allowlist[1].pattern: expected a non-empty string",
    },
    {
      name: "JSON syntax",
      raw: "{malformed-private-marker",
      problem: "invalid JSON syntax",
    },
    {
      name: "UTF-8 encoding",
      raw: Buffer.concat([Buffer.from("private-marker"), Buffer.from([0xff])]),
      problem: "invalid UTF-8 encoding",
    },
  ])(
    "diagnoses $name while preserving bytes and a non-removal receipt",
    async ({ raw, problem }) => {
      const { env, stateDir, sourcePath } = useStateDir();
      const original = Buffer.from(raw);
      await fsp.writeFile(sourcePath, original);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);

      const result = await migrate({ env, stateDir });

      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        `Preserved malformed legacy exec approvals for operator recovery. First problem: ${problem}. Repair exec-approvals.json locally, then rerun \`openclaw doctor --fix\` with the same OPENCLAW_STATE_DIR.`,
      ]);
      expect(result.warnings[0]?.length).toBeLessThan(400);
      expect(JSON.stringify(result)).not.toContain("private-marker");
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
      const sourceReceipt = receipt(env);
      expect(sourceReceipt).toMatchObject({
        removed_source: 0,
        source_record_count: 0,
        status: "completed",
        source_size_bytes: original.length,
      });
      const report = {
        source: "legacy-exec-approvals-json",
        target: "exec_approvals_config",
        decision: "malformed-legacy-preserved",
        sourceSha256: createHash("sha256").update(original).digest("hex"),
        sourceValid: false,
        importedRecordCount: 0,
        preservedSqliteRecordCount: 0,
        removesSource: false,
      };
      expect(JSON.parse(sourceReceipt?.report_json ?? "null")).toEqual(report);
      expect(JSON.parse(runReceipt(env)?.report_json ?? "null")).toEqual(report);
      expect(JSON.stringify([sourceReceipt, runReceipt(env)])).not.toContain("private-marker");
      expect(readExecApprovalsConfigRow(database(env))).toBeUndefined();
      expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);
      expect(await migrate({ env, stateDir })).toEqual(result);
      expect(fs.readFileSync(sourcePath)).toEqual(original);
      expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);
    },
  );

  it("removes a byte-identical source when canonical state already exists", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    const file = { version: 1 as const, defaults: { security: "deny" as const }, agents: {} };
    const raw = serializeExecApprovals(file);
    writeExecApprovalsConfigRow({ db: database(env), file, raw });
    await fsp.writeFile(sourcePath, raw, "utf8");

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Preserved byte-identical canonical SQLite exec approvals."]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipt(env)).toMatchObject({ removed_source: 1 });
  });

  it("preserves conflicting legacy bytes while canonical SQLite wins", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    const canonical = {
      version: 1 as const,
      defaults: { security: "deny" as const },
      agents: {},
    };
    writeExecApprovalsConfigRow({ db: database(env), file: canonical });
    await writeLegacy(sourcePath, {
      version: 1,
      defaults: { security: "full" },
      agents: {},
    });

    const result = await migrate({ env, stateDir });

    expect(result.changes).toEqual([]);
    expect(result.warnings[0]).toContain("retained conflicting legacy JSON");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(readExecApprovalsConfigRow(database(env))?.raw_json).toBe(
      serializeExecApprovals(canonical),
    );
    expect(receipt(env)).toMatchObject({ removed_source: 0 });
  });

  it("repairs an invalid canonical row from validated legacy policy", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    const db = database(env);
    db.prepare(
      "INSERT INTO exec_approvals_config (config_key, raw_json, socket_path, has_socket_token, default_security, default_ask, default_ask_fallback, auto_allow_skills, agent_count, allowlist_count, updated_at_ms) VALUES ('current', '{invalid', NULL, 0, NULL, NULL, NULL, NULL, 0, 0, 1)",
    ).run();
    await writeLegacy(sourcePath, { version: 1, defaults: { security: "deny" }, agents: {} });

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Replaced an invalid SQLite exec approvals row with validated legacy state.",
    ]);
    expect(readExecApprovalsConfigRow(db)?.raw_json).toContain('"security": "deny"');
  });

  it("recovers an interrupted claim and completes import", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, { version: 1, agents: {} });
    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);

    const result = await migrate({ env, stateDir });

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(readExecApprovalsConfigRow(database(env))).toBeDefined();
  });

  it("preserves changed source bytes before claim and writes no receipt", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, { version: 1, agents: {} });

    const result = await migrate({
      env,
      stateDir,
      beforeVerify: () => {
        fs.writeFileSync(
          sourcePath,
          serializeExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} }),
        );
      },
    });

    expect(result.warnings[0]).toContain("changed after migration loaded");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env)).toBeUndefined();
  });

  it("retains the null-metadata source claim after cleanup failure and converges on retry", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, {
      version: 1,
      agents: { main: { allowlist: [{ pattern: "/usr/bin/rg", lastUsedAt: null }] } },
    });
    const first = await migrate({
      env,
      stateDir,
      removeSource: () => {
        throw new Error("forced cleanup failure");
      },
    });
    expect(first.warnings[0]).toContain("cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(receipt(env)).toMatchObject({ removed_source: 0 });

    const second = await migrate({ env, stateDir });
    expect(second.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt(env)).toMatchObject({ removed_source: 1 });
  });

  it("requires exclusive state ownership and prints the stop-Gateway warning", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, { version: 1, agents: {} });
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
    let result: Awaited<ReturnType<typeof migrateLegacyExecApprovals>>;
    try {
      result = await migrate({ env, stateDir });
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings[0]).toContain("Stop the Gateway");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(receipt(env)).toBeUndefined();
  });

  it("keeps store APIs blocked until Doctor completes the import", async () => {
    const { env, stateDir, sourcePath } = useStateDir();
    await writeLegacy(sourcePath, { version: 1, defaults: { security: "deny" }, agents: {} });
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    execApprovalsStoreTesting.reset();
    expect(() => loadExecApprovals()).toThrow(ExecApprovalsMigrationRequiredError);

    const result = await migrate({ env, stateDir });
    expect(result.warnings).toEqual([]);
    expect(loadExecApprovals().defaults?.security).toBe("deny");
  });
});
