import type { DatabaseSync } from "node:sqlite";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  resolveDatabasePath,
} from "./openclaw-state-db-maintenance.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  inspectOpenClawStateOwnershipFromDatabase,
  normalizeOpenClawStateManagerId,
  OpenClawStateOwnershipMetadataError,
  STATE_SUPERVISION_KEY,
  type OpenClawExternalStateOwnership,
  runWithOpenClawStateOwnershipCoordinator,
} from "./openclaw-state-ownership.js";

type OpenClawStateOwnershipOptions = Omit<OpenClawStateDatabaseOptions, "database" | "readOnly">;
type OwnershipDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

function requireOwnershipCheckpoint(
  walMaintenance: SqliteWalMaintenance,
  databasePath: string,
): void {
  if (!walMaintenance.checkpoint()) {
    throw new Error(
      `External ownership was committed for ${databasePath}, but its WAL checkpoint failed. Retry the same ownership claim before activating the supervisor.`,
    );
  }
}

function claimOwnershipRow(
  database: DatabaseSync,
  databasePath: string,
  managerId: string,
  repairMalformed: boolean,
): OpenClawExternalStateOwnership {
  let current: OpenClawExternalStateOwnership | null = null;
  try {
    current = inspectOpenClawStateOwnershipFromDatabase(database, databasePath);
  } catch (error) {
    if (!repairMalformed || !(error instanceof OpenClawStateOwnershipMetadataError)) {
      throw error;
    }
  }
  if (current) {
    if (current.managerId !== managerId) {
      throw new Error(
        `OpenClaw shared state is already claimed by external manager ${current.managerId}; ` +
          `manager ${managerId} cannot replace that durable ownership.`,
      );
    }
    return current;
  }
  const ownership: OpenClawExternalStateOwnership = {
    version: 1,
    mode: "external",
    managerId,
    claimedAt: Date.now(),
  };
  const valueJson = JSON.stringify(ownership);
  const stateDb = getNodeSqliteKysely<OwnershipDatabase>(database);
  executeSqliteQuerySync(
    database,
    stateDb
      .insertInto("config_machine_state")
      .values({
        state_key: STATE_SUPERVISION_KEY,
        value_json: valueJson,
        updated_at_ms: ownership.claimedAt,
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet({
          value_json: valueJson,
          updated_at_ms: ownership.claimedAt,
        }),
      ),
  );
  return ownership;
}

function repairMalformedOwnershipClaim(
  databasePath: string,
  managerId: string,
): OpenClawExternalStateOwnership {
  return runWithOpenClawStateOwnershipCoordinator(
    databasePath,
    "malformed state ownership repair/checkpoint",
    () => {
      const database = openNodeSqliteDatabase(databasePath);
      let walMaintenance: SqliteWalMaintenance | undefined;
      try {
        database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
        assertSqliteIntegrity(database, databasePath);
        assertOpenClawStateDatabaseForMaintenance(database, { pathname: databasePath });
        walMaintenance = configureSqliteWalMaintenance(database, {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          checkpointIntervalMs: 0,
          checkpointMode: "TRUNCATE",
          databaseLabel: "OpenClaw shared state ownership",
          databasePath,
        });
        const ownership = runSqliteImmediateTransactionSync(
          database,
          () => {
            assertOpenClawStateDatabaseForMaintenance(database, { pathname: databasePath });
            return claimOwnershipRow(database, databasePath, managerId, true);
          },
          {
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: databasePath,
            operationLabel: "state.ownership.repair",
          },
        );
        requireOwnershipCheckpoint(walMaintenance, databasePath);
        return ownership;
      } finally {
        walMaintenance?.close({ checkpointMode: "PASSIVE" });
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      }
    },
  );
}

/** Claim durable shared-state write ownership for the active external supervisor. */
export function claimOpenClawStateOwnership(
  managerId: string,
  options: OpenClawStateOwnershipOptions = {},
): OpenClawExternalStateOwnership {
  const env = options.env ?? process.env;
  if (!isGatewayExternallySupervised(env)) {
    throw new Error(
      "Claiming external shared-state ownership requires OPENCLAW_SUPERVISOR_MODE=external.",
    );
  }
  const normalizedManagerId = normalizeOpenClawStateManagerId(managerId);
  try {
    const database = openOpenClawStateDatabase(options);
    return runWithOpenClawStateOwnershipCoordinator(
      database.path,
      "state ownership claim/checkpoint",
      () => {
        const ownership = runOpenClawStateWriteTransaction(
          ({ db, path: databasePath }) =>
            claimOwnershipRow(db, databasePath, normalizedManagerId, false),
          { ...options, database },
          { operationLabel: "state.ownership.claim" },
        );
        requireOwnershipCheckpoint(database.walMaintenance, database.path);
        return ownership;
      },
    );
  } catch (error) {
    if (!(error instanceof OpenClawStateOwnershipMetadataError)) {
      throw error;
    }
    const ownership = repairMalformedOwnershipClaim(
      resolveDatabasePath(options),
      normalizedManagerId,
    );
    openOpenClawStateDatabase(options);
    return ownership;
  }
}
