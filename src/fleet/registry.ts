import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { allocateHostPort } from "./cell-profile.js";

export type FleetCellRecord = {
  tenantId: string;
  createdAtMs: number;
  image: string;
  runtime: "docker" | "podman";
  hostPort: number;
  containerName: string;
  dataDir: string;
};

export type ReserveFleetCellParams = Omit<FleetCellRecord, "hostPort"> & {
  requestedPort?: number;
};

type FleetCellsTable = OpenClawStateKyselyDatabase["fleet_cells"];
type FleetCellRow = Selectable<FleetCellsTable>;
type FleetRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "fleet_cells" | "state_leases">;

const FLEET_OPERATION_LEASE_SCOPE = "fleet-cell-operation";
const FLEET_OPERATION_LEASE_TTL_MS = 5 * 60_000;

export type FleetCellOperationLease = {
  heartbeat: (nowMs?: number) => void;
  release: () => void;
  owner: string;
};

export type FleetCellOperationName =
  | "create"
  | "start"
  | "stop"
  | "restart"
  | "upgrade"
  | "backup"
  | "restore"
  | "rm";

function kyselyFor(db: DatabaseSync) {
  return getNodeSqliteKysely<FleetRegistryDatabase>(db);
}

function parseRuntime(runtime: string): FleetCellRecord["runtime"] {
  if (runtime === "docker" || runtime === "podman") {
    return runtime;
  }
  throw new Error(`Unsupported fleet runtime in state database: ${runtime}`);
}

function rowToRecord(row: FleetCellRow): FleetCellRecord {
  return {
    tenantId: row.tenant_id,
    createdAtMs: row.created_at_ms,
    image: row.image,
    runtime: parseRuntime(row.runtime),
    hostPort: row.host_port,
    containerName: row.container_name,
    dataDir: row.data_dir,
  };
}

function recordToRow(record: FleetCellRecord): Insertable<FleetCellsTable> {
  return {
    tenant_id: record.tenantId,
    created_at_ms: record.createdAtMs,
    image: record.image,
    runtime: record.runtime,
    host_port: record.hostPort,
    container_name: record.containerName,
    data_dir: record.dataDir,
  };
}

export function listFleetCells(env: NodeJS.ProcessEnv = process.env): FleetCellRecord[] {
  const db = openOpenClawStateDatabase({ env }).db;
  const rows = executeSqliteQuerySync(
    db,
    kyselyFor(db).selectFrom("fleet_cells").selectAll().orderBy("tenant_id", "asc"),
  ).rows;
  return rows.map(rowToRecord);
}

export function getFleetCell(
  env: NodeJS.ProcessEnv,
  tenantId: string,
): FleetCellRecord | undefined {
  const db = openOpenClawStateDatabase({ env }).db;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kyselyFor(db).selectFrom("fleet_cells").selectAll().where("tenant_id", "=", tenantId),
  );
  return row ? rowToRecord(row) : undefined;
}

export function reserveFleetCell(
  env: NodeJS.ProcessEnv,
  params: ReserveFleetCellParams,
): FleetCellRecord {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("fleet_cells")
          .select("tenant_id")
          .where("tenant_id", "=", params.tenantId),
      );
      if (existing) {
        throw new Error(`Fleet cell already exists: ${params.tenantId}`);
      }

      const usedPorts = executeSqliteQuerySync(
        db,
        kysely.selectFrom("fleet_cells").select("host_port"),
      ).rows.map((row) => row.host_port);
      // Allocate and reserve under one write lock so concurrent creates cannot claim one port.
      const hostPort = allocateHostPort(usedPorts, params.requestedPort);
      const record: FleetCellRecord = {
        tenantId: params.tenantId,
        createdAtMs: params.createdAtMs,
        image: params.image,
        runtime: params.runtime,
        hostPort,
        containerName: params.containerName,
        dataDir: params.dataDir,
      };
      executeSqliteQuerySync(db, kysely.insertInto("fleet_cells").values(recordToRow(record)));
      return record;
    },
    { env },
  );
}

export function updateFleetCellImage(
  env: NodeJS.ProcessEnv,
  tenantId: string,
  image: string,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const result = executeSqliteQuerySync(
        db,
        kyselyFor(db).updateTable("fleet_cells").set({ image }).where("tenant_id", "=", tenantId),
      );
      if (result.numAffectedRows !== 1n) {
        throw new Error(`Fleet cell disappeared before its image could be updated: ${tenantId}`);
      }
    },
    { env },
  );
}

export function acquireFleetCellOperation(params: {
  env: NodeJS.ProcessEnv;
  tenantId: string;
  operation: FleetCellOperationName;
  owner?: string;
  nowMs?: number;
}): FleetCellOperationLease {
  const nowMs = params.nowMs ?? Date.now();
  const expiresAt = nowMs + FLEET_OPERATION_LEASE_TTL_MS;
  const owner = params.owner ?? crypto.randomUUID();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = kyselyFor(db);
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("state_leases")
          .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
          .where("lease_key", "=", params.tenantId)
          .where("expires_at", "<=", nowMs),
      );
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("state_leases")
          .select(["expires_at", "payload_json"])
          .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
          .where("lease_key", "=", params.tenantId),
      );
      if (existing) {
        let operation = "fleet operation";
        try {
          const payload: unknown = existing.payload_json
            ? JSON.parse(existing.payload_json)
            : undefined;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "operation" in payload &&
            typeof payload.operation === "string"
          ) {
            operation = `fleet ${payload.operation}`;
          }
        } catch {
          // Busy diagnostics are best-effort; lease ownership remains authoritative.
        }
        throw new Error(
          `Another ${operation} is already running for ${params.tenantId}; retry after ${new Date(existing.expires_at ?? expiresAt).toISOString()}.`,
        );
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("state_leases").values({
          scope: FLEET_OPERATION_LEASE_SCOPE,
          lease_key: params.tenantId,
          owner,
          expires_at: expiresAt,
          heartbeat_at: nowMs,
          payload_json: JSON.stringify({ operation: params.operation }),
          created_at: nowMs,
          updated_at: nowMs,
        }),
      );
    },
    { env: params.env },
  );

  return {
    owner,
    heartbeat: (heartbeatNowMs = Date.now()) => {
      const heartbeatExpiresAt = heartbeatNowMs + FLEET_OPERATION_LEASE_TTL_MS;
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const result = executeSqliteQuerySync(
            db,
            kyselyFor(db)
              .updateTable("state_leases")
              .set({
                expires_at: heartbeatExpiresAt,
                heartbeat_at: heartbeatNowMs,
                updated_at: heartbeatNowMs,
              })
              .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
              .where("lease_key", "=", params.tenantId)
              .where("owner", "=", owner)
              .where("expires_at", ">", heartbeatNowMs),
          );
          if (result.numAffectedRows !== 1n) {
            throw new Error(`Fleet operation lease was lost for ${params.tenantId}.`);
          }
        },
        { env: params.env },
      );
    },
    release: () => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            kyselyFor(db)
              .deleteFrom("state_leases")
              .where("scope", "=", FLEET_OPERATION_LEASE_SCOPE)
              .where("lease_key", "=", params.tenantId)
              .where("owner", "=", owner),
          );
        },
        { env: params.env },
      );
    },
  };
}

export function deleteFleetCell(env: NodeJS.ProcessEnv, tenantId: string): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        kyselyFor(db).deleteFrom("fleet_cells").where("tenant_id", "=", tenantId),
      );
    },
    { env },
  );
}
