// Persists gateway boot outcomes for supervisor crash-loop decisions.
import { randomUUID } from "node:crypto";
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { pathMayExistSync } from "./path-existence.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "./startup-maintenance-required.js";

// Retain the released media-only tag while its bounded boot history expires.
const maintenanceStartupReasons = [
  GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON,
  "gateway.agent_media_migration_required",
];

// Supervisors usually restart immediately. Three unclean boots in this window
// means the gateway should come up without auto-start sidecars so operators
// can inspect a stable process instead of a flap.
const GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3;
const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
// Keep enough history for operator forensics while bounding lifecycle-segment
// growth. Retention must comfortably exceed GATEWAY_BOOT_LOOP_WINDOW_MS.
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;
export const GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS = 500;
export const GATEWAY_CRASH_LOOP_BREAKER_REASON = "gateway.crash_loop_breaker";
export const GATEWAY_CRASH_LOOP_RECOVERED_REASON = "gateway.crash_loop_recovered";
/**
 * The breaker only self-clears after the full window drains. Operator surfaces name the manual
 * override command, not the internal RPC. Account hints carry accountId to avoid starting a
 * different default account than the warning named.
 */
export function formatGatewayCrashLoopManualChannelStartHint(target?: {
  channelId: string;
  accountId?: string;
}): string {
  const params = JSON.stringify({
    channel: target?.channelId ?? "<id>",
    ...(target?.accountId ? { accountId: target.accountId } : {}),
  });
  const command = formatCliCommand("openclaw gateway call channels.start");
  return `Start a channel manually with: ${command} --params '${params}'`;
}

const gatewayLifecycleLog = createSubsystemLogger("gateway/lifecycle");

type GatewayBootLifecycleDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_boot_lifecycle">;

type GatewayBootLifecycleOutcome =
  | "clean_stop"
  | "planned_restart"
  | "safe_mode_stable"
  | "startup_failed"
  | "startup_failure_repaired"
  | "forced_stop";

export type GatewayBootLifecycleCompletion = {
  outcome: GatewayBootLifecycleOutcome;
  reason?: string;
  startupReason?: string;
};

export type GatewayCrashLoopBreakerDecision = {
  tripped: boolean;
  uncleanBoots: number;
  windowMs: number;
  shouldWriteStabilityBundle: boolean;
  recovered: boolean;
};

function buildGatewayCrashLoopBreakerDecision(params: {
  uncleanBoots: number;
  windowMs?: number;
  latestBreakerStartedAtMs?: number | null;
  latestRecoveryStartedAtMs?: number | null;
}): GatewayCrashLoopBreakerDecision {
  const windowMs = params.windowMs ?? GATEWAY_BOOT_LOOP_WINDOW_MS;
  const tripped = params.uncleanBoots >= GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD;
  const hasUnrecoveredBreakerMarker =
    typeof params.latestBreakerStartedAtMs === "number" &&
    (typeof params.latestRecoveryStartedAtMs !== "number" ||
      params.latestRecoveryStartedAtMs < params.latestBreakerStartedAtMs);
  // Recovery waits until the unclean window drains. A clean safe-mode boot
  // proves the control plane works, not that suppressed channel autostart is safe.
  return {
    tripped,
    uncleanBoots: params.uncleanBoots,
    windowMs,
    shouldWriteStabilityBundle: tripped && !hasUnrecoveredBreakerMarker,
    recovered: !tripped && hasUnrecoveredBreakerMarker,
  };
}

export function inspectGatewayCrashLoopBreaker(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): GatewayCrashLoopBreakerDecision {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
    const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;
    // Unclean means startup_failed by completion time, or an open boot row
    // whose process disappeared. forced_stop is operator shutdown pressure,
    // not a startup crash-loop signal.
    const uncleanRow = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("gateway_boot_lifecycle")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where((eb) =>
          eb.or([
            eb("startup_reason", "is", null),
            eb("startup_reason", "not in", maintenanceStartupReasons),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb.and([eb("completed_at_ms", "is", null), eb("started_at_ms", ">=", windowStartMs)]),
            eb.and([
              eb("outcome", "=", "startup_failed"),
              eb("completed_at_ms", ">=", windowStartMs),
            ]),
          ]),
        ),
    );
    const latestBreaker = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("gateway_boot_lifecycle")
        .select("started_at_ms as startedAtMs")
        .where("startup_reason", "=", GATEWAY_CRASH_LOOP_BREAKER_REASON)
        .orderBy("started_at_ms", "desc")
        .limit(1),
    );
    const latestRecovery = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("gateway_boot_lifecycle")
        .select("started_at_ms as startedAtMs")
        .where("startup_reason", "=", GATEWAY_CRASH_LOOP_RECOVERED_REASON)
        .orderBy("started_at_ms", "desc")
        .limit(1),
    );
    return buildGatewayCrashLoopBreakerDecision({
      uncleanBoots: uncleanRow?.count ?? 0,
      latestBreakerStartedAtMs: latestBreaker?.startedAtMs,
      latestRecoveryStartedAtMs: latestRecovery?.startedAtMs,
    });
  } catch (err) {
    gatewayLifecycleLog.warn(`crash-loop breaker state unavailable; fail-open: ${String(err)}`);
    return buildGatewayCrashLoopBreakerDecision({ uncleanBoots: 0 });
  }
}

export function recordGatewayBootStart(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  reason?: string,
): string | undefined {
  const bootId = randomUUID();
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("gateway_boot_lifecycle")
            .where("started_at_ms", "<", nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS),
        );
        executeSqliteQuerySync(
          db,
          kysely.insertInto("gateway_boot_lifecycle").values({
            boot_id: bootId,
            pid: process.pid,
            started_at_ms: nowMs,
            completed_at_ms: null,
            outcome: null,
            startup_reason: reason ?? null,
            reason: null,
          }),
        );
      },
      { env },
    );
    return bootId;
  } catch (err) {
    gatewayLifecycleLog.warn(`failed to persist gateway boot start; fail-open: ${String(err)}`);
    return undefined;
  }
}

/**
 * Split a stable safe-mode lifetime before channel autostart resumes. A fresh
 * open row makes a process death during recovered channel startup count toward
 * the next breaker decision instead of aging out with the original boot.
 */
export function recordGatewayCrashLoopRecovery(
  bootId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): string | undefined {
  const recoveredBootId = randomUUID();
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        if (bootId) {
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("gateway_boot_lifecycle")
              .set({
                completed_at_ms: nowMs,
                outcome: "safe_mode_stable",
                reason: null,
              })
              .where("boot_id", "=", bootId),
          );
        }
        executeSqliteQuerySync(
          db,
          kysely.insertInto("gateway_boot_lifecycle").values({
            boot_id: recoveredBootId,
            pid: process.pid,
            started_at_ms: nowMs,
            completed_at_ms: null,
            outcome: null,
            startup_reason: GATEWAY_CRASH_LOOP_RECOVERED_REASON,
            reason: null,
          }),
        );
      },
      { env },
    );
    return recoveredBootId;
  } catch (err) {
    gatewayLifecycleLog.warn(
      `failed to persist gateway crash-loop recovery; fail-safe: ${String(err)}`,
    );
    return undefined;
  }
}

export function completeGatewayBootLifecycle(
  bootId: string | undefined,
  completion: GatewayBootLifecycleCompletion,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): void {
  if (!bootId) {
    return;
  }
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("gateway_boot_lifecycle")
            .set({
              completed_at_ms: nowMs,
              outcome: completion.outcome,
              ...(completion.startupReason ? { startup_reason: completion.startupReason } : {}),
              reason: completion.reason ?? null,
            })
            .where("boot_id", "=", bootId),
        );
      },
      { env },
    );
  } catch (err) {
    gatewayLifecycleLog.warn(`failed to persist gateway boot outcome; fail-open: ${String(err)}`);
  }
}

export function repairGatewayMaintenanceStartupFailures(
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!pathMayExistSync(resolveOpenClawStateSqlitePath(env))) {
    return 0;
  }
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        const result = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("gateway_boot_lifecycle")
            .set({ outcome: "startup_failure_repaired" })
            .where("outcome", "=", "startup_failed")
            .where("startup_reason", "in", maintenanceStartupReasons),
        );
        return Number(result.numAffectedRows ?? 0);
      },
      { env },
    );
  } catch (err) {
    gatewayLifecycleLog.warn(
      `failed to repair maintenance startup history; fail-open: ${String(err)}`,
    );
    return 0;
  }
}
