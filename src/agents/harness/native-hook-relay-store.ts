import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";

export type NativeHookRelayBridgeRecord = {
  relayId: string;
  pid: number;
  hostname: "127.0.0.1";
  port: number;
  token: string;
  expiresAtMs: number;
};

type NativeHookRelayBridgePruneResult = {
  relayId: string;
  pid: number;
  reason: "dead-pid" | "expired";
};

type NativeHookRelayBridgeDatabase = Pick<OpenClawStateKyselyDatabase, "native_hook_relay_bridges">;

type NativeHookRelayBridgeRow = OpenClawStateKyselyDatabase["native_hook_relay_bridges"];

type NativeHookRelayBridgeSnapshot = {
  record: NativeHookRelayBridgeRecord;
  updatedAtMs: number;
};

type NativeHookRelayBridgePruneCandidate = {
  snapshot: NativeHookRelayBridgeSnapshot;
  reason: NativeHookRelayBridgePruneResult["reason"];
};

type NativeHookRelayBridgeStoreOptions = {
  stateDbPath?: string;
};

function readNativeHookRelayBridgeSnapshot(
  row: NativeHookRelayBridgeRow | undefined,
): NativeHookRelayBridgeSnapshot | undefined {
  if (
    !row ||
    typeof row.relay_id !== "string" ||
    row.relay_id.length === 0 ||
    !Number.isSafeInteger(row.pid) ||
    row.hostname !== "127.0.0.1" ||
    !Number.isSafeInteger(row.port) ||
    row.port <= 0 ||
    row.port > 65_535 ||
    typeof row.token !== "string" ||
    row.token.length === 0 ||
    !Number.isSafeInteger(row.expires_at_ms) ||
    !Number.isSafeInteger(row.updated_at_ms)
  ) {
    return undefined;
  }
  const { token } = row;
  return {
    record: {
      relayId: row.relay_id,
      pid: row.pid,
      hostname: row.hostname,
      port: row.port,
      token,
      expiresAtMs: row.expires_at_ms,
    },
    updatedAtMs: row.updated_at_ms,
  };
}

function readNativeHookRelayBridgeSnapshotFromDatabase(params: {
  database: { db: DatabaseSync };
  relayId: string;
}): NativeHookRelayBridgeSnapshot | undefined {
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(params.database.db);
  return readNativeHookRelayBridgeSnapshot(
    executeSqliteQueryTakeFirstSync(
      params.database.db,
      db.selectFrom("native_hook_relay_bridges").selectAll().where("relay_id", "=", params.relayId),
    ),
  );
}

function sameNativeHookRelayBridgeSnapshot(
  left: NativeHookRelayBridgeSnapshot,
  right: NativeHookRelayBridgeSnapshot,
): boolean {
  return (
    left.updatedAtMs === right.updatedAtMs &&
    left.record.relayId === right.record.relayId &&
    left.record.pid === right.record.pid &&
    left.record.hostname === right.record.hostname &&
    left.record.port === right.record.port &&
    left.record.token === right.record.token &&
    left.record.expiresAtMs === right.record.expiresAtMs
  );
}

export function readNativeHookRelayBridgeRecord(
  params: { relayId: string } & NativeHookRelayBridgeStoreOptions,
): NativeHookRelayBridgeRecord | undefined {
  return withOpenClawStateDatabaseReadOnly(
    (database) =>
      readNativeHookRelayBridgeSnapshotFromDatabase({
        database,
        relayId: params.relayId,
      })?.record,
    { path: params.stateDbPath },
  );
}

export function writeNativeHookRelayBridgeRecord(
  params: {
    record: NativeHookRelayBridgeRecord;
    updatedAtMs?: number;
  } & NativeHookRelayBridgeStoreOptions,
): void {
  const updatedAtMs = params.updatedAtMs ?? Date.now();
  const record = params.record;
  const { token } = record;
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("native_hook_relay_bridges")
          .values({
            relay_id: record.relayId,
            pid: record.pid,
            hostname: record.hostname,
            port: record.port,
            token,
            expires_at_ms: record.expiresAtMs,
            updated_at_ms: updatedAtMs,
          })
          .onConflict((conflict) =>
            conflict.column("relay_id").doUpdateSet({
              pid: record.pid,
              hostname: record.hostname,
              port: record.port,
              token,
              expires_at_ms: record.expiresAtMs,
              updated_at_ms: updatedAtMs,
            }),
          ),
      );
    },
    { path: params.stateDbPath },
  );
}

export function renewOrRestoreNativeHookRelayBridgeRecord(
  params: {
    record: NativeHookRelayBridgeRecord;
    updatedAtMs?: number;
  } & NativeHookRelayBridgeStoreOptions,
): boolean {
  const { record } = params;
  const { token } = record;
  const updatedAtMs = params.updatedAtMs ?? Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
      const current = readNativeHookRelayBridgeSnapshotFromDatabase({
        database,
        relayId: record.relayId,
      });
      if (!current) {
        const result = executeSqliteQuerySync(
          database.db,
          db
            .insertInto("native_hook_relay_bridges")
            .values({
              relay_id: record.relayId,
              pid: record.pid,
              hostname: record.hostname,
              port: record.port,
              token,
              expires_at_ms: record.expiresAtMs,
              updated_at_ms: updatedAtMs,
            })
            .onConflict((conflict) => conflict.column("relay_id").doNothing()),
        );
        return result.numAffectedRows === 1n;
      }
      if (current.record.pid !== record.pid || current.record.token !== token) {
        return false;
      }
      const result = executeSqliteQuerySync(
        database.db,
        db
          .updateTable("native_hook_relay_bridges")
          .set({
            hostname: record.hostname,
            port: record.port,
            expires_at_ms: record.expiresAtMs,
            updated_at_ms: updatedAtMs,
          })
          .where("relay_id", "=", record.relayId)
          .where("pid", "=", record.pid)
          .where("token", "=", token)
          .where("updated_at_ms", "=", current.updatedAtMs),
      );
      return result.numAffectedRows === 1n;
    },
    { path: params.stateDbPath },
  );
}

export function deleteNativeHookRelayBridgeRecordIfOwned(params: {
  relayId: string;
  pid: number;
  token: string;
  stateDbPath?: string;
}): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const current = readNativeHookRelayBridgeSnapshotFromDatabase({
        database,
        relayId: params.relayId,
      });
      if (!current || current.record.pid !== params.pid || current.record.token !== params.token) {
        return false;
      }
      const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
      const result = executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("native_hook_relay_bridges")
          .where("relay_id", "=", params.relayId)
          .where("pid", "=", params.pid)
          .where("token", "=", params.token)
          .where("updated_at_ms", "=", current.updatedAtMs),
      );
      return result.numAffectedRows === 1n;
    },
    { path: params.stateDbPath },
  );
}

export function pruneNativeHookRelayBridgeRecords(params: {
  currentPid: number;
  isPidDead: (pid: number) => boolean;
  nowMs?: number;
  stateDbPath?: string;
}): NativeHookRelayBridgePruneResult[] {
  const nowMs = params.nowMs ?? Date.now();
  const database = openOpenClawStateDatabase({ path: params.stateDbPath });
  const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
  const snapshots = executeSqliteQuerySync(
    database.db,
    db.selectFrom("native_hook_relay_bridges").selectAll(),
  ).rows.flatMap((row) => {
    const snapshot = readNativeHookRelayBridgeSnapshot(row);
    return snapshot ? [snapshot] : [];
  });
  const candidates: NativeHookRelayBridgePruneCandidate[] = [];
  for (const snapshot of snapshots) {
    if (nowMs > snapshot.record.expiresAtMs) {
      candidates.push({ snapshot, reason: "expired" });
      continue;
    }
    if (snapshot.record.pid !== params.currentPid && params.isPidDead(snapshot.record.pid)) {
      candidates.push({ snapshot, reason: "dead-pid" });
    }
  }
  if (candidates.length === 0) {
    return [];
  }

  return runOpenClawStateWriteTransaction(
    (writeDatabase) => {
      const writeDb = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(writeDatabase.db);
      const pruned: NativeHookRelayBridgePruneResult[] = [];
      for (const candidate of candidates) {
        const current = readNativeHookRelayBridgeSnapshotFromDatabase({
          database: writeDatabase,
          relayId: candidate.snapshot.record.relayId,
        });
        if (
          !current ||
          !sameNativeHookRelayBridgeSnapshot(current, candidate.snapshot) ||
          (candidate.reason === "expired" && nowMs <= current.record.expiresAtMs)
        ) {
          continue;
        }
        const result = executeSqliteQuerySync(
          writeDatabase.db,
          writeDb
            .deleteFrom("native_hook_relay_bridges")
            .where("relay_id", "=", current.record.relayId)
            .where("token", "=", current.record.token)
            .where("updated_at_ms", "=", current.updatedAtMs),
        );
        if (result.numAffectedRows === 1n) {
          pruned.push({
            relayId: current.record.relayId,
            pid: current.record.pid,
            reason: candidate.reason,
          });
        }
      }
      return pruned;
    },
    { path: params.stateDbPath },
  );
}

export function clearNativeHookRelayBridgeRecordsForTests(
  options: NativeHookRelayBridgeStoreOptions = {},
): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(database.db);
      executeSqliteQuerySync(database.db, db.deleteFrom("native_hook_relay_bridges"));
    },
    { path: options.stateDbPath },
  );
}
import type { DatabaseSync } from "node:sqlite";
