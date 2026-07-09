// Covers gateway restart handoff persistence and diagnostics.
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
  formatGatewayRestartHandoffDiagnostic,
  GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
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
      kind: values.kind ?? GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
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

describe("gateway restart handoff", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("writes a supervisor handoff for an exited gateway process", () => {
    const env = createHandoffEnv();

    const handoff = expectWrittenHandoff({
      env,
      pid: 12_345,
      processInstanceId: "gateway-instance-1",
      reason: "plugin source changed",
      restartKind: "full-process",
      supervisorMode: "launchd",
      createdAt: 1_000,
    });

    expect(handoff.kind).toBe(GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND);
    expect(handoff.version).toBe(1);
    expect(handoff.pid).toBe(12_345);
    expect(handoff.processInstanceId).toBe("gateway-instance-1");
    expect(handoff.reason).toBe("plugin source changed");
    expect(handoff.source).toBe("plugin-change");
    expect(handoff.restartKind).toBe("full-process");
    expect(handoff.supervisorMode).toBe("launchd");
    expect(handoff.createdAt).toBe(1_000);
    expect(handoff.expiresAt).toBe(61_000);
    expect(readHandoffRow(env)).toMatchObject({
      handoff_key: "current",
      kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
      pid: 12_345,
      reason: "plugin source changed",
      source: "plugin-change",
      restart_kind: "full-process",
      supervisor_mode: "launchd",
    });
    expect(fs.existsSync(legacyHandoffPath(env))).toBe(false);
    const persisted = readGatewayRestartHandoffSync(env, 1_500);
    expect(persisted?.pid).toBe(12_345);
    expect(persisted?.reason).toBe("plugin source changed");
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
    expect(readGatewayRestartHandoffSync(env, 2_001)).toBeNull();
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

  it("formats a concise diagnostic line for status surfaces", () => {
    expect(
      formatGatewayRestartHandoffDiagnostic(
        {
          kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
          version: 1,
          intentId: "intent-1",
          pid: 12_345,
          createdAt: 10_000,
          expiresAt: 70_000,
          reason: "plugin source changed",
          source: "plugin-change",
          restartKind: "full-process",
          supervisorMode: "launchd",
        },
        12_500,
      ),
    ).toBe(
      "Recent restart handoff: full-process via launchd; source=plugin-change; reason=plugin source changed; pid=12345; age=2s; expiresIn=57s",
    );
  });

  it("formats restart reasons as a single diagnostic line", () => {
    expect(
      formatGatewayRestartHandoffDiagnostic(
        {
          kind: GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND,
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
});
