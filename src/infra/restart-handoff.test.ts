// Covers gateway restart handoff persistence and diagnostics.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  consumeGatewayRestartHandoffSync,
  formatGatewayRestartHandoffDiagnostic,
  readGatewayRestartHandoffSync,
  writeGatewayRestartHandoffSync,
} from "./restart-handoff.js";
import type { GatewayRestartHandoff } from "./restart-handoff.js";

const tempDirs: string[] = [];
type GatewayRestartHandoffDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_handoff">;

function createHandoffEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-handoff-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
  };
}

function legacyHandoffPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "gateway-supervisor-restart-handoff.json");
}

function readHandoffRow(env: NodeJS.ProcessEnv) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_handoff")
      .select([
        "handoff_key",
        "kind",
        "version",
        "intent_id",
        "pid",
        "process_instance_id",
        "created_at",
        "expires_at",
        "reason",
        "restart_trace_started_at",
        "restart_trace_last_at",
        "source",
        "restart_kind",
        "supervisor_mode",
      ])
      .where("handoff_key", "=", "current"),
  );
}

function insertHandoffRow(
  env: NodeJS.ProcessEnv,
  values: {
    kind?: string;
    version?: number;
    intentId?: string;
    pid?: number;
    createdAt?: number;
    expiresAt?: number;
    reason?: string | null;
    source?: string;
    restartKind?: string;
    supervisorMode?: string;
    restartTraceStartedAt?: number | null;
    restartTraceLastAt?: number | null;
  },
) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartHandoffDatabase>(db);
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_handoff").values({
      handoff_key: "current",
      kind: values.kind ?? "gateway-supervisor-restart-handoff",
      version: values.version ?? 1,
      intent_id: values.intentId ?? "intent-1",
      pid: values.pid ?? 111,
      process_instance_id: null,
      created_at: values.createdAt ?? 1_000,
      expires_at: values.expiresAt ?? 61_000,
      reason: values.reason ?? null,
      restart_trace_started_at: values.restartTraceStartedAt ?? null,
      restart_trace_last_at: values.restartTraceLastAt ?? null,
      source: values.source ?? "plugin-change",
      restart_kind: values.restartKind ?? "full-process",
      supervisor_mode: values.supervisorMode ?? "external",
      updated_at_ms: now,
    }),
  );
}

function expectWrittenHandoff(
  opts: Parameters<typeof writeGatewayRestartHandoffSync>[0],
): GatewayRestartHandoff {
  const handoff = writeGatewayRestartHandoffSync(opts);
  if (handoff === null) {
    throw new Error("Expected gateway restart handoff to be written");
  }
  return handoff;
}

function spawnHandoffConsumer(params: {
  env: NodeJS.ProcessEnv;
  expectedPid: number;
  now: number;
  startFile: string;
}): Promise<unknown> {
  const moduleUrl = new URL("./restart-handoff.ts", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    while (!fs.existsSync(process.env.OPENCLAW_HANDOFF_TEST_START_FILE)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const mod = await import(process.env.OPENCLAW_HANDOFF_TEST_MODULE_URL);
    const result = mod.consumeGatewayRestartHandoffSync({
      expectedPid: Number(process.env.OPENCLAW_HANDOFF_TEST_EXPECTED_PID),
      now: Number(process.env.OPENCLAW_HANDOFF_TEST_NOW),
      env: process.env,
    });
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          ...params.env,
          OPENCLAW_HANDOFF_TEST_EXPECTED_PID: String(params.expectedPid),
          OPENCLAW_HANDOFF_TEST_MODULE_URL: moduleUrl,
          OPENCLAW_HANDOFF_TEST_NOW: String(params.now),
          OPENCLAW_HANDOFF_TEST_START_FILE: params.startFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error("handoff consumer timed out"));
    }, 10_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`handoff consumer exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`invalid handoff consumer output: ${stdout}`, { cause: err }));
      }
    });
  });
}

describe("gateway restart handoff", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps truncated restart reasons free of lone surrogates", () => {
    const env = createHandoffEnv();
    const handoff = expectWrittenHandoff({
      env,
      pid: 1,
      reason: `${"a".repeat(199)}😀tail`,
      restartKind: "full-process",
      supervisorMode: "external",
    });

    expect(handoff.reason).toHaveLength(199);
    expect(Buffer.from(handoff.reason ?? "").toString()).toBe(handoff.reason);
    expect(readGatewayRestartHandoffSync(env)?.reason).toBe(handoff.reason);
  });

  it("formats a concise, single-line diagnostic", () => {
    expect(
      formatGatewayRestartHandoffDiagnostic(
        {
          kind: "gateway-supervisor-restart-handoff",
          version: 1,
          intentId: "intent-1",
          pid: 12_345,
          createdAt: 10_000,
          expiresAt: 70_000,
          reason: "ok\nFake: bad",
          source: "operator-restart",
          restartKind: "full-process",
          supervisorMode: "external",
        },
        12_500,
      ),
    ).toBe(
      "Recent restart handoff: full-process via external; source=operator-restart; reason=ok Fake: bad; pid=12345; age=2s; expiresIn=57s",
    );
  });

  it("keeps persisted intent IDs free of lone surrogates", () => {
    const env = createHandoffEnv();
    const expectedIntentId = "a".repeat(119);
    insertHandoffRow(env, {
      intentId: ` ${expectedIntentId}😀tail `,
      createdAt: 1_000,
      expiresAt: 61_000,
    });

    const handoff = readGatewayRestartHandoffSync(env, 1_500);

    expect(handoff?.intentId).toBe(expectedIntentId);
    expect(Buffer.from(handoff?.intentId ?? "").toString()).toBe(handoff?.intentId);
  });

  it("persists restart trace timing for supervised process handoff", () => {
    const env = createHandoffEnv();

    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
      restartTrace: {
        startedAt: 10_000,
        lastAt: 10_250,
      },
    });

    expect(handoff.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 10_250,
    });
    expect(readGatewayRestartHandoffSync(env, 1_500)?.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 10_250,
    });
  });

  it("keeps restart trace timing for slow but valid drains", () => {
    const env = createHandoffEnv();

    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
      restartTrace: {
        startedAt: 10_000,
        lastAt: 310_000,
      },
    });

    expect(handoff.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 310_000,
    });
    expect(readGatewayRestartHandoffSync(env, 1_500)?.restartTrace).toStrictEqual({
      startedAt: 10_000,
      lastAt: 310_000,
    });
  });

  it("rejects malformed handoff payloads", () => {
    const env = createHandoffEnv();

    insertHandoffRow(env, { intentId: "bad", source: "bad-source" });

    expect(readGatewayRestartHandoffSync(env, 1_001)).toBeNull();
  });

  it("rejects expired handoff rows", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 111,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
      ttlMs: 1_000,
    });
    expect(readGatewayRestartHandoffSync(env, 2_000)).toBeNull();
  });

  it("rejects persisted handoffs with a ttl longer than the supported window", () => {
    const env = createHandoffEnv();

    insertHandoffRow(env, { intentId: "too-long", createdAt: 1_000, expiresAt: 61_001 });

    expect(readGatewayRestartHandoffSync(env, 1_001)).toBeNull();
  });

  it("overwrites the previous pending handoff row", () => {
    const env = createHandoffEnv();

    expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "external",
    });
    expectWrittenHandoff({
      env,
      pid: 67_890,
      reason: "gateway.restart",
      restartKind: "update-process",
      supervisorMode: "systemd",
    });

    expect(readHandoffRow(env)).toMatchObject({
      handoff_key: "current",
      pid: 67_890,
      reason: "gateway.restart",
      source: "operator-restart",
      restart_kind: "update-process",
      supervisor_mode: "systemd",
    });
    expect(readGatewayRestartHandoffSync(env)?.pid).toBe(67_890);
    expect(fs.existsSync(legacyHandoffPath(env))).toBe(false);
  });

  it("atomically accepts and removes a matching handoff", () => {
    const env = createHandoffEnv();
    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      reason: "gateway.restart",
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
    });

    expect(
      consumeGatewayRestartHandoffSync({
        env,
        expectedPid: 12_345,
        now: 1_500,
      }),
    ).toStrictEqual({
      status: "accepted",
      handoff,
    });
    expect(readHandoffRow(env)).toBeUndefined();
    expect(
      consumeGatewayRestartHandoffSync({
        env,
        expectedPid: 12_345,
        now: 1_500,
      }),
    ).toStrictEqual({
      status: "none",
      reason: "missing",
    });
  });

  it("retains a PID-mismatched handoff for the matching consumer", () => {
    const env = createHandoffEnv();
    expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
    });

    expect(
      consumeGatewayRestartHandoffSync({
        env,
        expectedPid: 54_321,
        now: 1_500,
      }),
    ).toStrictEqual({
      status: "rejected",
      reason: "pid-mismatch",
      handoffPid: 12_345,
    });
    expect(readHandoffRow(env)?.pid).toBe(12_345);
    expect(
      consumeGatewayRestartHandoffSync({
        env,
        expectedPid: 12_345,
        now: 1_500,
      }),
    ).toMatchObject({
      status: "accepted",
      handoff: { pid: 12_345 },
    });
  });

  it.each([
    {
      name: "expired",
      insert: (env: NodeJS.ProcessEnv) =>
        expectWrittenHandoff({
          env,
          pid: 12_345,
          restartKind: "full-process",
          supervisorMode: "external",
          createdAt: 1_000,
          ttlMs: 1_000,
        }),
      now: 2_000,
      expected: {
        status: "rejected",
        reason: "expired",
        handoffPid: 12_345,
      },
    },
    {
      name: "malformed",
      insert: (env: NodeJS.ProcessEnv) =>
        insertHandoffRow(env, {
          pid: 12_345,
          source: "invalid-source",
          createdAt: 1_000,
          expiresAt: 61_000,
        }),
      now: 1_500,
      expected: {
        status: "rejected",
        reason: "invalid",
      },
    },
    {
      name: "future-dated",
      insert: (env: NodeJS.ProcessEnv) =>
        expectWrittenHandoff({
          env,
          pid: 12_345,
          restartKind: "full-process",
          supervisorMode: "external",
          createdAt: 2_000,
        }),
      now: 1_500,
      expected: {
        status: "rejected",
        reason: "invalid",
      },
    },
  ])("removes a $name handoff after rejecting it", ({ insert, now, expected }) => {
    const env = createHandoffEnv();
    insert(env);

    expect(
      consumeGatewayRestartHandoffSync({
        env,
        expectedPid: 12_345,
        now,
      }),
    ).toStrictEqual(expected);
    expect(readHandoffRow(env)).toBeUndefined();
  });

  it("accepts a handoff exactly once across concurrent consumers", async () => {
    const env = createHandoffEnv();
    expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
    });
    closeOpenClawStateDatabaseForTest();
    const startFile = path.join(env.OPENCLAW_STATE_DIR ?? "", "start-consumers");

    const first = spawnHandoffConsumer({
      env,
      expectedPid: 12_345,
      now: 1_500,
      startFile,
    });
    const second = spawnHandoffConsumer({
      env,
      expectedPid: 12_345,
      now: 1_500,
      startFile,
    });
    fs.writeFileSync(startFile, "start", "utf8");

    const results = await Promise.all([first, second]);
    expect(
      results
        .map((result) => (result as { status?: string }).status)
        .toSorted((a, b) => String(a).localeCompare(String(b))),
    ).toStrictEqual(["accepted", "none"]);
    expect(readHandoffRow(env)).toBeUndefined();
  });

  it("samples the default time after beginning the write transaction", () => {
    const env = createHandoffEnv();
    expectWrittenHandoff({
      env,
      pid: 12_345,
      restartKind: "full-process",
      supervisorMode: "external",
      createdAt: 1_000,
      ttlMs: 1_000,
    });
    const { db } = openOpenClawStateDatabase({ env });
    const originalExec = db.exec.bind(db);
    let transactionBegan = false;
    const execSpy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        transactionBegan = true;
      }
      return originalExec(sql);
    });
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (transactionBegan ? 2_000 : 1_500));

    try {
      expect(
        consumeGatewayRestartHandoffSync({
          env,
          expectedPid: 12_345,
        }),
      ).toStrictEqual({
        status: "rejected",
        reason: "expired",
        handoffPid: 12_345,
      });
    } finally {
      nowSpy.mockRestore();
      execSpy.mockRestore();
    }

    expect(readHandoffRow(env)).toBeUndefined();
  });
});
