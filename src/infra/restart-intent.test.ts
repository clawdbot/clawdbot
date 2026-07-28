// Covers gateway restart intent persistence and consumption.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewayRestartIntentSync,
  writeGatewayRestartIntentSync,
} from "./restart-intent.js";

const tempDirs: string[] = [];
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

function createIntentEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-intent-"));
  tempDirs.push(dir);
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
  };
}

function legacyIntentPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "gateway-restart-intent.json");
}

function readIntentRow(env: NodeJS.ProcessEnv) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_intent")
      .select(["intent_key", "kind", "pid", "created_at", "reason", "force", "wait_ms"])
      .where("intent_key", "=", "gateway-restart"),
  );
}

function insertIntentRow(
  env: NodeJS.ProcessEnv,
  values: {
    kind?: string;
    pid?: number;
    createdAt?: number;
    reason?: string | null;
    force?: number | null;
    waitMs?: number | null;
  },
) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_intent").values({
      intent_key: "gateway-restart",
      kind: values.kind ?? "gateway-restart",
      pid: values.pid ?? process.pid,
      created_at: values.createdAt ?? now,
      reason: values.reason ?? null,
      force: values.force ?? null,
      wait_ms: values.waitMs ?? null,
      updated_at_ms: now,
    }),
  );
}

describe("gateway restart intent", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("consumes a fresh intent for the current process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(true);
    expect(readIntentRow(env)).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath(env))).toBe(false);
  });

  it("rejects an intent for a different process", () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid + 1 })).toBe(true);

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(readIntentRow(env)).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath(env))).toBe(false);
  });

  it("rejects expired intents before restart", () => {
    const env = createIntentEnv();
    insertIntentRow(env, { createdAt: Date.now() - 120_000 });

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(readIntentRow(env)).toBeUndefined();
  });

  it("drops malformed intent rows before restart", () => {
    const env = createIntentEnv();
    insertIntentRow(env, { kind: "bad-intent" });

    expect(consumeGatewayRestartIntentSync(env)).toBe(false);
    expect(readIntentRow(env)).toBeUndefined();
  });

  it("round-trips restart reason, force, and wait options", () => {
    const env = createIntentEnv();

    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        reason: "gateway.restart",
        intent: { force: true, waitMs: 12_345 },
      }),
    ).toBe(true);

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({
      reason: "gateway.restart",
      force: true,
      waitMs: 12_345,
    });
    expect(readIntentRow(env)).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath(env))).toBe(false);
  });

  it("backs off before an emoji that crosses the persisted reason limit", () => {
    const env = createIntentEnv();
    insertIntentRow(env, { reason: "x".repeat(199) + "🧠tail" });

    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({
      reason: "x".repeat(199),
    });
  });

  it("overwrites the previous pending intent row", () => {
    const env = createIntentEnv();
    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid + 1,
        reason: "first",
      }),
    ).toBe(true);
    expect(
      writeGatewayRestartIntentSync({
        env,
        targetPid: process.pid,
        reason: "second",
      }),
    ).toBe(true);

    expect(readIntentRow(env)).toMatchObject({
      intent_key: "gateway-restart",
      kind: "gateway-restart",
      pid: process.pid,
      reason: "second",
    });
    expect(consumeGatewayRestartIntentPayloadSync(env)).toEqual({ reason: "second" });
  });
});
