// Gateway boot lifecycle tests cover restart-loop breaker accounting.
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
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
  completeGatewayBootLifecycle,
  inspectGatewayCrashLoopBreaker,
  recordGatewayBootStart,
} from "./gateway-boot-lifecycle.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type GatewayBootLifecycleTestDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_boot_lifecycle">;
type GatewayBootLifecycleOutcome = Parameters<typeof completeGatewayBootLifecycle>[1]["outcome"];

const GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3;
const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function createLifecycleDb() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-boot-"));
  const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
  const { db } = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<GatewayBootLifecycleTestDatabase>(db);
  return { env, db, kysely };
}

function insertBootRows(
  params: ReturnType<typeof createLifecycleDb>,
  rows: ReadonlyArray<{
    bootId: string;
    startedAtMs: number;
    completedAtMs?: number | null;
    outcome?: GatewayBootLifecycleOutcome | null;
    startupReason?: string | null;
    reason?: string | null;
  }>,
): void {
  executeSqliteQuerySync(
    params.db,
    params.kysely.insertInto("gateway_boot_lifecycle").values(
      rows.map((row) => ({
        boot_id: row.bootId,
        pid: 1,
        started_at_ms: row.startedAtMs,
        completed_at_ms: row.completedAtMs ?? null,
        outcome: row.outcome ?? null,
        startup_reason: row.startupReason ?? null,
        reason: row.reason ?? null,
      })),
    ),
  );
}

describe("gateway crash-loop breaker", () => {
  it("trips from the persisted unclean boot count", () => {
    const db = createLifecycleDb();
    const nowMs = 1_000_000;
    const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;

    insertBootRows(db, [
      { bootId: "a", startedAtMs: windowStartMs + 1 },
      { bootId: "b", startedAtMs: windowStartMs + 2 },
      {
        bootId: "c",
        startedAtMs: windowStartMs - 60_000,
        completedAtMs: windowStartMs + 3,
        outcome: "startup_failed",
      },
    ]);

    const decision = inspectGatewayCrashLoopBreaker(db.env, nowMs);

    expect(decision).toMatchObject({
      tripped: true,
      uncleanBoots: GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD,
      shouldWriteStabilityBundle: true,
    });
  });

  it("does not count clean, planned, or forced-stop outcomes as unclean", () => {
    const db = createLifecycleDb();
    const nowMs = 1_000_000;
    const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;

    insertBootRows(db, [
      { bootId: "open", startedAtMs: windowStartMs + 1 },
      {
        bootId: "planned",
        startedAtMs: windowStartMs + 2,
        completedAtMs: windowStartMs + 3,
        outcome: "planned_restart",
      },
      {
        bootId: "clean",
        startedAtMs: windowStartMs + 4,
        completedAtMs: windowStartMs + 5,
        outcome: "clean_stop",
      },
      {
        bootId: "forced",
        startedAtMs: windowStartMs + 6,
        completedAtMs: windowStartMs + 7,
        outcome: "forced_stop",
      },
    ]);

    const decision = inspectGatewayCrashLoopBreaker(db.env, nowMs);

    expect(decision.tripped).toBe(false);
    expect(decision.uncleanBoots).toBe(1);
  });

  it("writes the breaker bundle only on a persisted transition into tripped state", () => {
    const db = createLifecycleDb();
    const nowMs = 1_000_000;
    const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;

    insertBootRows(db, [
      {
        bootId: "breaker-marker",
        startedAtMs: windowStartMs + 1,
        startupReason: GATEWAY_CRASH_LOOP_BREAKER_REASON,
      },
      { bootId: "a", startedAtMs: windowStartMs + 2 },
      { bootId: "b", startedAtMs: windowStartMs + 3 },
      { bootId: "c", startedAtMs: windowStartMs + 4 },
    ]);

    const decision = inspectGatewayCrashLoopBreaker(db.env, nowMs);

    expect(decision.tripped).toBe(true);
    expect(decision.shouldWriteStabilityBundle).toBe(false);
  });

  it("logs recovery once after the breaker window drains", () => {
    const db = createLifecycleDb();
    const nowMs = 1_000_000;

    insertBootRows(db, [
      {
        bootId: "breaker-marker",
        startedAtMs: nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS - 1,
        startupReason: GATEWAY_CRASH_LOOP_BREAKER_REASON,
      },
    ]);

    const firstDecision = inspectGatewayCrashLoopBreaker(db.env, nowMs);
    insertBootRows(db, [
      {
        bootId: "recovery-marker",
        startedAtMs: nowMs,
        startupReason: GATEWAY_CRASH_LOOP_RECOVERED_REASON,
      },
    ]);
    const secondDecision = inspectGatewayCrashLoopBreaker(db.env, nowMs + 1);

    expect(firstDecision).toMatchObject({ tripped: false, recovered: true });
    expect(secondDecision).toMatchObject({ tripped: false, recovered: false });
  });

  it("records forced stops without tripping the breaker", () => {
    const db = createLifecycleDb();
    const nowMs = 1_000_000;

    for (let index = 0; index < GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD; index += 1) {
      const bootId = recordGatewayBootStart(db.env, nowMs + index);
      completeGatewayBootLifecycle(
        bootId,
        { outcome: "forced_stop", reason: "gateway.stop_shutdown_timeout" },
        db.env,
        nowMs + index + 1,
      );
    }

    const decision = inspectGatewayCrashLoopBreaker(
      db.env,
      nowMs + GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD + 1,
    );

    expect(decision.tripped).toBe(false);
    expect(decision.uncleanBoots).toBe(0);
  });

  it("prunes boot rows older than retention when recording a new boot", () => {
    const db = createLifecycleDb();
    const nowMs = 2 * GATEWAY_BOOT_LIFECYCLE_RETENTION_MS;

    insertBootRows(db, [
      {
        bootId: "old",
        startedAtMs: nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS - 1,
      },
      {
        bootId: "kept",
        startedAtMs: nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS,
      },
    ]);

    recordGatewayBootStart(db.env, nowMs);

    const rows = executeSqliteQuerySync(
      db.db,
      db.kysely.selectFrom("gateway_boot_lifecycle").select("boot_id").orderBy("boot_id"),
    ).rows.map((row) => row.boot_id);

    expect(rows).toHaveLength(2);
    expect(rows).toContain("kept");
    expect(rows).not.toContain("old");
  });
});
