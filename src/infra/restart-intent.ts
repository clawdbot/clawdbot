// Persists short-lived gateway restart intent for supervisor SIGTERM handoff.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const GATEWAY_RESTART_INTENT_KEY = "gateway-restart";
const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;

const restartLog = createSubsystemLogger("restart");
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

type GatewayRestartIntentPayload = {
  kind: "gateway-restart";
  pid: number;
  createdAt: number;
  reason?: string;
  force?: boolean;
  waitMs?: number;
};

export type GatewayRestartIntent = {
  reason?: string;
  force?: boolean;
  waitMs?: number;
};

function normalizeRestartIntentPid(pid: number | undefined): number | null {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function normalizeRestartIntentReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function writeGatewayRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  intent?: GatewayRestartIntent;
  reason?: string;
}): boolean {
  const targetPid = normalizeRestartIntentPid(opts.targetPid);
  if (targetPid === null) {
    return false;
  }
  const env = opts.env ?? process.env;
  try {
    const reason = normalizeRestartIntentReason(opts.reason ?? opts.intent?.reason);
    const waitMs =
      typeof opts.intent?.waitMs === "number" &&
      Number.isFinite(opts.intent.waitMs) &&
      opts.intent.waitMs >= 0
        ? Math.floor(opts.intent.waitMs)
        : null;
    const createdAt = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("gateway_restart_intent")
            .values({
              intent_key: GATEWAY_RESTART_INTENT_KEY,
              kind: "gateway-restart",
              pid: targetPid,
              created_at: createdAt,
              reason: reason ?? null,
              force: opts.intent?.force ? 1 : null,
              wait_ms: waitMs,
              updated_at_ms: createdAt,
            })
            .onConflict((conflict) =>
              conflict.column("intent_key").doUpdateSet({
                kind: (eb) => eb.ref("excluded.kind"),
                pid: (eb) => eb.ref("excluded.pid"),
                created_at: (eb) => eb.ref("excluded.created_at"),
                reason: (eb) => eb.ref("excluded.reason"),
                force: (eb) => eb.ref("excluded.force"),
                wait_ms: (eb) => eb.ref("excluded.wait_ms"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
              }),
            ),
        );
      },
      { env },
    );
    return true;
  } catch (err) {
    restartLog.warn(`failed to write gateway restart intent: ${String(err)}`);
    return false;
  }
}

export function clearGatewayRestartIntentSync(env: NodeJS.ProcessEnv = process.env): void {
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
        executeSqliteQuerySync(
          db,
          stateDb
            .deleteFrom("gateway_restart_intent")
            .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
        );
      },
      { env },
    );
  } catch {}
}

function readGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv,
): GatewayRestartIntentPayload | null {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
    const parsed = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("gateway_restart_intent")
        .select(["kind", "pid", "created_at", "reason", "force", "wait_ms"])
        .where("intent_key", "=", GATEWAY_RESTART_INTENT_KEY),
    );
    if (
      parsed?.kind === "gateway-restart" &&
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      typeof parsed.created_at === "number" &&
      Number.isFinite(parsed.created_at) &&
      (parsed.reason === null || typeof parsed.reason === "string") &&
      (parsed.force === null ||
        (typeof parsed.force === "number" && Number.isFinite(parsed.force))) &&
      (parsed.wait_ms === null ||
        (typeof parsed.wait_ms === "number" &&
          Number.isFinite(parsed.wait_ms) &&
          parsed.wait_ms >= 0))
    ) {
      const reason = normalizeRestartIntentReason(parsed.reason ?? undefined);
      return {
        kind: "gateway-restart",
        pid: parsed.pid,
        createdAt: parsed.created_at,
        ...(reason ? { reason } : {}),
        ...(parsed.force ? { force: true } : {}),
        ...(typeof parsed.wait_ms === "number" ? { waitMs: Math.floor(parsed.wait_ms) } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function consumeGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): GatewayRestartIntent | null {
  const payload = readGatewayRestartIntentPayloadSync(env);
  clearGatewayRestartIntentSync(env);
  if (!payload) {
    return null;
  }
  if (payload.pid !== process.pid) {
    return null;
  }
  const ageMs = now - payload.createdAt;
  if (ageMs < 0 || ageMs > GATEWAY_RESTART_INTENT_TTL_MS) {
    return null;
  }
  return {
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(payload.force ? { force: true } : {}),
    ...(typeof payload.waitMs === "number" ? { waitMs: payload.waitMs } : {}),
  };
}

export function consumeGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  return consumeGatewayRestartIntentPayloadSync(env, now) !== null;
}
