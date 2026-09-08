// Gateway boot lifecycle tests cover restart-loop breaker accounting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
  completeGatewayBootLifecycle,
  formatGatewayCrashLoopManualChannelStartHint,
  inspectGatewayCrashLoopBreaker,
  recordGatewayBootStart,
  recordGatewayCrashLoopRecovery,
  repairGatewayMaintenanceStartupFailures,
} from "./gateway-boot-lifecycle.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type GatewayBootLifecycleTestDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_boot_lifecycle">;
type GatewayBootLifecycleOutcome = Parameters<typeof completeGatewayBootLifecycle>[1]["outcome"];

const GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3;
const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;

const tempDirs = createTempDirTracker();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  vi.unstubAllEnvs();
});

function createLifecycleDb() {
  const stateDir = tempDirs.make("openclaw-gateway-boot-");
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

  it("does not count maintenance refusals toward channel suppression", () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    for (let index = 0; index < 3; index++) {
      const bootId = recordGatewayBootStart(lifecycle.env, nowMs + index);
      completeGatewayBootLifecycle(
        bootId,
        {
          outcome: "startup_failed",
          startupReason: "gateway.maintenance_required",
          reason: "Legacy workspace setup state requires migration",
        },
        lifecycle.env,
        nowMs + index + 1,
      );
    }
    expect(inspectGatewayCrashLoopBreaker(lifecycle.env, nowMs + 4)).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
    });
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

  it("records a fresh lifecycle segment before recovered channel startup", () => {
    const db = createLifecycleDb();
    const nowMs = 1_000_000;
    const safeModeBootId = recordGatewayBootStart(
      db.env,
      nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS - 1,
      GATEWAY_CRASH_LOOP_BREAKER_REASON,
    );

    expect(inspectGatewayCrashLoopBreaker(db.env, nowMs)).toMatchObject({
      recovered: true,
      uncleanBoots: 0,
    });

    const recoveredBootId = recordGatewayCrashLoopRecovery(safeModeBootId, db.env, nowMs);

    expect(recoveredBootId).toBeDefined();
    expect(
      executeSqliteQuerySync(
        db.db,
        db.kysely
          .selectFrom("gateway_boot_lifecycle")
          .select(["boot_id", "completed_at_ms", "outcome", "startup_reason"])
          .orderBy("started_at_ms"),
      ).rows,
    ).toEqual([
      {
        boot_id: safeModeBootId,
        completed_at_ms: nowMs,
        outcome: "safe_mode_stable",
        startup_reason: GATEWAY_CRASH_LOOP_BREAKER_REASON,
      },
      {
        boot_id: recoveredBootId,
        completed_at_ms: null,
        outcome: null,
        startup_reason: GATEWAY_CRASH_LOOP_RECOVERED_REASON,
      },
    ]);
    expect(inspectGatewayCrashLoopBreaker(db.env, nowMs + 1)).toMatchObject({
      recovered: false,
      uncleanBoots: 1,
    });
    insertBootRows(db, [
      { bootId: "post-recovery-crash-a", startedAtMs: nowMs + 2 },
      { bootId: "post-recovery-crash-b", startedAtMs: nowMs + 3 },
    ]);
    expect(inspectGatewayCrashLoopBreaker(db.env, nowMs + 4)).toMatchObject({
      tripped: true,
      uncleanBoots: GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD,
    });
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

  it("repairs maintenance history without clearing real startup crashes", () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    insertBootRows(lifecycle, [
      ...["gateway.maintenance_required", "gateway.agent_media_migration_required"].map(
        (startupReason, index) => ({
          bootId: `maintenance-${index}`,
          startedAtMs: nowMs - 2,
          completedAtMs: nowMs - 1,
          outcome: "startup_failed" as const,
          startupReason,
        }),
      ),
      {
        bootId: "unrelated",
        startedAtMs: nowMs - 1,
        completedAtMs: nowMs,
        outcome: "startup_failed",
        reason: "EADDRINUSE",
      },
    ]);
    expect(repairGatewayMaintenanceStartupFailures(lifecycle.env)).toBe(2);
    expect(repairGatewayMaintenanceStartupFailures(lifecycle.env)).toBe(0);
    expect(inspectGatewayCrashLoopBreaker(lifecycle.env, nowMs + 1)).toMatchObject({
      tripped: false,
      uncleanBoots: 1,
    });
    const rows = executeSqliteQuerySync(
      lifecycle.db,
      lifecycle.kysely
        .selectFrom("gateway_boot_lifecycle")
        .select(["boot_id", "outcome"])
        .orderBy("boot_id"),
    ).rows;
    expect(rows).toEqual([
      { boot_id: "maintenance-0", outcome: "startup_failure_repaired" },
      { boot_id: "maintenance-1", outcome: "startup_failure_repaired" },
      { boot_id: "unrelated", outcome: "startup_failed" },
    ]);
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

describe("formatGatewayCrashLoopManualChannelStartHint", () => {
  it("uses a placeholder when no channel is known", () => {
    expect(formatGatewayCrashLoopManualChannelStartHint()).toContain(
      `--params '{"channel":"<id>"}'`,
    );
  });

  it("names the channel being suppressed", () => {
    expect(formatGatewayCrashLoopManualChannelStartHint({ channelId: "telegram" })).toContain(
      `--params '{"channel":"telegram"}'`,
    );
  });

  // Suppression is reported per account; omitting accountId would tell operators to run a command
  // that starts the channel's default account instead of the one the warning named.
  it("carries the account when suppression is account-scoped", () => {
    expect(
      formatGatewayCrashLoopManualChannelStartHint({ channelId: "telegram", accountId: "work" }),
    ).toContain(`--params '{"channel":"telegram","accountId":"work"}'`);
  });

  it.each([
    { name: "default", profile: "", container: "", command: "openclaw" },
    { name: "named profile", profile: "work", container: "", command: "openclaw --profile work" },
    { name: "container", profile: "", container: "demo", command: "openclaw --container demo" },
    {
      name: "container and profile",
      profile: "work",
      container: "demo",
      command: "openclaw --container demo",
    },
  ])("targets the active gateway for $name", ({ profile, container, command }) => {
    vi.stubEnv("OPENCLAW_PROFILE", profile);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);

    expect(
      formatGatewayCrashLoopManualChannelStartHint({ channelId: "telegram", accountId: "work" }),
    ).toBe(
      `Start a channel manually with: ${command} gateway call channels.start --params '{"channel":"telegram","accountId":"work"}'`,
    );
  });
});
