import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { acquireOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

type GatewayStartupLeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;

export type GatewayStartupProgressExpectation = {
  pid: number;
  processStartTime: number;
  requestedAtMs: number;
};

const GATEWAY_STARTUP_PROGRESS_SCOPE = "gateway.startup";
const GATEWAY_STARTUP_PROGRESS_KEY = "current";
const GATEWAY_STARTUP_PROGRESS_LEASE_MS = 15_000;

/** Publish renewable evidence while the gateway loop is actively starting. */
export async function withGatewayStartupProgress<T>(
  run: () => Promise<T>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T> {
  const processStartTime = getFileLockProcessStartTime(process.pid);
  const lease = await acquireOpenClawStateLease({
    scope: GATEWAY_STARTUP_PROGRESS_SCOPE,
    key: GATEWAY_STARTUP_PROGRESS_KEY,
    database: { scope: "shared", options },
    leaseMs: GATEWAY_STARTUP_PROGRESS_LEASE_MS,
    waitMs: 0,
    leaseLabel: "gateway startup progress lease",
    operationLabel: "gateway.startup-progress.lease",
    processOwner: {
      pid: process.pid,
      startTime: processStartTime,
      isAlive: isPidAlive,
      readStartTime: getFileLockProcessStartTime,
    },
  }).catch(() => undefined);

  try {
    return await run();
  } finally {
    await lease?.release().catch(() => undefined);
  }
}

/** Read only renewed, unexpired progress from the exact process that was signaled. */
export function hasFreshGatewayStartupProgress(
  expectation: GatewayStartupProgressExpectation,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): boolean {
  try {
    const nowMs = options.nowMs ?? Date.now();
    const database = openOpenClawStateDatabase(options).db;
    const row = executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<GatewayStartupLeaseDatabase>(database)
        .selectFrom("state_leases")
        .select(["expires_at", "heartbeat_at", "payload_json", "created_at"])
        .where("scope", "=", GATEWAY_STARTUP_PROGRESS_SCOPE)
        .where("lease_key", "=", GATEWAY_STARTUP_PROGRESS_KEY),
    );
    if (
      !row ||
      row.expires_at === null ||
      row.expires_at <= nowMs ||
      row.heartbeat_at === null ||
      row.heartbeat_at <= row.created_at ||
      row.heartbeat_at > nowMs ||
      nowMs - row.heartbeat_at > GATEWAY_STARTUP_PROGRESS_LEASE_MS ||
      row.created_at < expectation.requestedAtMs ||
      !row.payload_json
    ) {
      return false;
    }

    const payload: unknown = JSON.parse(row.payload_json);
    if (
      !isRecord(payload) ||
      payload.pid !== expectation.pid ||
      payload.starttime !== expectation.processStartTime
    ) {
      return false;
    }

    return (
      isPidAlive(expectation.pid) &&
      getFileLockProcessStartTime(expectation.pid) === expectation.processStartTime
    );
  } catch {
    return false;
  }
}
